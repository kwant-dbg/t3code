import { type Editor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { type EditorState, NodeSelection, Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

import { markUndoSession } from "~/composer-undo-grouping";
import { isMacPlatform } from "~/lib/utils";
import { hasCommandForKeyDown } from "~/shortcuts/dispatcher";
import { VimController } from "./controller";
import type { VimMode } from "./engine";
import { type VimClipboard, vimLineIndex, vimPluginKey, vimStateField } from "./proseMirrorBuffer";

export interface ComposerVimOptions {
  /** Typing `jk` quickly in Insert acts as Esc. */
  jkEscape: boolean;
  /** Enter from Normal; true when the composer sent or otherwise used it. */
  onEnter(event: KeyboardEvent): boolean;
  /** `k` on the first screen line and `j` on the last, as ArrowUp and ArrowDown. */
  onHistory(direction: 1 | -1, event: KeyboardEvent): void;
  /** Writes yanked text; returns extra flavors, such as context chips, to paste back with it. */
  copy(text: string): Readonly<Record<string, string>> | undefined;
  readClipboardText(): Promise<string | null>;
  parseMarkdown(value: string): ProseMirrorNode | null;
}

interface ComposerVimStorage {
  vim: ComposerVim | null;
  /** Start time of the undo step an Insert session or a paste is building. */
  undoSession: number | null;
  /** The session's first edit starts its undo step, so it never joins the command before. */
  undoSessionOpened: boolean;
}

declare module "@tiptap/core" {
  interface Storage {
    "composer-vim": ComposerVimStorage;
  }
}

/** Vim's default `timeoutlen`, the usual window for an `inoremap jk <Esc>`. */
const JK_TIMEOUT_MS = 1000;

const NAMED_KEYS: Record<string, string> = {
  Escape: "<Esc>",
  Backspace: "<BS>",
  Delete: "<Del>",
  ArrowLeft: "<Left>",
  ArrowRight: "<Right>",
  ArrowUp: "<Up>",
  ArrowDown: "<Down>",
  Home: "<Home>",
  End: "<End>",
};

function vimKey(event: KeyboardEvent): string | null {
  const named = NAMED_KEYS[event.key];
  if (named) return named;
  return [...event.key].length === 1 ? event.key : null;
}

/** Esc, or ctrl+[ which terminals send as Esc. */
function isEscapeKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.altKey || event.shiftKey) return false;
  return event.ctrlKey ? event.key === "[" || event.code === "BracketLeft" : event.key === "Escape";
}

