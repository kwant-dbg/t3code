import type { ControlledVimBuffer } from "./controller";
import type { VimMode, VimPasteRequest, VimYank } from "./engine";
import { clampToLine, firstNonBlankCol, nextCol, prevCol, type VimPos, VimText } from "./text";

export interface TextareaVimHost {
  writeClipboard(yank: VimYank): void;
  /** Null when the clipboard cannot be read. */
  readClipboardText(): Promise<string | null>;
  /** Paste reads the clipboard asynchronously; the controller holds keys until it lands. */
  holdKeys(work: Promise<void>): void;
}

interface Snapshot {
  readonly value: string;
  readonly cursor: number;
}

interface Visual {
  readonly anchor: number;
  readonly head: number;
  readonly linewise: boolean;
}

const INDENT = "  ";

/**
 * `VimBuffer` over a `<textarea>`. Edits go through `setRangeText` and reach React as one
 * `input` event per command. Textareas keep no undo history for scripted edits, so `u` and
 * `ctrl+r` use this buffer's own: one step per Normal command and per Insert session.
 */
export class TextareaVimBuffer implements ControlledVimBuffer<string> {
  readonly #textarea: HTMLTextAreaElement;
  readonly #host: TextareaVimHost;
  #text: VimText | null = null;
  #visual: Visual | null = null;
  #mode: VimMode = "insert";
  #changed = false;
  /** The text before the current command or session changed it. */
  #before: Snapshot | null = null;
  #insertValue: string | null = null;
  readonly #undo: Snapshot[] = [];
  #redo: Snapshot[] = [];
  #goalX: number | null = null;

  constructor(textarea: HTMLTextAreaElement, host: TextareaVimHost) {
    this.#textarea = textarea;
    this.#host = host;
  }

