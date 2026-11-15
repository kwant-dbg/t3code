import {
  bracketObject,
  type FindKind,
  findInLine,
  isBracketObject,
  matchBracket,
  type ObjectRange,
  paragraphMotion,
  paragraphObject,
  quoteObject,
  wordBackward,
  wordEnd,
  wordEndFromInside,
  wordForward,
  wordObject,
} from "./motions";
import {
  clampToLine,
  comparePos,
  firstNonBlankCol,
  isBlankChar,
  lastCharCol,
  nextCol,
  prevCol,
  VIM_CHIP,
  type VimPos,
  VimText,
} from "./text";

export type VimMode = "insert" | "normal" | "visual" | "visual-line";

export interface VimPasteRequest {
  readonly at: VimPos;
  readonly before: boolean;
  readonly count: number;
  /** Visual put replaces the selection. */
  readonly replace?: { readonly from: VimPos; readonly to: VimPos; readonly linewise: boolean };
}

/**
 * The document the engine edits. Positions are read back after every edit, so an
 * implementation may reshape text it owns (for example, Markdown it reveals) between commands.
 */
export interface VimBuffer<Insertion> {
  /** Chips are one `VIM_CHIP` each. */
  lines(): ReadonlyArray<string>;
  cursor(): VimPos;
  setCursor(pos: VimPos): void;
  /** The fixed end of the visual selection; `cursor()` is the moving end. */
  visualAnchor(): VimPos | null;
  setVisual(anchor: VimPos, head: VimPos, linewise: boolean): void;
  /** Moves by wrapped screen lines; null when there is no line that way. */
  screenLine(from: VimPos, direction: 1 | -1, count: number, keepGoal: boolean): VimPos | null;
  /** `k` on the first screen line, `j` on the last. */
  history(direction: 1 | -1): void;
  /** `to` is exclusive and may be on a later line, which joins the lines. */
  deleteRange(from: VimPos, to: VimPos): void;
  deleteLines(first: number, last: number): void;
  replaceRange(from: VimPos, to: VimPos, text: string): void;
  /** Adds an empty line of the same kind and returns where to type in it. */
  openLine(line: number, below: boolean): VimPos;
  transformText(from: VimPos, to: VimPos, transform: (text: string) => string): void;
  indentLines(first: number, last: number, direction: 1 | -1): void;
  yank(from: VimPos, to: VimPos, linewise: boolean): void;
  paste(request: VimPasteRequest): void;
  undo(count: number): void;
  redo(count: number): void;
  beginInsert(): void;
  /** What the Insert session typed, for `.`. */
  endInsert(): Insertion | null;
  insert(insertion: Insertion): void;
}

type Operator = "d" | "c" | "y" | ">" | "<" | "g~" | "gu" | "gU";

type Motion = { readonly name: string; readonly char?: string };

type TextObject = { readonly inner: boolean; readonly name: string };

type Command =
  | { readonly type: "motion"; readonly count: number | null; readonly motion: Motion }
  | {
      readonly type: "operator";
      readonly count: number | null;
      readonly operator: Operator;
      readonly target:
        | { readonly type: "motion"; readonly motion: Motion }
        | { readonly type: "object"; readonly object: TextObject }
        | { readonly type: "line" };
    }
  | { readonly type: "object"; readonly count: number | null; readonly object: TextObject }
  | {
      readonly type: "action";
      readonly count: number | null;
      readonly name: string;
      readonly char?: string;
    }
  | {
      readonly type: "visual-repeat";
      readonly count: number | null;
      readonly name: string;
      readonly char?: string;
      readonly lines: number;
      readonly endCol: number | null;
    };

type Parsed = { readonly type: "pending" } | { readonly type: "invalid" } | Command;

const PENDING: Parsed = { type: "pending" };
const INVALID: Parsed = { type: "invalid" };

const SIMPLE_MOTIONS = new Set([
  "h",
  "j",
  "k",
  "l",
  "w",
  "W",
  "b",
  "B",
  "e",
  "E",
  "0",
  "^",
  "$",
  "G",
  "%",
  "{",
  "}",
  "+",
  "-",
  "_",
  ";",
  ",",
  " ",
  "<CR>",
  "<BS>",
  "<Left>",
  "<Right>",
  "<Up>",
  "<Down>",
  "<Home>",
  "<End>",
]);

const MOTION_ALIASES: Record<string, string> = {
  " ": "l",
  "<BS>": "h",
  "<Left>": "h",
  "<Right>": "l",
  "<Up>": "k",
  "<Down>": "j",
  "<Home>": "0",
  "<End>": "$",
  "<CR>": "+",
  gj: "j",
  gk: "k",
};

const NORMAL_ACTIONS = new Set([
  "x",
  "X",
  "<Del>",
  "D",
  "C",
  "s",
  "S",
  "Y",
  "p",
  "P",
  "J",
  "gJ",
  "u",
  "<C-r>",
  ".",
  "i",
  "a",
  "I",
  "A",
  "o",
  "O",
  "~",
  "v",
  "V",
  "<Esc>",
]);

