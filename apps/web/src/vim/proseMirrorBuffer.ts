import { closeHistory, redo, undo } from "@tiptap/pm/history";
import type { Mark, Node as ProseMirrorNode, Slice } from "@tiptap/pm/model";
import {
  type EditorState,
  NodeSelection,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";

import { collapseAllMarkdownSource } from "~/composer-markdown-source";
import { serializeEditorDoc, serializeSelection } from "~/composer-rich-text-doc";
import { listIndentForTab, listOutdentForTab } from "~/composer-list-continuation";
import type { VimBuffer, VimMode, VimPasteRequest } from "./engine";
import { clampToLine, firstNonBlankCol, nextCol, prevCol, VIM_CHIP, type VimPos } from "./text";

export interface VimVisual {
  readonly anchor: number;
  readonly head: number;
  readonly linewise: boolean;
}

export interface VimPluginState {
  readonly mode: VimMode;
  readonly visual: VimVisual | null;
  readonly pending: string;
}

export const vimPluginKey = new PluginKey<VimPluginState>("composer-vim");

export type VimMeta = Partial<VimPluginState>;

/** Normal and Visual edit rendered text, so the composer shows no Markdown source there. */
export function vimHoldsMarkdownSource(state: EditorState): boolean {
  const mode = vimPluginKey.getState(state)?.mode;
  return mode !== undefined && mode !== "insert";
}

/** The vim plugin's state: the mode for decorations, and a visual selection kept through edits. */
export const vimStateField = {
  init: (): VimPluginState => ({ mode: "insert", visual: null, pending: "" }),
  apply: (tr: Transaction, old: VimPluginState): VimPluginState => {
    const meta = tr.getMeta(vimPluginKey) as VimMeta | undefined;
    const mode = meta?.mode ?? old.mode;
    let visual = meta && "visual" in meta ? (meta.visual ?? null) : old.visual;
    if (visual && tr.docChanged && !(meta && "visual" in meta)) {
      visual = {
        anchor: tr.mapping.map(visual.anchor, 1),
        head: tr.mapping.map(visual.head, 1),
        linewise: visual.linewise,
      };
    }
    const next = {
      mode,
      pending: meta?.pending ?? old.pending,
      visual: mode === "visual" || mode === "visual-line" ? visual : null,
    };
    return next.mode === old.mode && next.pending === old.pending && next.visual === old.visual
      ? old
      : next;
  },
};

interface LineInfo {
  /** Document position of the line's first character. */
  readonly start: number;
  readonly code: boolean;
  /** Position before the textblock that holds the line. */
  readonly block: number;
}

export interface VimLineIndex {
  readonly lines: ReadonlyArray<string>;
  readonly info: ReadonlyArray<LineInfo>;
}

const lineIndexes = new WeakMap<ProseMirrorNode, VimLineIndex>();

/** A textblock is a line, and so is each line of a code block. Chips are one unit. */
export function vimLineIndex(doc: ProseMirrorNode): VimLineIndex {
  const cached = lineIndexes.get(doc);
  if (cached) return cached;
  const lines: string[] = [];
  const info: LineInfo[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const start = pos + 1;
    if (node.type.spec.code) {
      let offset = 0;
      for (const part of node.textContent.split("\n")) {
        lines.push(part);
        info.push({ start: start + offset, code: true, block: pos });
        offset += part.length + 1;
      }
      return false;
    }
    let text = "";
    node.forEach((child) => {
      text += child.isText ? child.text : VIM_CHIP.repeat(child.nodeSize);
    });
    lines.push(text);
    info.push({ start, code: false, block: pos });
    return false;
  });
  if (lines.length === 0) {
    lines.push("");
    info.push({ start: 1, code: false, block: 0 });
  }
  const index = { lines, info };
  lineIndexes.set(doc, index);
  return index;
}