  get #value(): string {
    return this.#textarea.value;
  }

  #lines(): VimText {
    const value = this.#value;
    if (this.#text?.value !== value) this.#text = new VimText(value.split("\n"));
    return this.#text;
  }

  #offset(pos: VimPos): number {
    const text = this.#lines();
    const line = Math.max(0, Math.min(text.lastLine, pos.line));
    return text.offset({ line, col: Math.max(0, Math.min(text.line(line).length, pos.col)) });
  }

  #snapshot(): Snapshot {
    return { value: this.#value, cursor: this.#textarea.selectionStart };
  }

  #edit(start: number, end: number, text: string): void {
    this.#before ??= this.#snapshot();
    this.#textarea.setRangeText(text, start, end);
    this.#changed = true;
  }

  setMode(mode: VimMode, pending: string): void {
    this.#mode = mode;
    this.#textarea.dataset.vimMode = mode;
    if (pending) this.#textarea.dataset.vimPending = pending;
    else delete this.#textarea.dataset.vimPending;
  }

  flush(): void {
    if (this.#changed) {
      this.#changed = false;
      // React reads the new value from this event, as from typing.
      this.#textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (this.#mode === "insert" || this.#mode === "replace") return;
    const before = this.#before;
    this.#before = null;
    if (before && before.value !== this.#value) {
      this.#undo.push(before);
      this.#redo = [];
    }
  }

  typeText(text: string): void {
    const at = this.#textarea.selectionStart;
    this.#edit(at, this.#textarea.selectionEnd, text);
    this.#textarea.setSelectionRange(at + text.length, at + text.length);
    this.flush();
  }

  selectionRange(): { anchor: VimPos; head: VimPos } | null {
    const { selectionStart, selectionEnd, selectionDirection } = this.#textarea;
    if (selectionStart === selectionEnd) return null;
    const text = this.#lines();
    const backward = selectionDirection === "backward";
    return {
      anchor: text.pos(backward ? selectionEnd - 1 : selectionStart),
      head: text.pos(backward ? selectionStart : selectionEnd - 1),
    };
  }

  lines(): ReadonlyArray<string> {
    return this.#lines().lines;
  }

  cursor(): VimPos {
    const text = this.#lines();
    return text.pos(this.#visual?.head ?? this.#textarea.selectionStart);
  }

  setCursor(pos: VimPos): void {
    this.#visual = null;
    const offset = this.#offset(pos);
    this.#textarea.setSelectionRange(offset, offset);
  }

  visualAnchor(): VimPos | null {
    return this.#visual ? this.#lines().pos(this.#visual.anchor) : null;
  }

  setVisual(anchor: VimPos, head: VimPos, linewise: boolean): void {
    const text = this.#lines();
    const anchorOffset = this.#offset(anchor);
    const headOffset = this.#offset(head);
    this.#visual = { anchor: anchorOffset, head: headOffset, linewise };
    const forward = headOffset >= anchorOffset;
    const [first, last] = forward ? [anchor, head] : [head, anchor];
    const from = linewise ? this.#offset({ line: first.line, col: 0 }) : this.#offset(first);
    const lastLine = text.line(last.line);
    const to = this.#offset({
      line: last.line,
      col: linewise ? lastLine.length : nextCol(lastLine, last.col),
    });
    this.#textarea.setSelectionRange(from, to, forward ? "forward" : "backward");
  }

  screenLine(from: VimPos, direction: 1 | -1, count: number, keepGoal: boolean): VimPos | null {
    const layout = measureTextarea(this.#textarea);
    try {
      const start = this.#offset(from);
      if (!keepGoal || this.#goalX === null) this.#goalX = layout.rectAt(start).left;
      const moved = layout.screenLine(start, direction, count, this.#goalX);
      return moved === null ? null : this.#lines().pos(moved);
    } finally {
      layout.dispose();
    }
  }

  history(): void {}

  deleteRange(from: VimPos, to: VimPos): void {
    const start = this.#offset(from);
    const end = this.#offset(to);
    if (end > start) this.#edit(start, end, "");
  }

  deleteLines(first: number, last: number): void {
    const text = this.#lines();
    const lastLine = Math.min(last, text.lastLine);
    if (lastLine < text.lastLine) {
      this.#edit(
        text.offset({ line: first, col: 0 }),
        text.offset({ line: lastLine + 1, col: 0 }),
        "",
      );
    } else if (first > 0) {
      const end = text.offset({ line: lastLine, col: text.line(lastLine).length });
      this.#edit(text.offset({ line: first - 1, col: text.line(first - 1).length }), end, "");
    } else {
      this.#edit(0, this.#value.length, "");
    }
  }

  replaceRange(from: VimPos, to: VimPos, text: string): void {
    this.#edit(this.#offset(from), this.#offset(to), text);
  }

  openLine(line: number, below: boolean): VimPos {
    const text = this.#lines();
    const at = below
      ? text.offset({ line, col: text.line(line).length })
      : text.offset({ line, col: 0 });
    this.#edit(at, at, "\n");
    const pos = { line: below ? line + 1 : line, col: 0 };
    this.setCursor(pos);
    return pos;
  }

  transformText(from: VimPos, to: VimPos, transform: (text: string) => string): void {
    const start = this.#offset(from);
    const end = this.#offset(to);
    const before = this.#value.slice(start, end);
    const after = transform(before);
    if (after !== before) this.#edit(start, end, after);
  }

  indentLines(first: number, last: number, direction: 1 | -1): void {
    const text = this.#lines();
    const lines = text.lines.slice(first, last + 1).map((line) => {
      if (direction === 1) return line.length > 0 ? INDENT + line : line;
      return line.startsWith("\t") ? line.slice(1) : line.replace(/^ {1,2}/, "");
    });
    const start = text.offset({ line: first, col: 0 });
    const end = text.offset({ line: last, col: text.line(last).length });
    const next = lines.join("\n");
    if (next !== this.#value.slice(start, end)) this.#edit(start, end, next);
  }

  read(from: VimPos, to: VimPos, linewise: boolean): VimYank {
    const text = this.#lines();
    if (linewise) {
      return { text: `${text.lines.slice(from.line, to.line + 1).join("\n")}\n`, linewise };
    }
    return { text: this.#value.slice(this.#offset(from), this.#offset(to)), linewise };
  }

  writeClipboard(yank: VimYank): void {
    this.#host.writeClipboard(yank);
  }

  paste(request: VimPasteRequest): void {
    const { source } = request;
    if (source.type === "register") {
      this.#applyPaste(request, source.yank);
      return;
    }
    const work = this.#host.readClipboardText().then((clipboard) => {
      const yank = source.resolve(clipboard);
      if (!yank || yank.text.length === 0) return;
      this.#applyPaste(request, yank);
      this.flush();
    });
    this.#host.holdKeys(work);
  }

  /** Puts register text as vim does: linewise text on new lines, other text after the cursor. */
  #applyPaste(request: VimPasteRequest, yank: VimYank): void {
    const { replace } = request;
    let { at, before } = request;
    if (replace?.linewise) {
      const remaining = this.lines().length - (replace.to.line - replace.from.line + 1);
      this.deleteLines(replace.from.line, replace.to.line);
      before = replace.from.line < remaining;
      at = clampToLine(this.lines(), replace.from);
    } else if (replace) {
      this.deleteRange(replace.from, replace.to);
      at = replace.from;
    }
    if (yank.linewise) {
      const body = yank.text.replace(/\n$/, "");
      const lines = Array.from({ length: request.count }, () => body).join("\n");
      const text = this.#lines();
      const emptied = replace?.linewise && text.lines.length === 1 && text.line(0) === "";
      if (emptied) {
        this.#edit(0, 0, lines);
        this.setCursor({ line: 0, col: firstNonBlankCol(this.#lines().line(0)) });
        return;
      }
      const offset = before
        ? text.offset({ line: at.line, col: 0 })
        : text.offset({ line: at.line, col: text.line(at.line).length });
      this.#edit(offset, offset, before ? `${lines}\n` : `\n${lines}`);
      const line = before ? at.line : at.line + 1;
      this.setCursor({ line, col: firstNonBlankCol(this.#lines().line(line)) });
      return;
    }
    const value = yank.text.repeat(request.count);
    const line = this.#lines().line(at.line);
    const col = before || replace || line.length === 0 ? at.col : nextCol(line, at.col);
    const offset = this.#offset({ line: at.line, col });
    this.#edit(offset, offset, value);
    const end = this.#lines().pos(offset + value.length);
    this.setCursor({ line: end.line, col: prevCol(this.#lines().line(end.line), end.col) });
  }

  undo(count: number): void {
    this.#travel(this.#undo, (snapshot) => this.#redo.push(snapshot), count);
  }

  redo(count: number): void {
    this.#travel(this.#redo, (snapshot) => this.#undo.push(snapshot), count);
  }

  #travel(from: Snapshot[], to: (snapshot: Snapshot) => void, count: number): void {
    for (let step = 0; step < count; step += 1) {
      const snapshot = from.pop();
      if (!snapshot) break;
      to(this.#snapshot());
      // Not `value =`, which React would take as its own write and never report.
      this.#textarea.setRangeText(snapshot.value, 0, this.#value.length);
      this.#changed = true;
      // Vim rests on the first character the change touched.
      const cursor = Math.min(snapshot.cursor, snapshot.value.length);
      this.#textarea.setSelectionRange(cursor, cursor);
    }
    this.#before = null;
  }

  beginInsert(): void {
    this.#before ??= this.#snapshot();
    this.#insertValue = this.#value;
  }

  endInsert(): string | null {
    const before = this.#insertValue;
    this.#insertValue = null;
    if (before === null) return null;
    const after = this.#value;
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) {
      start += 1;
    }
    let end = 0;
    while (
      end < before.length - start &&
      end < after.length - start &&
      before[before.length - 1 - end] === after[after.length - 1 - end]
    ) {
      end += 1;
    }
    const inserted = after.slice(start, after.length - end);
    return inserted.length > 0 ? inserted : null;
  }

  insert(insertion: string): void {
    const at = this.#textarea.selectionStart;
    this.#edit(at, at, insertion);
    this.#textarea.setSelectionRange(at + insertion.length, at + insertion.length);
  }
}

// Styles that decide where a textarea wraps its text.
const LAYOUT_STYLES = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "fontStretch",
  "fontFeatureSettings",
  "letterSpacing",
  "wordSpacing",
  "lineHeight",
  "textIndent",
  "textTransform",
  "tabSize",
  "wordBreak",
  "overflowWrap",
  "direction",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
] as const;

interface CaretRect {
  readonly top: number;
  readonly left: number;
  readonly height: number;
}

/**
 * Lays the textarea's text out in a hidden copy, so `j` and `k` can move by wrapped screen
 * line as they do in the composer. Built per keypress and disposed right away.
 */
function measureTextarea(textarea: HTMLTextAreaElement) {
  const style = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const name of LAYOUT_STYLES) mirror.style[name] = style[name];
  Object.assign(mirror.style, {
    position: "fixed",
    top: "0",
    left: "0",
    visibility: "hidden",
    pointerEvents: "none",
    boxSizing: "border-box",
    border: "0",
    width: `${textarea.clientWidth}px`,
    whiteSpace: "pre-wrap",
  });
  // A trailing character gives the end of the text a box to measure.
  const node = document.createTextNode(`${textarea.value}​`);
  mirror.append(node);
  document.body.append(mirror);
  const range = document.createRange();
  const length = textarea.value.length;

  // A character's own box says which wrapped line it is on; a line break has none, so it
  // takes the caret box at its line's end.
  const rectAt = (offset: number): CaretRect => {
    const at = Math.max(0, Math.min(length, offset));
    const lineBreak = textarea.value[at] === "\n";
    range.setStart(node, at);
    range.setEnd(node, lineBreak ? at : at + 1);
    const rect = (lineBreak ? null : range.getClientRects()[0]) ?? range.getBoundingClientRect();
    return { top: rect.top, left: rect.left, height: rect.height };
  };
  const sameLine = (left: CaretRect, right: CaretRect) =>
    Math.abs(left.top - right.top) < Math.max(1, Math.min(left.height, right.height) / 2);

  /** The offset on the screen line holding `offset` whose left edge is nearest `goalX`. */
  const nearestOnLine = (offset: number, goalX: number): number => {
    const line = rectAt(offset);
    let start = offset;
    while (start > 0 && textarea.value[start - 1] !== "\n" && sameLine(rectAt(start - 1), line)) {
      start -= 1;
    }
    let best = start;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let at = start; at <= length; at += 1) {
      const rect = rectAt(at);
      if (!sameLine(rect, line)) break;
      const distance = Math.abs(rect.left - goalX);
      if (distance < bestDistance) {
        best = at;
        bestDistance = distance;
      }
      if (textarea.value[at] === "\n") break;
    }
    return best;
  };

  const screenLine = (
    offset: number,
    direction: 1 | -1,
    count: number,
    goalX: number,
  ): number | null => {
    let current = offset;
    let moved = false;
    for (let step = 0; step < count; step += 1) {
      const line = rectAt(current);
      let next = current;
      if (direction === 1) {
        while (next < length && sameLine(rectAt(next + 1), line)) next += 1;
        if (next >= length) break;
        next += 1;
      } else {
        while (next > 0 && sameLine(rectAt(next - 1), line)) next -= 1;
        if (next === 0) break;
        next -= 1;
      }
      current = next;
      moved = true;
    }
    return moved ? nearestOnLine(current, goalX) : null;
  };

  return {
    rectAt,
    screenLine,
    dispose: () => mirror.remove(),
  };
}