const VISUAL_ACTIONS = new Set([
  "x",
  "<Del>",
  "X",
  "D",
  "C",
  "S",
  "R",
  "s",
  "Y",
  "p",
  "P",
  "J",
  "gJ",
  "~",
  "u",
  "U",
  "o",
  "O",
  "v",
  "V",
  "<Esc>",
]);

const OBJECT_NAMES = new Set([
  "w",
  "W",
  "p",
  '"',
  "'",
  "`",
  "(",
  ")",
  "b",
  "[",
  "]",
  "{",
  "}",
  "B",
  "<",
  ">",
]);

const OPERATOR_KEYS = new Set(["d", "c", "y", ">", "<"]);

const CHANGES = new Set([
  "x",
  "X",
  "<Del>",
  "D",
  "C",
  "s",
  "S",
  "p",
  "P",
  "J",
  "gJ",
  "~",
  "r",
  "i",
  "a",
  "I",
  "A",
  "o",
  "O",
]);

const isPrintable = (key: string) => key.length > 0 && !(key.startsWith("<") && key.length > 1);
const isCountKey = (key: string, started: boolean) =>
  /^[0-9]$/.test(key) && (started || key !== "0");

function parse(keys: ReadonlyArray<string>, visual: boolean): Parsed {
  let index = 0;
  const readCount = (): number | null => {
    let digits = "";
    while (index < keys.length && isCountKey(keys[index]!, digits !== "")) digits += keys[index++];
    return digits ? Number(digits) : null;
  };
  const multiply = (left: number | null, right: number | null) =>
    left === null && right === null ? null : (left ?? 1) * (right ?? 1);

  const readMotion = (): Motion | "pending" | null => {
    const key = keys[index];
    if (key === undefined) return "pending";
    index += 1;
    if (SIMPLE_MOTIONS.has(key)) return { name: MOTION_ALIASES[key] ?? key };
    if (key === "f" || key === "F" || key === "t" || key === "T") {
      const char = keys[index];
      if (char === undefined) return "pending";
      index += 1;
      return isPrintable(char) ? { name: key, char } : null;
    }
    if (key === "g") {
      const next = keys[index];
      if (next === undefined) return "pending";
      index += 1;
      if (next === "g") return { name: "gg" };
      if (next === "e" || next === "E" || next === "j" || next === "k") {
        return { name: MOTION_ALIASES[`g${next}`] ?? `g${next}` };
      }
      return null;
    }
    return null;
  };

  const readObject = (): TextObject | "pending" | null => {
    const kind = keys[index];
    if (kind !== "i" && kind !== "a") return null;
    const name = keys[index + 1];
    if (name === undefined) return "pending";
    index += 2;
    return OBJECT_NAMES.has(name) ? { inner: kind === "i", name } : null;
  };

  const count = readCount();
  const key = keys[index];
  if (key === undefined) return PENDING;

  let operator: Operator | null = null;
  if (OPERATOR_KEYS.has(key)) operator = key as Operator;
  else if (key === "g" && ["~", "u", "U"].includes(keys[index + 1] ?? "")) {
    operator = `g${keys[index + 1]}` as Operator;
  } else if (key === "g" && keys[index + 1] === undefined) return PENDING;

  if (operator !== null) {
    index += operator.length;
    if (visual) return { type: "action", count, name: operator };
    const total = multiply(count, readCount());
    const next = keys[index];
    if (next === undefined) return PENDING;
    const line = { type: "operator", count: total, operator, target: { type: "line" } } as const;
    // dd, cc, yy, >>, <<, and g~~ / g~g~, guu / gugu, gUU / gUgU.
    const doubleKey = operator.at(-1);
    if (next === doubleKey) return line;
    if (operator.length === 2 && next === "g") {
      const after = keys[index + 1];
      if (after === undefined) return PENDING;
      if (after === doubleKey) return line;
    }
    if (next === "i" || next === "a") {
      const object = readObject();
      if (object === "pending") return PENDING;
      if (object === null) return INVALID;
      return { type: "operator", count: total, operator, target: { type: "object", object } };
    }
    const motion = readMotion();
    if (motion === "pending") return PENDING;
    if (motion === null) return INVALID;
    return { type: "operator", count: total, operator, target: { type: "motion", motion } };
  }

  if (visual && (key === "i" || key === "a")) {
    const object = readObject();
    if (object === "pending") return PENDING;
    if (object === null) return INVALID;
    return { type: "object", count, object };
  }

  if (key === "r") {
    const char = keys[index + 1];
    if (char === undefined) return PENDING;
    return isPrintable(char) ? { type: "action", count, name: "r", char } : INVALID;
  }
  if (key === "g" && keys[index + 1] === "J") return { type: "action", count, name: "gJ" };
  if ((visual ? VISUAL_ACTIONS : NORMAL_ACTIONS).has(key)) {
    return { type: "action", count, name: key };
  }

  const motion = readMotion();
  if (motion === "pending") return PENDING;
  if (motion === null) return INVALID;
  return { type: "motion", count, motion };
}