export function vimPosToPm(doc: ProseMirrorNode, pos: VimPos): number {
  const { lines, info } = vimLineIndex(doc);
  const line = Math.max(0, Math.min(lines.length - 1, pos.line));
  return info[line]!.start + Math.max(0, Math.min(lines[line]!.length, pos.col));
}

export function pmToVimPos(doc: ProseMirrorNode, pmPos: number): VimPos {
  const { lines, info } = vimLineIndex(doc);
  for (let line = 0; line < lines.length; line += 1) {
    const { start } = info[line]!;
    if (pmPos <= start + lines[line]!.length) return { line, col: Math.max(0, pmPos - start) };
  }
  const last = lines.length - 1;
  return { line: last, col: lines[last]!.length };
}

export interface VimClipboard {
  readonly text: string;
  readonly linewise: boolean;
}

export interface ProseMirrorVimHost {
  getState(): EditorState;
  dispatch(tr: Transaction): void;
  /** Positions are document positions; null when there is no screen line that way. */
  screenLine(pos: number, direction: 1 | -1, count: number, keepGoal: boolean): number | null;
  history(direction: 1 | -1): void;
  writeClipboard(clipboard: VimClipboard): void;
  readClipboard(): Promise<VimClipboard | null>;
  /** Inserts Markdown at the selection the way a paste does, chips and blocks included. */
  insertMarkdown(text: string): void;
  /** Builds a document from the composer's Markdown, for edits made on that Markdown. */
  parseMarkdown(value: string): ProseMirrorNode | null;
  /** Paste reads the clipboard asynchronously; the controller holds keys until it lands. */
  holdKeys(work: Promise<void>): void;
  beginUndoSession(): void;
  endUndoSession(): void;
}

/** Replaces only the part of the document that differs, so untouched chips keep their views. */
function replaceDocument(tr: Transaction, next: ProseMirrorNode): void {
  const start = tr.doc.content.findDiffStart(next.content);
  if (start === null) return;
  const end = tr.doc.content.findDiffEnd(next.content);
  if (!end) return;
  let { a, b } = end;
  const overlap = start - Math.min(a, b);
  if (overlap > 0) {
    a += overlap;
    b += overlap;
  }
  tr.replace(start, a, next.slice(start, b));
}

const LIST_ITEMS = new Set(["listItem", "taskItem"]);

/**
 * `VimBuffer` over a ProseMirror editor. One transaction collects each command's edits; the
 * controller flushes it, so a Normal command is one view update and one undo step.
 */
export class ProseMirrorVimBuffer implements VimBuffer<Slice> {
  readonly #host: ProseMirrorVimHost;
  #tr: Transaction | null = null;
  /** A visual selection set during this command, and how many steps had run then. */
  #visual: { value: VimVisual | null; steps: number } | undefined;
  #insertStart: ProseMirrorNode | null = null;
  /** Styles of text this command deleted, which a change types with. */
  #deletedMarks: { at: number; marks: ReadonlyArray<Mark> } | null = null;
  #undoSession = false;

  constructor(host: ProseMirrorVimHost) {
    this.#host = host;
  }

  get tr(): Transaction {
    this.#tr ??= this.#host.getState().tr;
    return this.#tr;
  }

  get doc(): ProseMirrorNode {
    return this.#tr?.doc ?? this.#host.getState().doc;
  }

  /** Records the mode for the cursor decoration. */
  setMode(mode: VimMode, pending = ""): void {
    this.tr.setMeta(vimPluginKey, {
      ...(this.tr.getMeta(vimPluginKey) as VimMeta | undefined),
      mode,
      pending,
    });
  }

  /** Removes text just typed before the caret, leaving nothing for undo to bring back. */
  untype(length: number): void {
    const tr = this.tr;
    const head = tr.selection.head;
    tr.delete(head - length, head).setMeta("addToHistory", false);
    this.flush();
  }

  /** Keys typed in Insert while a paste was still reading the clipboard. */
  typeText(text: string): void {
    this.tr.insertText(text);
    this.flush();
  }