function cursorDecorations(state: EditorState): DecorationSet {
  const vim = vimPluginKey.getState(state);
  if (!vim || vim.mode === "insert") return DecorationSet.empty;
  const { selection, doc } = state;
  const head =
    vim.visual?.head ?? (selection instanceof NodeSelection ? selection.from : selection.head);
  const $head = doc.resolve(Math.min(head, doc.content.size));
  const after = $head.parent.isTextblock ? $head.nodeAfter : null;
  let decoration: Decoration;
  if (after?.isText && after.text && !after.text.startsWith("\n")) {
    const width = (after.text.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
    decoration = Decoration.inline(head, head + width, { class: "composer-vim-cursor" });
  } else if (after && !after.isText) {
    decoration = Decoration.node(head, head + after.nodeSize, {
      class: "composer-vim-cursor-chip",
    });
  } else {
    decoration = Decoration.widget(
      head,
      () => {
        const span = document.createElement("span");
        span.className = "composer-vim-cursor-eol";
        return span;
      },
      { side: 1, key: "composer-vim-cursor" },
    );
  }
  return DecorationSet.create(doc, [decoration]);
}

/**
 * Vim in the composer. Inert until `attachComposerVim` gives it a controller, so the
 * setting's off state is the editor's own behaviour.
 */
export const ComposerVimExtension = Extension.create<Record<string, never>, ComposerVimStorage>({
  name: "composer-vim",
  // Ahead of undo grouping, which reads the session stamp.
  priority: 101,
  addStorage() {
    return { vim: null, undoSession: null, undoSessionOpened: false };
  },
  dispatchTransaction({ transaction, next }) {
    const { storage } = this;
    if (storage.undoSession !== null && transaction.docChanged) {
      if (!storage.undoSessionOpened) closeHistory(transaction);
      storage.undoSessionOpened = true;
      markUndoSession(transaction, storage.undoSession);
    }
    next(transaction);
  },
  addProseMirrorPlugins() {
    const storage = this.storage;
    return [
      new Plugin({
        key: vimPluginKey,
        state: vimStateField,
        props: {
          decorations: cursorDecorations,
          attributes: (state): Record<string, string> => {
            const mode = vimPluginKey.getState(state)?.mode;
            return storage.vim && mode ? { "data-vim-mode": mode } : {};
          },
          handleDOMEvents: {
            focus: () => {
              storage.vim?.enterInsert();
              return false;
            },
          },
        },
        view: () => ({
          update: (view, previous) => {
            const vim = storage.vim;
            if (
              !vim ||
              vim.mode === "insert" ||
              vim.dispatching ||
              view.state.doc === previous.doc
            ) {
              return;
            }
            // Sending or clearing the prompt starts the next one in Insert.
            const { lines } = vimLineIndex(view.state.doc);
            if (lines.length === 1 && lines[0] === "") queueMicrotask(() => vim.enterInsert());
          },
        }),
      }),
    ];
  },
});

export class ComposerVim {
  readonly #editor: Editor;
  readonly #options: () => ComposerVimOptions;
  readonly #storage: ComposerVimStorage;
  readonly #controller: VimController;
  #event: KeyboardEvent | null = null;
  /** When Insert last typed a `j`, which a quick `k` turns into Esc. Any other key clears it. */
  #typedJAt: number | null = null;
  #goalX: number | null = null;
  #lastYank: (VimClipboard & { flavors?: Readonly<Record<string, string>> }) | null = null;
  #pasteFlavors: Readonly<Record<string, string>> | undefined;
  dispatching = false;

  constructor(editor: Editor, options: () => ComposerVimOptions) {
    this.#editor = editor;
    this.#options = options;
    this.#storage = editor.storage["composer-vim"];
    this.#controller = new VimController({
      getState: () => editor.state,
      dispatch: (tr) => {
        this.dispatching = true;
        try {
          editor.view.dispatch(tr);
        } finally {
          this.dispatching = false;
        }
      },
      screenLine: (pos, direction, count, keepGoal) =>
        this.#screenLine(editor.view, pos, direction, count, keepGoal),
      history: (direction) => {
        if (this.#event) this.#options().onHistory(direction, this.#event);
      },
      writeClipboard: (clipboard) => {
        const flavors = this.#options().copy(clipboard.text);
        this.#lastYank = flavors ? { ...clipboard, flavors } : clipboard;
      },
      readClipboard: () => this.#readClipboard(),
      insertMarkdown: (text) => this.#insertMarkdown(text),
      parseMarkdown: (value) => this.#options().parseMarkdown(value),
      beginUndoSession: () => {
        if (this.#storage.undoSession !== null) return;
        this.#storage.undoSession = Date.now();
        this.#storage.undoSessionOpened = false;
      },
      endUndoSession: () => {
        this.#storage.undoSession = null;
      },
    });
  }

  get mode(): VimMode {
    return this.#controller.mode;
  }

  subscribe(listener: () => void): () => void {
    return this.#controller.subscribe(listener);
  }

  enterInsert(): void {
    if (this.#controller.mode !== "insert") this.#controller.enterInsert();
  }

  /**
   * Keys in Normal and Visual. True means the editor must not handle the key; the event is
   * left unprevented when an app shortcut should still run.
   */
  handleKeyDown(event: KeyboardEvent): boolean {
    if (!this.#ownsKey(event)) return false;
    if (this.#controller.mode === "insert") return this.#jkEscape(event);
    const consume = () => {
      event.preventDefault();
      event.stopPropagation();
      return true;
    };
    if (this.#controller.holding) {
      const key = vimKey(event);
      if (key) this.#controller.feed(key);
      return consume();
    }
    this.#event = event;
    try {
      if (isEscapeKey(event)) {
        // Off macOS, Ctrl+[ is the app's back shortcut by default.
        if (event.ctrlKey && hasCommandForKeyDown(event)) return true;
        this.#controller.feed("<Esc>");
        return consume();
      }
      if (event.key === "Enter") {
        if (this.#controller.mode !== "normal") this.#controller.feed("<Esc>");
        if (this.#options().onEnter(event)) return consume();
        const plain = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
        if (plain) this.#controller.feed("<CR>");
        return consume();
      }
      const ctrlOnly = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
      if (ctrlOnly && event.key.toLowerCase() === "r") {
        if (hasCommandForKeyDown(event)) return true;
        this.#controller.feed("<C-r>");
        return consume();
      }
      // Cmd shortcuts (Ctrl off macOS) keep their editor and app meaning: copy, paste, undo.
      if (isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey) return false;
      if (event.ctrlKey || event.altKey || event.metaKey) {
        // Skip the editor's keymaps without preventing default, so a bound app command runs.
        return hasCommandForKeyDown(event) ? true : consume();
      }
      // Tab leaves the composer, as it would from any control that is not typing.
      if (event.key === "Tab") return true;
      const key = vimKey(event);
      if (key === null) return false;
      this.#controller.feed(key);
      return consume();
    } finally {
      this.#event = null;
    }
  }

  /**
   * The `j` is typed as usual, so typing never waits on a mapping. A `k` right after it
   * removes it, outside undo history, and leaves Insert as Esc would.
   */
  #jkEscape(event: KeyboardEvent): boolean {
    const typedJAt = this.#typedJAt;
    this.#typedJAt = null;
    if (!this.#options().jkEscape || event.ctrlKey || event.metaKey || event.altKey) return false;
    const { selection, doc } = this.#editor.state;
    if (!selection.empty) return false;
    const now = Date.now();
    if (event.key === "j") {
      this.#typedJAt = now;
      return false;
    }
    const completes =
      event.key === "k" &&
      typedJAt !== null &&
      now - typedJAt <= JK_TIMEOUT_MS &&
      doc.textBetween(selection.head - 1, selection.head) === "j";
    if (!completes) return false;
    this.#controller.escapeAfterTyping("j");
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  /** Esc in Insert that no menu or suggestion claimed. */
  escapeInsert(event: KeyboardEvent): boolean {
    if (this.#controller.mode !== "insert" || !this.#ownsKey(event)) return false;
    if (!isEscapeKey(event) || (event.ctrlKey && hasCommandForKeyDown(event))) return false;
    this.#controller.escape();
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  /** Not mid-composition, not in a field inside a chip, and not while the composer is read-only. */
  #ownsKey(event: KeyboardEvent): boolean {
    const { view } = this.#editor;
    return (
      !event.isComposing && event.keyCode !== 229 && event.target === view.dom && view.editable
    );
  }

  detach(): void {
    this.#storage.vim = null;
    this.#storage.undoSession = null;
    const { view } = this.#editor;
    if (!view.isDestroyed)
      view.dispatch(view.state.tr.setMeta(vimPluginKey, { mode: "insert", visual: null }));
  }

  async #readClipboard(): Promise<VimClipboard | null> {
    let text: string | null = null;
    try {
      text = await this.#options().readClipboardText();
    } catch {
      text = null;
    }
    const yank = this.#lastYank;
    // Text this composer yanked keeps its linewise flag and its context chips.
    if (yank && (text === null || text === yank.text)) {
      this.#pasteFlavors = yank.flavors;
      return yank;
    }
    this.#pasteFlavors = undefined;
    return text === null ? null : { text, linewise: text.endsWith("\n") };
  }

  /** Sends text through the editor's own paste handling, so chips and blocks come back. */
  #insertMarkdown(text: string): void {
    const { view } = this.#editor;
    const data = new DataTransfer();
    data.setData("text/plain", text);
    for (const [type, value] of Object.entries(this.#pasteFlavors ?? {})) data.setData(type, value);
    const event = new ClipboardEvent("paste", {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    if (event.clipboardData) {
      view.dom.dispatchEvent(event);
      return;
    }
    view.dispatch(view.state.tr.insertText(text));
  }

  /** Screen lines from the browser's own line movement, keeping the column `j` and `k` started on. */
  #screenLine(
    view: EditorView,
    pos: number,
    direction: 1 | -1,
    count: number,
    keepGoal: boolean,
  ): number | null {
    const selection = view.dom.ownerDocument.getSelection();
    if (!selection || typeof selection.modify !== "function") return null;
    let current = pos;
    let rect = view.coordsAtPos(current);
    if (!keepGoal || this.#goalX === null) this.#goalX = rect.left;
    let moved = false;
    for (let step = 0; step < count; step += 1) {
      const { node, offset } = view.domAtPos(current);
      selection.collapse(node, offset);
      selection.modify("move", direction === 1 ? "forward" : "backward", "line");
      if (!selection.focusNode || !view.dom.contains(selection.focusNode)) break;
      const next = view.posAtDOM(selection.focusNode, selection.focusOffset);
      const nextRect = view.coordsAtPos(next);
      // On the last line the browser moves to the line's end instead of failing.
      if (next === current || Math.abs(nextRect.top - rect.top) < (rect.bottom - rect.top) / 2)
        break;
      current = next;
      rect = nextRect;
      moved = true;
    }
    if (!moved) return null;
    const target = view.posAtCoords({ left: this.#goalX, top: (rect.top + rect.bottom) / 2 });
    return target?.pos ?? current;
  }
}

/** Starts vim on an editor built with `ComposerVimExtension`; `detach` turns it off. */
export function attachComposerVim(editor: Editor, options: () => ComposerVimOptions): ComposerVim {
  const vim = new ComposerVim(editor, options);
  editor.storage["composer-vim"].vim = vim;
  editor.view.dispatch(editor.state.tr.setMeta(vimPluginKey, { mode: "insert", visual: null }));
  return vim;
}