type MotionKind = "exclusive" | "inclusive" | "linewise";

interface MotionResult {
  readonly pos: VimPos;
  readonly kind: MotionKind;
}

interface Range {
  readonly start: VimPos;
  /** Exclusive for charwise ranges; linewise ranges cover whole lines. */
  readonly end: VimPos;
  readonly linewise: boolean;
}

interface RecordedChange<Insertion> {
  readonly command: Command;
  readonly insertion: Insertion | null;
}

/**
 * Vim's Normal, Visual and Insert modes over a `VimBuffer`. It owns only modal state;
 * every position comes from the buffer when a command runs.
 */
export class VimEngine<Insertion> {
  #mode: VimMode = "insert";
  #keys: string[] = [];
  #lastFind: { kind: FindKind; char: string } | null = null;
  #lastChange: RecordedChange<Insertion> | null = null;
  #recording: { command: Command; repeat: number } | null = null;
  #replaying = false;
  #wantEol = false;
  #vertical = false;
  readonly #buffer: VimBuffer<Insertion>;

  constructor(buffer: VimBuffer<Insertion>) {
    this.#buffer = buffer;
  }

  get mode(): VimMode {
    return this.#mode;
  }

  /** Keys typed toward an unfinished command, as vim's showcmd shows them. */
  get pendingKeys(): string {
    return this.#keys.join("");
  }

