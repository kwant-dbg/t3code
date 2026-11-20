import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, NodeSelection, Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

import { hasCommandForKeyDown } from "~/shortcuts/dispatcher";
import type { Slice } from "@tiptap/pm/model";

import { VimController } from "./controller";
import type { VimMode, VimYank } from "./engine";
import { isComposing, isEscapeKey, routeVimKey, vimKey } from "./keys";
import { ProseMirrorVimBuffer, vimLineIndex, vimStateField } from "./proseMirrorBuffer";
import { vimPluginKey } from "./vimState";

export interface ComposerVimCallbacks {
  /** Enter from Normal; true when the composer sent or otherwise used it. */
  onEnter(event: KeyboardEvent): boolean;
  /** `k` on the first screen line and `j` on the last, as ArrowUp and ArrowDown. */
  onHistory(direction: 1 | -1, event: KeyboardEvent): void;
  /** Extra clipboard flavors for serialized text, such as its context chips. */
  flavors(text: string): Readonly<Record<string, string>> | undefined;
  writeClipboard(yank: VimYank): void;
  readClipboardText(): Promise<string | null>;
  parseMarkdown(value: string): ProseMirrorNode | null;
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

function composerVimPlugin(vim: ComposerVim): Plugin {
  return new Plugin({
    key: vimPluginKey,
    state: vimStateField,
    props: {
      decorations: cursorDecorations,
      attributes: (state): Record<string, string> => {
        const mode = vimPluginKey.getState(state)?.mode;
        return mode ? { "data-vim-mode": mode } : {};
      },
      handleDOMEvents: {
        focus: () => {
          vim.enterInsert();
          return false;
        },
      },
    },
    view: () => ({
      update: (view, previous) => {
        if (vim.mode === "insert" || vim.dispatching || view.state.doc === previous.doc) return;
        // Sending or clearing the prompt starts the next one in Insert.
        const { lines } = vimLineIndex(view.state.doc);
        if (lines.length === 1 && lines[0] === "") queueMicrotask(() => vim.enterInsert());
      },
    }),
  });
}

export class ComposerVim {
  readonly #editor: Editor;
  readonly #callbacks: () => ComposerVimCallbacks;
  readonly #controller: VimController<Slice>;
  #event: KeyboardEvent | null = null;
  #goalX: number | null = null;
  dispatching = false;

  constructor(editor: Editor, callbacks: () => ComposerVimCallbacks) {
    this.#editor = editor;
    this.#callbacks = callbacks;
    const undoGrouping = editor.storage["composer-undo-grouping"];
    this.#controller = new VimController(
      (holdKeys) =>
        new ProseMirrorVimBuffer({
          holdKeys,
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
            if (this.#event) this.#callbacks().onHistory(direction, this.#event);
          },
          flavors: (text) => this.#callbacks().flavors(text),
          writeClipboard: (yank) => this.#callbacks().writeClipboard(yank),
          readClipboardText: async () => {
            try {
              return await this.#callbacks().readClipboardText();
            } catch {
              return null;
            }
          },
          insertMarkdown: (text, flavors) => this.#insertMarkdown(text, flavors),
          parseMarkdown: (value) => this.#callbacks().parseMarkdown(value),
          beginUndoSession: () => {
            undoGrouping.session ??= { startedAt: Date.now(), opened: false };
          },
          endUndoSession: () => {
            undoGrouping.session = null;
          },
        }),
    );
  }

  get mode(): VimMode {
    return this.#controller.mode;
  }

  get pendingKeys(): string {
    return this.#controller.pendingKeys;
  }

  subscribe(listener: () => void): () => void {
    return this.#controller.subscribe(listener);
  }

  enterInsert(): void {
    this.#controller.enterInsert();
  }

  /**
   * Keys in Normal and Visual. True means the editor must not handle the key; the event is
   * left unprevented when an app shortcut should still run.
   */
  handleKeyDown(event: KeyboardEvent): boolean {
    if (this.#controller.mode === "insert" || !this.#ownsKey(event)) return false;
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
      const route = routeVimKey(event, this.#controller.mode, this.#controller.commandLineOpen);
      switch (route.type) {
        case "feed":
          this.#controller.feed(route.key);
          return consume();
        case "enter": {
          // Enter sends, as it does in Insert.
          if (this.#controller.mode !== "normal") this.#controller.feed("<Esc>");
          if (this.#callbacks().onEnter(event)) return consume();
          const plain = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
          if (plain) this.#controller.feed("<CR>");
          return consume();
        }
        case "app":
          return true;
        case "editor":
          return false;
        case "swallow":
          return consume();
      }
    } finally {
      this.#event = null;
    }
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
    return !isComposing(event) && event.target === view.dom && view.editable;
  }

  detach(): void {
    this.#editor.storage["composer-undo-grouping"].session = null;
    if (!this.#editor.isDestroyed) this.#editor.unregisterPlugin(vimPluginKey);
  }

  /** Sends text through the editor's own paste handling, so chips and blocks come back. */
  #insertMarkdown(text: string, flavors: Readonly<Record<string, string>> | undefined): void {
    const { view } = this.#editor;
    const data = new DataTransfer();
    data.setData("text/plain", text);
    for (const [type, value] of Object.entries(flavors ?? {})) data.setData(type, value);
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

/** Starts vim on the composer editor; `detach` removes it again. */
export function attachComposerVim(
  editor: Editor,
  callbacks: () => ComposerVimCallbacks,
): ComposerVim {
  const vim = new ComposerVim(editor, callbacks);
  editor.registerPlugin(composerVimPlugin(vim));
  // The prompt typed so far undoes as one Insert session, as later sessions do.
  vim.enterInsert();
  return vim;
}
