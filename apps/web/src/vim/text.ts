/** One unit per chip, so motions and edits never split one. */
export const VIM_CHIP = "￼";

export interface VimPos {
  readonly line: number;
  readonly col: number;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

export const isBlankChar = (char: string | undefined) => char === " " || char === "\t";

export function nextCol(line: string, col: number): number {
  if (col >= line.length) return line.length;
  return isHighSurrogate(line.charCodeAt(col)) && isLowSurrogate(line.charCodeAt(col + 1))
    ? col + 2
    : col + 1;
}

export function prevCol(line: string, col: number): number {
  if (col <= 0) return 0;
  return col >= 2 &&
    isLowSurrogate(line.charCodeAt(col - 1)) &&
    isHighSurrogate(line.charCodeAt(col - 2))
    ? col - 2
    : col - 1;
}

/** The last column Normal mode can rest on. */
export function lastCharCol(line: string): number {
  return prevCol(line, line.length);
}

/** `^`: a blank-only line goes to its last character, as in vim. */
export function firstNonBlankCol(line: string): number {
  let col = 0;
  while (col < line.length && isBlankChar(line[col])) col += 1;
  return col === line.length ? lastCharCol(line) : col;
}

export function comparePos(left: VimPos, right: VimPos): number {
  return left.line - right.line || left.col - right.col;
}

export function clampToLine(lines: ReadonlyArray<string>, pos: VimPos, insert = false): VimPos {
  const line = Math.max(0, Math.min(lines.length - 1, pos.line));
  const text = lines[line] ?? "";
  const max = insert ? text.length : lastCharCol(text);
  return { line, col: Math.max(0, Math.min(max, pos.col)) };
}

/** Lines joined with `\n`, for motions that cross line ends. */
export class VimText {
  readonly lines: ReadonlyArray<string>;
  readonly value: string;
  readonly #starts: number[] = [];

  constructor(lines: ReadonlyArray<string>) {
    this.lines = lines.length > 0 ? lines : [""];
    let offset = 0;
    for (const line of this.lines) {
      this.#starts.push(offset);
      offset += line.length + 1;
    }
    this.value = this.lines.join("\n");
  }

  get lastLine(): number {
    return this.lines.length - 1;
  }

  line(index: number): string {
    return this.lines[index] ?? "";
  }

  offset(pos: VimPos): number {
    return (this.#starts[pos.line] ?? this.value.length) + pos.col;
  }

  pos(offset: number): VimPos {
    const bounded = Math.max(0, Math.min(this.value.length, offset));
    let low = 0;
    let high = this.#starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.#starts[mid]! <= bounded) low = mid;
      else high = mid - 1;
    }
    return { line: low, col: bounded - this.#starts[low]! };
  }

  /** The position just after the character at `pos`, for inclusive ranges. */
  after(pos: VimPos): VimPos {
    return { line: pos.line, col: nextCol(this.line(pos.line), pos.col) };
  }
}