  /** Dispatches the command's transaction. Each Normal command is its own undo step. */
  flush(options: { closeHistory?: boolean } = {}): void {
    const tr = this.#tr;
    this.#tr = null;
    this.#deletedMarks = null;
    if (!tr) return;
    if (this.#visual !== undefined) {
      const visual = this.#mappedVisual(tr);
      tr.setMeta(vimPluginKey, { ...(tr.getMeta(vimPluginKey) as VimMeta | undefined), visual });
      this.#visual = undefined;
    }
    if (!tr.docChanged && !tr.selectionSet && tr.getMeta(vimPluginKey) === undefined) return;
    if (options.closeHistory && tr.docChanged) closeHistory(tr);
    this.#host.dispatch(tr.scrollIntoView());
  }

  #mappedVisual(tr: Transaction): VimVisual | null {
    const pending = this.#visual;
    if (pending === undefined) return vimPluginKey.getState(this.#host.getState())?.visual ?? null;
    if (pending.value === null) return null;
    const mapping = tr.mapping.slice(pending.steps);
    return {
      anchor: mapping.map(pending.value.anchor, 1),
      head: mapping.map(pending.value.head, 1),
      linewise: pending.value.linewise,
    };
  }

  #currentVisual(): VimVisual | null {
    if (this.#visual !== undefined) return this.#mappedVisual(this.tr);
    const state = vimPluginKey.getState(this.#host.getState());
    if (state?.visual && this.#tr) {
      const { anchor, head, linewise } = state.visual;
      return {
        anchor: this.#tr.mapping.map(anchor, 1),
        head: this.#tr.mapping.map(head, 1),
        linewise,
      };
    }
    return state?.visual ?? null;
  }

  #pm(pos: VimPos): number {
    return vimPosToPm(this.doc, pos);
  }