  /** Focus and sending return to Insert without recording a change for `.`. */
  enterInsert(): void {
    if (this.#mode === "insert") return;
    this.#keys = [];
    this.#recording = null;
    this.#mode = "insert";
    this.#buffer.setCursor(this.#buffer.cursor());
    this.#buffer.beginInsert();
  }

  /** A selection made with the pointer in Normal mode, as a charwise visual selection. */
  selectVisual(anchor: VimPos, head: VimPos): void {
    if (this.#mode !== "normal") return;
    this.#keys = [];
    this.#mode = "visual";
    this.#buffer.setVisual(anchor, head, false);
  }

  /** Esc in Insert. */
  escape(): void {
    if (this.#mode !== "insert") return;
    const insertion = this.#buffer.endInsert();
    const recording = this.#recording;
    this.#recording = null;
    if (recording) {
      if (insertion !== null) {
        for (let index = 1; index < recording.repeat; index += 1) this.#buffer.insert(insertion);
      }
      this.#lastChange = { command: recording.command, insertion };
    }
    this.#mode = "normal";
    const cursor = this.#buffer.cursor();
    const line = this.#lines().line(cursor.line);
    this.#buffer.setCursor(
      clampToLine(this.#lines().lines, { line: cursor.line, col: prevCol(line, cursor.col) }),
    );
  }

  /** Normal and Visual keys, in vim notation: `x`, `<Esc>`, `<C-r>`. */
  feed(key: string): void {
    if (this.#mode === "insert") return;
    this.#keys.push(key);
    const visual = this.#mode !== "normal";
    const parsed = parse(this.#keys, visual);
    if (parsed.type === "pending") return;
    this.#keys = [];
    if (parsed.type === "invalid") return;
    const vertical =
      parsed.type === "motion" && (parsed.motion.name === "j" || parsed.motion.name === "k");
    this.#execute(parsed);
    this.#vertical = vertical;
    if (this.#mode === "normal") this.#clampCursor();
  }

  #lines(): VimText {
    return new VimText(this.#buffer.lines());
  }

  #clampCursor(): void {
    const cursor = this.#buffer.cursor();
    const clamped = clampToLine(this.#buffer.lines(), cursor);
    if (comparePos(cursor, clamped) !== 0) this.#buffer.setCursor(clamped);
  }

  #execute(command: Command): void {
    if (this.#mode === "normal") this.#executeNormal(command);
    else this.#executeVisual(command);
  }

  #executeNormal(command: Command): void {
    switch (command.type) {
      case "motion": {
        const result = this.#motion(command.motion, command.count, false);
        if (result) this.#buffer.setCursor(clampToLine(this.#buffer.lines(), result.pos));
        return;
      }
      case "operator": {
        const range = this.#operatorRange(command);
        if (!range) return;
        this.#record(command);
        this.#applyOperator(command.operator, range, command);
        return;
      }
      case "action":
        this.#action(command);
        return;
      case "visual-repeat":
        this.#visualRepeat(command);
        return;
      case "object":
        return;
    }
  }

  #record(command: Command): void {
    if (this.#replaying) return;
    const isChange =
      command.type === "operator"
        ? command.operator !== "y"
        : command.type === "action"
          ? CHANGES.has(command.name)
          : command.type === "visual-repeat";
    if (!isChange) return;
    this.#lastChange = { command, insertion: null };
  }

  #startInsert(command: Command, repeat = 1): void {
    this.#mode = "insert";
    if (this.#replaying) return;
    this.#recording = { command, repeat };
    this.#buffer.beginInsert();
  }

  #motion(motion: Motion, countArg: number | null, operator: boolean): MotionResult | null {
    const text = this.#lines();
    const cursor = this.#buffer.cursor();
    const count = countArg ?? 1;
    const line = text.line(cursor.line);
    const name = motion.name;
    if (name !== "j" && name !== "k") this.#wantEol = name === "$";
    switch (name) {
      case "h": {
        if (cursor.col === 0) return null;
        let col = cursor.col;
        for (let step = 0; step < count && col > 0; step += 1) col = prevCol(line, col);
        return { pos: { line: cursor.line, col }, kind: "exclusive" };
      }
      case "l": {
        const max = operator ? line.length : lastCharCol(line);
        if (cursor.col >= max) return null;
        let col = cursor.col;
        for (let step = 0; step < count && col < max; step += 1) col = nextCol(line, col);
        return { pos: { line: cursor.line, col: Math.min(col, max) }, kind: "exclusive" };
      }
      case "j":
      case "k": {
        const direction = name === "j" ? 1 : -1;
        if (operator) {
          const target = cursor.line + direction * count;
          if (target < 0 || target > text.lastLine) return null;
          return { pos: { line: target, col: cursor.col }, kind: "linewise" };
        }
        const moved = this.#buffer.screenLine(cursor, direction, count, this.#vertical);
        if (!moved) {
          if (this.#mode === "normal") this.#buffer.history(direction);
          return null;
        }
        const col = this.#wantEol ? lastCharCol(text.line(moved.line)) : moved.col;
        return { pos: { line: moved.line, col }, kind: "exclusive" };
      }
      case "w":
      case "W": {
        const big = name === "W";
        let offset = text.offset(cursor);
        let lastStart = offset;
        for (let step = 0; step < count; step += 1) {
          lastStart = offset;
          offset = wordForward(text.value, offset, big);
        }
        let pos = text.pos(offset);
        if (operator) {
          // dw on the last word of a line stops at the line end instead of joining.
          const from = text.pos(lastStart);
          if (pos.line > from.line && text.line(from.line).length > from.col) {
            pos = { line: pos.line - 1, col: text.line(pos.line - 1).length };
          }
          return { pos, kind: "exclusive" };
        }
        if (offset >= text.value.length) {
          pos = clampToLine(text.lines, pos);
          if (comparePos(pos, cursor) === 0) return null;
        }
        return { pos, kind: "exclusive" };
      }
      case "e":
      case "E": {
        const big = name === "E";
        let offset = text.offset(cursor);
        for (let step = 0; step < count; step += 1) offset = wordEnd(text.value, offset, big);
        const pos = text.pos(offset);
        return comparePos(pos, cursor) === 0 ? null : { pos, kind: "inclusive" };
      }
      case "b":
      case "B": {
        const big = name === "B";
        let offset = text.offset(cursor);
        for (let step = 0; step < count; step += 1) offset = wordBackward(text.value, offset, big);
        const pos = text.pos(offset);
        return comparePos(pos, cursor) === 0 ? null : { pos, kind: "exclusive" };
      }
      case "ge":
      case "gE": {
        const big = name === "gE";
        let offset = text.offset(cursor);
        for (let step = 0; step < count; step += 1) {
          offset = wordBackward(text.value, offset, big);
          offset = Math.max(0, offset - 1);
          while (offset > 0 && isBlankChar(text.value[offset])) offset -= 1;
        }
        return { pos: text.pos(offset), kind: "inclusive" };
      }
      case "0":
        return { pos: { line: cursor.line, col: 0 }, kind: "exclusive" };
      case "^":
        return { pos: { line: cursor.line, col: firstNonBlankCol(line) }, kind: "exclusive" };
      case "$": {
        const target = Math.min(text.lastLine, cursor.line + count - 1);
        const targetLine = text.line(target);
        return { pos: { line: target, col: lastCharCol(targetLine) }, kind: "inclusive" };
      }
      case "gg":
      case "G": {
        const target =
          countArg !== null
            ? Math.min(text.lastLine, countArg - 1)
            : name === "gg"
              ? 0
              : text.lastLine;
        return {
          pos: { line: target, col: firstNonBlankCol(text.line(target)) },
          kind: "linewise",
        };
      }
      case "+":
      case "-":
      case "_": {
        const target = cursor.line + (name === "+" ? count : name === "-" ? -count : count - 1);
        if (target < 0 || target > text.lastLine) return null;
        return {
          pos: { line: target, col: firstNonBlankCol(text.line(target)) },
          kind: "linewise",
        };
      }
      case "f":
      case "F":
      case "t":
      case "T": {
        const char = motion.char ?? "";
        this.#lastFind = { kind: name, char };
        const col = findInLine(line, cursor.col, name, char, count);
        if (col === null) return null;
        return {
          pos: { line: cursor.line, col },
          kind: name === "f" || name === "t" ? "inclusive" : "exclusive",
        };
      }
      case ";":
      case ",": {
        const last = this.#lastFind;
        if (!last) return null;
        const flipped: Record<FindKind, FindKind> = { f: "F", F: "f", t: "T", T: "t" };
        const kind = name === ";" ? last.kind : flipped[last.kind];
        const col = findInLine(line, cursor.col, kind, last.char, count, true);
        if (col === null) return null;
        return {
          pos: { line: cursor.line, col },
          kind: kind === "f" || kind === "t" ? "inclusive" : "exclusive",
        };
      }
      case "%": {
        const pos = matchBracket(text, cursor);
        return pos ? { pos, kind: "inclusive" } : null;
      }
      case "{":
      case "}": {
        const pos = paragraphMotion(text, cursor, name === "}" ? 1 : -1, count);
        return comparePos(pos, cursor) === 0 ? null : { pos, kind: "exclusive" };
      }
      default:
        return null;
    }
  }

  #object(object: TextObject, count: number, from: VimPos): ObjectRange | null {
    const text = this.#lines();
    const { inner, name } = object;
    if (name === "w" || name === "W") return wordObject(text, from, inner, name === "W", count);
    if (name === "p") return paragraphObject(text, from, inner, count);
    if (name === '"' || name === "'" || name === "`") return quoteObject(text, from, name, inner);
    if (isBracketObject(name)) return bracketObject(text, from, name, inner, count);
    return null;
  }

  #operatorRange(command: Extract<Command, { type: "operator" }>): Range | null {
    const cursor = this.#buffer.cursor();
    const text = this.#lines();
    const count = command.count ?? 1;
    const { target } = command;
    if (target.type === "line") {
      const last = cursor.line + count - 1;
      if (last > text.lastLine) return null;
      return { start: { line: cursor.line, col: 0 }, end: { line: last, col: 0 }, linewise: true };
    }
    if (target.type === "object") {
      const object = this.#object(target.object, count, cursor);
      if (!object) return null;
      return { start: object.start, end: object.end, linewise: object.linewise };
    }
    const { motion } = target;
    // cw on a word changes to its end, like ce, without the blanks after it.
    if (command.operator === "c" && (motion.name === "w" || motion.name === "W")) {
      const big = motion.name === "W";
      const char = text.line(cursor.line)[cursor.col];
      if (char !== undefined && !isBlankChar(char)) {
        let offset = wordEndFromInside(text.value, text.offset(cursor), big);
        for (let step = 1; step < count; step += 1) offset = wordEnd(text.value, offset, big);
        return { start: cursor, end: text.after(text.pos(offset)), linewise: false };
      }
    }
    const result = this.#motion(motion, command.count, true);
    if (!result) return null;
    return this.#rangeFromMotion(text, cursor, result);
  }

  #rangeFromMotion(text: VimText, cursor: VimPos, result: MotionResult): Range | null {
    const forward = comparePos(result.pos, cursor) >= 0;
    let start = forward ? cursor : result.pos;
    let end = forward ? result.pos : cursor;
    if (result.kind === "linewise") {
      return {
        start: { line: start.line, col: 0 },
        end: { line: end.line, col: 0 },
        linewise: true,
      };
    }
    if (result.kind === "inclusive") {
      end = text.after(end);
    } else if (end.col === 0 && end.line > start.line) {
      // An exclusive motion that ends at a line start stops at the previous line's end,
      // and becomes linewise when it also started at or before the first character.
      if (/^[ \t]*$/.test(text.line(start.line).slice(0, start.col))) {
        return {
          start: { line: start.line, col: 0 },
          end: { line: end.line - 1, col: 0 },
          linewise: true,
        };
      }
      end = { line: end.line - 1, col: text.line(end.line - 1).length };
    }
    if (comparePos(start, end) === 0) return null;
    return { start, end, linewise: false };
  }

  #applyOperator(operator: Operator, range: Range, command: Command): void {
    const buffer = this.#buffer;
    const text = this.#lines();
    const cursor = buffer.cursor();
    const first = range.start.line;
    const last = range.end.line;
    const lineEnd = (line: number) => ({ line, col: text.line(line).length });
    switch (operator) {
      case "y":
        if (range.linewise) {
          buffer.yank({ line: first, col: 0 }, lineEnd(last), true);
          buffer.setCursor({ line: first, col: cursor.line === first ? cursor.col : 0 });
        } else {
          buffer.yank(range.start, range.end, false);
          buffer.setCursor(range.start);
        }
        return;
      case "d":
        if (range.linewise) {
          buffer.yank({ line: first, col: 0 }, lineEnd(last), true);
          buffer.deleteLines(first, last);
          const after = this.#lines();
          const line = Math.min(first, after.lastLine);
          buffer.setCursor({ line, col: firstNonBlankCol(after.line(line)) });
        } else {
          buffer.yank(range.start, range.end, false);
          buffer.deleteRange(range.start, range.end);
          buffer.setCursor(range.start);
        }
        return;
      case "c":
        if (range.linewise) {
          buffer.yank({ line: first, col: 0 }, lineEnd(last), true);
          if (last > first) buffer.deleteLines(first + 1, last);
          const content = this.#lines().line(first);
          if (content.length > 0) buffer.deleteRange({ line: first, col: 0 }, lineEnd(first));
          buffer.setCursor({ line: first, col: 0 });
        } else {
          buffer.yank(range.start, range.end, false);
          buffer.deleteRange(range.start, range.end);
          buffer.setCursor(range.start);
        }
        this.#startInsert(command);
        return;
      case ">":
      case "<": {
        const end = !range.linewise && range.end.col === 0 && last > first ? last - 1 : last;
        buffer.indentLines(first, end, operator === ">" ? 1 : -1);
        const after = this.#lines();
        buffer.setCursor({ line: first, col: firstNonBlankCol(after.line(first)) });
        return;
      }
      case "g~":
      case "gu":
      case "gU": {
        const transform =
          operator === "gu"
            ? (value: string) => value.toLowerCase()
            : operator === "gU"
              ? (value: string) => value.toUpperCase()
              : toggleCase;
        const from = range.linewise ? { line: first, col: 0 } : range.start;
        const to = range.linewise ? lineEnd(last) : range.end;
        buffer.transformText(from, to, transform);
        buffer.setCursor(
          range.linewise ? { line: first, col: cursor.line === first ? cursor.col : 0 } : from,
        );
        return;
      }
    }
  }

  #action(command: Extract<Command, { type: "action" }>): void {
    const buffer = this.#buffer;
    const text = this.#lines();
    const cursor = buffer.cursor();
    const line = text.line(cursor.line);
    const count = command.count ?? 1;
    const charsFrom = (col: number, amount: number) => {
      let end = col;
      for (let step = 0; step < amount && end < line.length; step += 1) end = nextCol(line, end);
      return end;
    };
    this.#wantEol = false;
    switch (command.name) {
      case "<Esc>":
        return;
      case "x":
      case "<Del>": {
        if (line.length === 0) return;
        this.#record(command);
        const end = { line: cursor.line, col: charsFrom(cursor.col, count) };
        buffer.yank(cursor, end, false);
        buffer.deleteRange(cursor, end);
        buffer.setCursor(cursor);
        return;
      }
      case "X": {
        if (cursor.col === 0) return;
        this.#record(command);
        let col = cursor.col;
        for (let step = 0; step < count && col > 0; step += 1) col = prevCol(line, col);
        const start = { line: cursor.line, col };
        buffer.yank(start, cursor, false);
        buffer.deleteRange(start, cursor);
        buffer.setCursor(start);
        return;
      }
      case "D":
      case "C": {
        const operator = command.name === "D" ? "d" : "c";
        this.#executeNormal({
          type: "operator",
          count: command.count,
          operator,
          target: { type: "motion", motion: { name: "$" } },
        });
        // d$ on an empty line has no range, but C still starts typing there.
        if (operator === "c" && this.#mode === "normal" && line.length === 0 && count === 1) {
          this.#record(command);
          this.#startInsert(command);
        }
        return;
      }
      case "s": {
        this.#record(command);
        const end = { line: cursor.line, col: charsFrom(cursor.col, count) };
        if (end.col > cursor.col) {
          buffer.yank(cursor, end, false);
          buffer.deleteRange(cursor, end);
        }
        buffer.setCursor(cursor);
        this.#startInsert(command);
        return;
      }
      case "S":
        this.#executeNormal({
          type: "operator",
          count: command.count,
          operator: "c",
          target: { type: "line" },
        });
        return;
      case "Y":
        this.#executeNormal({
          type: "operator",
          count: command.count,
          operator: "y",
          target: { type: "line" },
        });
        return;
      case "p":
      case "P":
        this.#record(command);
        buffer.paste({ at: cursor, before: command.name === "P", count });
        return;
      case "J":
      case "gJ": {
        const joins = Math.max(1, count - 1);
        if (cursor.line + 1 > text.lastLine) return;
        this.#record(command);
        this.#join(cursor.line, joins, command.name === "J");
        return;
      }
      case "u":
        buffer.undo(count);
        return;
      case "<C-r>":
        buffer.redo(count);
        return;
      case ".":
        this.#repeat(command.count);
        return;
      case "i":
      case "a":
      case "I":
      case "A": {
        this.#record(command);
        const col =
          command.name === "i"
            ? cursor.col
            : command.name === "a"
              ? nextCol(line, cursor.col)
              : command.name === "I"
                ? firstNonBlankInsertCol(line)
                : line.length;
        buffer.setCursor({ line: cursor.line, col });
        this.#startInsert(command, count);
        return;
      }
      case "o":
      case "O": {
        this.#record(command);
        buffer.setCursor(buffer.openLine(cursor.line, command.name === "o"));
        this.#startInsert(command);
        return;
      }
      case "~": {
        if (line.length === 0) return;
        this.#record(command);
        const end = { line: cursor.line, col: charsFrom(cursor.col, count) };
        buffer.transformText(cursor, end, toggleCase);
        buffer.setCursor({ line: cursor.line, col: Math.min(end.col, lastCharCol(line)) });
        return;
      }
      case "r": {
        const end = charsFrom(cursor.col, count);
        let units = 0;
        for (let col = cursor.col; col < end; col = nextCol(line, col)) units += 1;
        if (units < count) return;
        this.#record(command);
        buffer.replaceRange(
          cursor,
          { line: cursor.line, col: end },
          (command.char ?? "").repeat(count),
        );
        buffer.setCursor({
          line: cursor.line,
          col: cursor.col + (command.char ?? "").length * (count - 1),
        });
        return;
      }
      case "v":
      case "V":
        this.#mode = command.name === "v" ? "visual" : "visual-line";
        buffer.setVisual(cursor, cursor, command.name === "V");
        return;
    }
  }

  /** J removes the next line's indent and joins with one space; gJ joins as is. */
  #join(lineIndex: number, joins: number, spaces: boolean): void {
    const buffer = this.#buffer;
    let joinCol = 0;
    for (let step = 0; step < joins; step += 1) {
      const text = this.#lines();
      if (lineIndex + 1 > text.lastLine) break;
      const current = text.line(lineIndex);
      const next = text.line(lineIndex + 1);
      let skip = 0;
      if (spaces) while (skip < next.length && isBlankChar(next[skip])) skip += 1;
      buffer.deleteRange(
        { line: lineIndex, col: current.length },
        { line: lineIndex + 1, col: skip },
      );
      joinCol = current.length;
      const rest = next.slice(skip);
      const addSpace =
        spaces &&
        current.length > 0 &&
        rest.length > 0 &&
        !isBlankChar(current.at(-1)) &&
        !rest.startsWith(")");
      if (addSpace) {
        buffer.replaceRange(
          { line: lineIndex, col: joinCol },
          { line: lineIndex, col: joinCol },
          " ",
        );
      }
    }
    buffer.setCursor({ line: lineIndex, col: joinCol });
  }

  #repeat(countArg: number | null): void {
    const change = this.#lastChange;
    if (!change) return;
    // A visual change repeats over the same amount of text, whatever the count.
    const command =
      countArg === null || change.command.type === "visual-repeat"
        ? change.command
        : { ...change.command, count: countArg };
    this.#replaying = true;
    try {
      this.#executeNormal(command);
      if (this.#mode === "insert") {
        if (change.insertion !== null) {
          const repeat =
            command.type === "action" && "iaIA".includes(command.name) ? (command.count ?? 1) : 1;
          for (let index = 0; index < repeat; index += 1) this.#buffer.insert(change.insertion);
        }
        this.#mode = "normal";
        const cursor = this.#buffer.cursor();
        const line = this.#lines().line(cursor.line);
        this.#buffer.setCursor({ line: cursor.line, col: prevCol(line, cursor.col) });
      }
    } finally {
      this.#replaying = false;
    }
    this.#lastChange = { command, insertion: change.insertion };
  }

  #visualRange(): Range {
    const head = this.#buffer.cursor();
    const anchor = this.#buffer.visualAnchor() ?? head;
    const [start, end] = comparePos(anchor, head) <= 0 ? [anchor, head] : [head, anchor];
    if (this.#mode === "visual-line") {
      return {
        start: { line: start.line, col: 0 },
        end: { line: end.line, col: 0 },
        linewise: true,
      };
    }
    return { start, end: this.#lines().after(end), linewise: false };
  }

  #exitVisual(cursor: VimPos): void {
    this.#mode = "normal";
    this.#buffer.setCursor(clampToLine(this.#buffer.lines(), cursor));
  }

  #executeVisual(command: Command): void {
    const buffer = this.#buffer;
    const head = buffer.cursor();
    const anchor = buffer.visualAnchor() ?? head;
    const linewise = this.#mode === "visual-line";
    if (command.type === "motion") {
      const result = this.#motion(command.motion, command.count, false);
      if (result) buffer.setVisual(anchor, clampToLine(buffer.lines(), result.pos), linewise);
      return;
    }
    if (command.type === "object") {
      const object = this.#object(command.object, command.count ?? 1, head);
      if (!object) return;
      const text = this.#lines();
      const end = object.linewise
        ? { line: object.end.line, col: 0 }
        : text.pos(Math.max(text.offset(object.start), text.offset(object.end) - 1));
      if (object.linewise) this.#mode = "visual-line";
      buffer.setVisual(object.start, end, this.#mode === "visual-line");
      return;
    }
    if (command.type !== "action") return;
    const name = command.name;
    if (name === "<Esc>") return this.#exitVisual(head);
    if (name === "v" || name === "V") {
      const next = name === "v" ? "visual" : "visual-line";
      if (this.#mode === next) return this.#exitVisual(head);
      this.#mode = next;
      buffer.setVisual(anchor, head, next === "visual-line");
      return;
    }
    if (name === "o" || name === "O") {
      buffer.setVisual(head, anchor, linewise);
      return;
    }
    const range = this.#visualRange();
    const text = this.#lines();
    const lines = range.end.line - range.start.line + 1;
    const record = (recordName: string, char?: string) => {
      if (this.#replaying) return;
      const lastLine = text.line(range.end.line);
      const endCol = range.linewise
        ? null
        : range.end.line === range.start.line
          ? null
          : Math.min(range.end.col, lastLine.length);
      const width =
        range.linewise || range.end.line !== range.start.line ? 0 : range.end.col - range.start.col;
      this.#lastChange = {
        command: {
          type: "visual-repeat",
          count: range.linewise ? null : width,
          name: recordName,
          ...(char === undefined ? {} : { char }),
          lines,
          endCol,
        },
        insertion: null,
      };
    };
    this.#mode = "normal";
    this.#applyVisual(name, command.char, range, record);
  }

  #applyVisual(
    name: string,
    char: string | undefined,
    range: Range,
    record: (name: string, char?: string) => void,
  ): void {
    const buffer = this.#buffer;
    const lineRange: Range = {
      start: { line: range.start.line, col: 0 },
      end: { line: range.end.line, col: 0 },
      linewise: true,
    };
    const visualCommand: Command = { type: "action", count: null, name };
    switch (name) {
      case "y":
        this.#applyOperator("y", range, visualCommand);
        return;
      case "Y":
        this.#applyOperator("y", lineRange, visualCommand);
        return;
      case "d":
      case "x":
      case "<Del>":
        record("d");
        this.#applyOperator("d", range, visualCommand);
        return;
      case "D":
      case "X":
        record("D");
        this.#applyOperator("d", lineRange, visualCommand);
        return;
      case "c":
      case "s":
        record("c");
        this.#applyOperator("c", range, this.#lastChange?.command ?? visualCommand);
        return;
      case "C":
      case "S":
      case "R":
        record("C");
        this.#applyOperator("c", lineRange, this.#lastChange?.command ?? visualCommand);
        return;
      case ">":
      case "<":
        record(name);
        this.#applyOperator(name, lineRange, visualCommand);
        return;
      case "~":
      case "u":
      case "U": {
        const operator: Operator = name === "~" ? "g~" : name === "u" ? "gu" : "gU";
        record(name);
        this.#applyOperator(operator, range, visualCommand);
        return;
      }
      case "g~":
      case "gu":
      case "gU":
        record(name === "g~" ? "~" : name === "gu" ? "u" : "U");
        this.#applyOperator(name, range, visualCommand);
        return;
      case "J":
      case "gJ":
        record(name);
        this.#join(range.start.line, Math.max(1, range.end.line - range.start.line), name === "J");
        return;
      case "r": {
        if (char === undefined) return;
        record("r", char);
        const replace = (value: string) => value.replace(/[^\n￼]/gu, char);
        const to = range.linewise
          ? { line: range.end.line, col: this.#lines().line(range.end.line).length }
          : range.end;
        buffer.transformText(range.start, to, replace);
        buffer.setCursor(range.start);
        return;
      }
      case "p":
      case "P": {
        const text = this.#lines();
        const to = range.linewise
          ? { line: range.end.line, col: text.line(range.end.line).length }
          : range.end;
        buffer.paste({
          at: range.start,
          before: true,
          count: 1,
          replace: { from: range.start, to, linewise: range.linewise },
        });
        return;
      }
    }
  }

  #visualRepeat(command: Extract<Command, { type: "visual-repeat" }>): void {
    const cursor = this.#buffer.cursor();
    const text = this.#lines();
    const lastLine = Math.min(text.lastLine, cursor.line + command.lines - 1);
    let range: Range;
    if (command.count === null && command.endCol === null) {
      range = {
        start: { line: cursor.line, col: 0 },
        end: { line: lastLine, col: 0 },
        linewise: true,
      };
    } else if (command.endCol !== null) {
      range = {
        start: cursor,
        end: { line: lastLine, col: Math.min(command.endCol, text.line(lastLine).length) },
        linewise: false,
      };
    } else {
      const line = text.line(cursor.line);
      range = {
        start: cursor,
        end: { line: cursor.line, col: Math.min(line.length, cursor.col + (command.count ?? 1)) },
        linewise: false,
      };
    }
    this.#applyVisual(command.name, command.char, range, () => {});
  }
}

function firstNonBlankInsertCol(line: string): number {
  let col = 0;
  while (col < line.length && isBlankChar(line[col])) col += 1;
  return col;
}

function toggleCase(value: string): string {
  let result = "";
  for (const char of value) {
    if (char === VIM_CHIP) result += char;
    else {
      const upper = char.toUpperCase();
      result += upper === char ? char.toLowerCase() : upper;
    }
  }
  return result;
}