  #pos(pmPos: number): VimPos {
    return pmToVimPos(this.doc, pmPos);
  }

  lines(): ReadonlyArray<string> {
    return vimLineIndex(this.doc).lines;
  }

  cursor(): VimPos {
    const visual = this.#currentVisual();
    if (visual) return this.#pos(visual.head);
    const selection = this.#tr?.selection ?? this.#host.getState().selection;
    return this.#pos(selection instanceof NodeSelection ? selection.from : selection.head);
  }

  setCursor(pos: VimPos): void {
    const tr = this.tr;
    // Set even when unchanged: entering Insert shows the Markdown under the caret.
    tr.setSelection(TextSelection.create(tr.doc, this.#pm(pos)));
    if (this.#currentVisual() !== null) this.#visual = { value: null, steps: tr.steps.length };
  }

  /** A non-empty text selection as vim's inclusive anchor and head characters. */
  selectionRange(): { anchor: VimPos; head: VimPos } | null {
    const { selection } = this.#host.getState();
    if (selection.empty || !(selection instanceof TextSelection)) return null;
    const forward = selection.head > selection.anchor;
    return {
      anchor: this.#pos(forward ? selection.anchor : selection.anchor - 1),
      head: this.#pos(forward ? selection.head - 1 : selection.head),
    };
  }

  visualAnchor(): VimPos | null {
    const visual = this.#currentVisual();
    return visual ? this.#pos(visual.anchor) : null;
  }

  setVisual(anchor: VimPos, head: VimPos, linewise: boolean): void {
    const tr = this.tr;
    const lines = this.lines();
    const anchorPm = this.#pm(anchor);
    const headPm = this.#pm(head);
    this.#visual = { value: { anchor: anchorPm, head: headPm, linewise }, steps: tr.steps.length };
    const forward = headPm >= anchorPm;
    const [first, last] = forward ? [anchor, head] : [head, anchor];
    let from: number;
    let to: number;
    if (linewise) {
      from = this.#pm({ line: first.line, col: 0 });
      to = this.#pm({ line: last.line, col: lines[last.line]?.length ?? 0 });
    } else {
      from = this.#pm(first);
      to = this.#pm({ line: last.line, col: nextCol(lines[last.line] ?? "", last.col) });
    }
    tr.setSelection(TextSelection.create(tr.doc, forward ? from : to, forward ? to : from));
  }

  screenLine(from: VimPos, direction: 1 | -1, count: number, keepGoal: boolean): VimPos | null {
    const moved = this.#host.screenLine(this.#pm(from), direction, count, keepGoal);
    return moved === null ? null : this.#pos(moved);
  }

  history(direction: 1 | -1): void {
    this.flush();
    this.#host.history(direction);
  }

  deleteRange(from: VimPos, to: VimPos): void {
    const start = this.#pm(from);
    const end = this.#pm(to);
    if (end <= start) return;
    this.#deletedMarks = { at: start, marks: this.tr.doc.nodeAt(start)?.marks ?? [] };
    this.tr.delete(start, end);
  }

  deleteLines(first: number, last: number): void {
    const tr = this.tr;
    const { lines, info } = vimLineIndex(tr.doc);
    // Whole textblocks go as nodes; lines of a code block that stays go as text.
    const blocks: Array<{ block: number; from: number; to: number }> = [];
    for (let line = first; line <= last && line < lines.length; line += 1) {
      const current = blocks.at(-1);
      if (current?.block === info[line]!.block) current.to = line;
      else blocks.push({ block: info[line]!.block, from: line, to: line });
    }
    for (const { block, from, to } of blocks.toReversed()) {
      const node = tr.doc.nodeAt(block);
      if (!node) continue;
      const blockLines = info.filter((entry) => entry.block === block).length;
      if (node.type.spec.code && to - from + 1 < blockLines) {
        const index = info.findIndex((entry) => entry.block === block);
        const firstInBlock = from === index;
        const start = firstInBlock ? info[from]!.start : info[from]!.start - 1;
        const end = firstInBlock ? info[to + 1]!.start : info[to]!.start + lines[to]!.length;
        tr.delete(start, end);
        continue;
      }
      this.#deleteBlock(tr, block);
    }
  }

  #deleteBlock(tr: Transaction, block: number): void {
    const $block = tr.doc.resolve(block);
    const node = tr.doc.nodeAt(block)!;
    let from = block;
    let to = block + node.nodeSize;
    let depth = $block.depth;
    // Remove wrappers the line was the only content of: its list item, then its list.
    while (depth > 0 && $block.node(depth).childCount === 1) {
      from = $block.before(depth);
      to = $block.after(depth);
      depth -= 1;
    }
    if (depth > 0 && LIST_ITEMS.has($block.node(depth).type.name) && $block.index(depth) === 0) {
      from = $block.before(depth);
      to = $block.after(depth);
    }
    if (depth === 0 && tr.doc.childCount === 1) {
      tr.replaceWith(0, tr.doc.content.size, tr.doc.type.schema.nodes.paragraph!.create());
      return;
    }
    tr.delete(from, to);
  }

  replaceRange(from: VimPos, to: VimPos, text: string): void {
    const start = this.#pm(from);
    const end = this.#pm(to);
    if (text) this.tr.insertText(text, start, end);
    else if (end > start) this.tr.delete(start, end);
  }

  openLine(line: number, below: boolean): VimPos {
    const tr = this.tr;
    const { lines, info } = vimLineIndex(tr.doc);
    const entry = info[line]!;
    if (entry.code) {
      const at = below ? entry.start + lines[line]!.length : entry.start;
      tr.insertText("\n", at);
      return this.#pos(below ? at + 1 : at);
    }
    const $block = tr.doc.resolve(entry.block);
    const textblock = tr.doc.nodeAt(entry.block)!;
    const { schema } = tr.doc.type;
    const parent = $block.parent;
    let insertAt: number;
    let node: ProseMirrorNode;
    if (LIST_ITEMS.has(parent.type.name) && $block.index() === 0) {
      // A new item of the same list, as Enter would make.
      const item = parent;
      const attrs = item.type.name === "taskItem" ? { ...item.attrs, checked: false } : item.attrs;
      node = item.type.create(attrs, schema.nodes.paragraph!.create());
      insertAt = below ? $block.after($block.depth) : $block.before($block.depth);
    } else {
      node = schema.nodes.paragraph!.create();
      insertAt = below ? entry.block + textblock.nodeSize : entry.block;
    }
    tr.insert(insertAt, node);
    let start = insertAt + 1;
    while (!tr.doc.resolve(start).parent.isTextblock) start += 1;
    tr.setSelection(TextSelection.create(tr.doc, start));
    return this.#pos(start);
  }

  transformText(from: VimPos, to: VimPos, transform: (text: string) => string): void {
    const tr = this.tr;
    const start = this.#pm(from);
    const end = this.#pm(to);
    const parts: Array<{ from: number; to: number; text: string; node: ProseMirrorNode }> = [];
    tr.doc.nodesBetween(start, end, (node, pos) => {
      if (!node.isText) return true;
      const partFrom = Math.max(pos, start);
      const partTo = Math.min(pos + node.nodeSize, end);
      if (partTo > partFrom) {
        parts.push({
          from: partFrom,
          to: partTo,
          text: node.text!.slice(partFrom - pos, partTo - pos),
          node,
        });
      }
      return false;
    });
    for (const part of parts.toReversed()) {
      const next = transform(part.text);
      if (next === part.text) continue;
      tr.replaceWith(part.from, part.to, tr.doc.type.schema.text(next, part.node.marks));
    }
  }

  indentLines(first: number, last: number, direction: 1 | -1): void {
    const tr = this.tr;
    const map = serializeEditorDoc(tr.doc);
    const { info } = vimLineIndex(tr.doc);
    const prefixes = map.runs.filter((run) => run.kind === "prefix" && run.mdLen > 0);
    // Plain text keeps markers as text, one paragraph per Markdown line. Rich list items
    // are the lines whose marker is a prefix run at the item's text.
    const plain = tr.doc.type.schema.nodes.bulletList === undefined;
    const markdownLines: number[] = [];
    for (let line = first; line <= last; line += 1) {
      const entry = info[line];
      if (!entry || entry.code) continue;
      if (plain) {
        markdownLines.push(line);
        continue;
      }
      const prefix = prefixes.find((run) => run.pmPos === entry.start);
      if (prefix) markdownLines.push(map.value.slice(0, prefix.mdStart).split("\n").length - 1);
    }
    if (markdownLines.length === 0) return;
    let value = map.value;
    const edit = direction === 1 ? listIndentForTab : listOutdentForTab;
    for (const markdownLine of markdownLines) {
      let lineStart = 0;
      for (let index = 0; index < markdownLine; index += 1)
        lineStart = value.indexOf("\n", lineStart) + 1;
      const result = edit(value, lineStart, lineStart);
      if (result)
        value = value.slice(0, result.start) + result.replacement + value.slice(result.end);
    }
    if (value === map.value) return;
    const next = this.#host.parseMarkdown(value);
    if (next) replaceDocument(tr, next);
  }

  yank(from: VimPos, to: VimPos, linewise: boolean): void {
    const doc = this.doc;
    const { info } = vimLineIndex(doc);
    const serialize = (start: VimPos, end: VimPos) =>
      info[start.line]?.code
        ? doc.textBetween(this.#pm(start), this.#pm(end), "\n")
        : serializeSelection(doc, this.#pm(start), this.#pm(end));
    let text: string;
    if (linewise) {
      const parts: string[] = [];
      const lines = this.lines();
      for (let line = from.line; line <= to.line; line += 1) {
        parts.push(serialize({ line, col: 0 }, { line, col: lines[line]!.length }));
      }
      text = `${parts.join("\n")}\n`;
    } else {
      text = serialize(from, to);
    }
    this.#host.writeClipboard({ text, linewise });
  }

  paste(request: VimPasteRequest): void {
    this.flush({ closeHistory: true });
    const work = this.#host.readClipboard().then((clipboard) => {
      if (clipboard && clipboard.text.length > 0) this.applyPaste(request, clipboard);
    });
    this.#host.holdKeys(work);
  }

  /** Puts clipboard text as vim does: linewise text on new lines, other text after the cursor. */
  applyPaste(request: VimPasteRequest, clipboard: VimClipboard): void {
    this.#host.beginUndoSession();
    try {
      const { replace } = request;
      let { at, before } = request;
      if (replace?.linewise) {
        const remaining = this.lines().length - (replace.to.line - replace.from.line + 1);
        this.deleteLines(replace.from.line, replace.to.line);
        // Put where the lines were: above the line that moved up, or below the new last line.
        before = replace.from.line < remaining;
        at = clampToLine(this.lines(), replace.from);
      } else if (replace) {
        this.deleteRange(replace.from, replace.to);
        at = replace.from;
      }
      const text = clipboard.text.replace(/\n$/, "");
      if (clipboard.linewise) {
        const lines = this.lines();
        const emptyDoc = replace?.linewise && lines.length === 1 && lines[0] === "";
        const opened = emptyDoc ? { line: 0, col: 0 } : this.openLine(at.line, !before);
        this.setCursor(opened);
        this.flush({ closeHistory: true });
        this.#host.insertMarkdown(Array.from({ length: request.count }, () => text).join("\n"));
        this.setCursor({
          line: opened.line,
          col: firstNonBlankCol(this.lines()[opened.line] ?? ""),
        });
        this.flush();
        return;
      }
      const line = this.lines()[at.line] ?? "";
      const col = request.before || replace || line.length === 0 ? at.col : nextCol(line, at.col);
      this.setCursor({ line: at.line, col });
      this.flush({ closeHistory: true });
      this.#host.insertMarkdown(text.repeat(request.count));
      const end = this.cursor();
      this.setCursor({ line: end.line, col: prevCol(this.lines()[end.line] ?? "", end.col) });
      this.flush();
    } finally {
      this.#host.endUndoSession();
    }
  }

  undo(count: number): void {
    this.#history(undo, count);
  }

  redo(count: number): void {
    this.#history(redo, count);
  }

  /** History restores the selection an edit started from; vim rests on its first character. */
  #history(step: typeof undo, count: number): void {
    this.flush();
    for (let index = 0; index < count; index += 1) {
      if (!step(this.#host.getState(), (tr) => this.#host.dispatch(tr))) break;
    }
    const { selection } = this.#host.getState();
    if (selection.empty) return;
    this.setCursor(this.#pos(selection.from));
    this.flush();
  }

  beginInsert(): void {
    // cw on a bold word types bold, as editing its Markdown would.
    const deleted = this.#deletedMarks;
    if (deleted && deleted.marks.length > 0 && this.tr.selection.head === deleted.at) {
      this.tr.setStoredMarks(deleted.marks);
    }
    this.#insertStart = this.doc;
    if (!this.#undoSession) {
      this.#undoSession = true;
      this.#host.beginUndoSession();
    }
  }

  endInsert(): Slice | null {
    if (this.#undoSession) {
      this.#undoSession = false;
      this.#host.endUndoSession();
    }
    const start = this.#insertStart;
    this.#insertStart = null;
    if (!start) return null;
    // Compare rendered text: Markdown the session showed is not something it typed.
    const rendered = this.#host.getState().tr;
    collapseAllMarkdownSource(rendered);
    const doc = rendered.doc;
    const from = start.content.findDiffStart(doc.content);
    const end = start.content.findDiffEnd(doc.content);
    if (from === null || !end || end.b <= from) return null;
    return doc.slice(from, end.b);
  }

  insert(insertion: Slice): void {
    const tr = this.tr;
    const at = tr.selection.head;
    const steps = tr.steps.length;
    tr.replace(at, at, insertion);
    tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.slice(steps).map(at, 1))));
  }
}
