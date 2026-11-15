import { isBlankChar, VIM_CHIP, type VimPos, VimText, nextCol, prevCol } from "./text";

const BLANK = 0;
const PUNCTUATION = 1;
const WORD = 2;
const CHIP = 3;

function charClass(char: string | undefined, big: boolean): number {
  if (char === undefined) return -1;
  if (char === "\n" || isBlankChar(char)) return BLANK;
  if (char === VIM_CHIP) return CHIP;
  if (big) return WORD;
  return /[\p{L}\p{N}_]/u.test(char) ? WORD : PUNCTUATION;
}

/** Each chip is its own word, even next to another chip. */
function sameWord(text: string, left: number, right: number, big: boolean): boolean {
  const leftClass = charClass(text[left], big);
  return leftClass !== CHIP && leftClass > BLANK && leftClass === charClass(text[right], big);
}

function isEmptyLineAt(text: string, offset: number): boolean {
  return (
    (offset === 0 || text[offset - 1] === "\n") && (offset === text.length || text[offset] === "\n")
  );
}

/** `w`: the next word start, an empty line, or the end of the text. */
export function wordForward(text: string, from: number, big: boolean): number {
  let offset = from;
  if (charClass(text[offset], big) > BLANK) {
    while (offset < text.length && sameWord(text, offset, offset + 1, big)) offset += 1;
    offset += 1;
  }
  while (offset < text.length && charClass(text[offset], big) === BLANK) {
    const newline = text[offset] === "\n";
    offset += 1;
    if (newline && isEmptyLineAt(text, offset)) return offset;
  }
  return offset;
}

/** `e`: the next word end. Returns `from` when there is none. */
export function wordEnd(text: string, from: number, big: boolean): number {
  let offset = from + 1;
  while (offset < text.length && charClass(text[offset], big) === BLANK) offset += 1;
  if (offset >= text.length) return from;
  while (offset + 1 < text.length && sameWord(text, offset, offset + 1, big)) offset += 1;
  return offset;
}

/** `cw` stays on the end of the word it starts in. */
export function wordEndFromInside(text: string, from: number, big: boolean): number {
  let offset = from;
  while (offset + 1 < text.length && sameWord(text, offset, offset + 1, big)) offset += 1;
  return offset;
}

/** `b`: the previous word start or empty line. */
export function wordBackward(text: string, from: number, big: boolean): number {
  if (from <= 0) return 0;
  let offset = from - 1;
  while (offset > 0 && charClass(text[offset], big) === BLANK) {
    if (isEmptyLineAt(text, offset)) return offset;
    offset -= 1;
  }
  while (offset > 0 && sameWord(text, offset - 1, offset, big)) offset -= 1;
  return offset;
}

export type FindKind = "f" | "F" | "t" | "T";

/** f, F, t and T within one line; `repeat` lets `;` move past an adjacent `t` target. */
export function findInLine(
  line: string,
  col: number,
  kind: FindKind,
  char: string,
  count: number,
  repeat = false,
): number | null {
  const forward = kind === "f" || kind === "t";
  const till = kind === "t" || kind === "T";
  let offset = col;
  if (till && repeat) offset = forward ? nextCol(line, offset) : prevCol(line, offset);
  for (let found = 0; found < count;) {
    offset = forward ? nextCol(line, offset) : offset - 1;
    if (offset < 0 || offset >= line.length) return null;
    if (line.startsWith(char, offset)) found += 1;
  }
  if (!till) return offset;
  return forward ? prevCol(line, offset) : nextCol(line, offset);
}

const BRACKETS: Record<string, { match: string; forward: boolean }> = {
  "(": { match: ")", forward: true },
  "[": { match: "]", forward: true },
  "{": { match: "}", forward: true },
  ")": { match: "(", forward: false },
  "]": { match: "[", forward: false },
  "}": { match: "{", forward: false },
};

/** `%`: the bracket matching the first one at or after the cursor on its line. */
export function matchBracket(text: VimText, pos: VimPos): VimPos | null {
  const line = text.line(pos.line);
  let col = pos.col;
  while (col < line.length && !((line[col] ?? "") in BRACKETS)) col += 1;
  if (col >= line.length) return null;
  const open = line[col]!;
  const { match, forward } = BRACKETS[open]!;
  const value = text.value;
  let depth = 0;
  for (
    let offset = text.offset({ line: pos.line, col });
    offset >= 0 && offset < value.length;
    offset += forward ? 1 : -1
  ) {
    if (value[offset] === open) depth += 1;
    else if (value[offset] === match && --depth === 0) return text.pos(offset);
  }
  return null;
}

/** `}` and `{`: the next or previous empty line, or the edge of the text. */
export function paragraphMotion(
  text: VimText,
  pos: VimPos,
  direction: 1 | -1,
  count: number,
): VimPos {
  let line = pos.line;
  const empty = (index: number) => text.line(index).length === 0;
  const edge = direction === 1 ? text.lastLine : 0;
  for (let step = 0; step < count && line !== edge; step += 1) {
    while (line !== edge && empty(line)) line += direction;
    while (line !== edge && !empty(line)) line += direction;
  }
  if (direction === 1 && line === edge && !empty(line)) {
    return { line, col: text.line(line).length };
  }
  return { line, col: 0 };
}

export interface ObjectRange {
  readonly start: VimPos;
  /** Exclusive. */
  readonly end: VimPos;
  readonly linewise: boolean;
}

/** iw/aw/iW/aW. A chip is a word of its own. */
export function wordObject(
  text: VimText,
  pos: VimPos,
  inner: boolean,
  big: boolean,
  count: number,
): ObjectRange | null {
  const value = text.line(pos.line);
  if (value.length === 0) return null;
  const runEnd = (from: number) => {
    let end = from;
    if (isBlankChar(value[end])) {
      while (end < value.length && isBlankChar(value[end])) end += 1;
      return end;
    }
    while (end + 1 < value.length && sameWord(value, end, end + 1, big)) end += 1;
    return end + 1;
  };
  let start = pos.col;
  const startsBlank = isBlankChar(value[start]);
  if (startsBlank) {
    while (start > 0 && isBlankChar(value[start - 1])) start -= 1;
  } else {
    while (start > 0 && sameWord(value, start - 1, start, big)) start -= 1;
  }
  let end = start;
  for (let index = 0; index < count && end < value.length; index += 1) {
    end = runEnd(end);
    // `aw` takes a word with the blanks after it, or blanks with the word after them.
    if (!inner && end < value.length && (startsBlank || isBlankChar(value[end]))) {
      end = runEnd(end);
    }
  }
  if (!inner && !startsBlank && !isBlankChar(value[end - 1])) {
    // No trailing blanks: take the leading ones instead.
    while (start > 0 && isBlankChar(value[start - 1])) start -= 1;
  }
  return {
    start: { line: pos.line, col: start },
    end: { line: pos.line, col: end },
    linewise: false,
  };
}

/** i" a" and the other quotes, within the cursor's line. */
export function quoteObject(
  text: VimText,
  pos: VimPos,
  quote: string,
  inner: boolean,
): ObjectRange | null {
  const line = text.line(pos.line);
  const quotes: number[] = [];
  for (let col = 0; col < line.length; col += 1) {
    if (line[col] === quote && line[col - 1] !== "\\") quotes.push(col);
  }
  let open = -1;
  let close = -1;
  for (let index = 0; index + 1 < quotes.length; index += 2) {
    const left = quotes[index]!;
    const right = quotes[index + 1]!;
    if (pos.col <= right) {
      open = left;
      close = right;
      break;
    }
  }
  if (open < 0) return null;
  if (inner) {
    return {
      start: { line: pos.line, col: open + 1 },
      end: { line: pos.line, col: close },
      linewise: false,
    };
  }
  let start = open;
  let end = close + 1;
  if (isBlankChar(line[end])) {
    while (isBlankChar(line[end])) end += 1;
  } else {
    while (start > 0 && isBlankChar(line[start - 1])) start -= 1;
  }
  return {
    start: { line: pos.line, col: start },
    end: { line: pos.line, col: end },
    linewise: false,
  };
}

const PAIRS: Record<string, [string, string]> = {
  "(": ["(", ")"],
  ")": ["(", ")"],
  b: ["(", ")"],
  "[": ["[", "]"],
  "]": ["[", "]"],
  "{": ["{", "}"],
  "}": ["{", "}"],
  B: ["{", "}"],
  "<": ["<", ">"],
  ">": ["<", ">"],
};

export function isBracketObject(name: string): boolean {
  return name in PAIRS;
}

/** i( a( and friends, across lines. */
export function bracketObject(
  text: VimText,
  pos: VimPos,
  name: string,
  inner: boolean,
  count: number,
): ObjectRange | null {
  const [open, close] = PAIRS[name]!;
  const value = text.value;
  const cursor = text.offset(pos);
  let openAt = -1;
  let depth = 0;
  let remaining = count;
  // The cursor on an opener belongs to that pair.
  for (let offset = value[cursor] === open ? cursor : cursor - 1; offset >= 0; offset -= 1) {
    if (value[offset] === close && offset !== cursor) depth += 1;
    else if (value[offset] === open) {
      if (depth > 0) depth -= 1;
      else if (--remaining === 0) {
        openAt = offset;
        break;
      }
    }
  }
  if (openAt < 0) return null;
  let closeAt = -1;
  depth = 0;
  for (let offset = openAt + 1; offset < value.length; offset += 1) {
    if (value[offset] === open) depth += 1;
    else if (value[offset] === close) {
      if (depth === 0) {
        closeAt = offset;
        break;
      }
      depth -= 1;
    }
  }
  if (closeAt < 0) return null;
  if (!inner) {
    return { start: text.pos(openAt), end: text.pos(closeAt + 1), linewise: false };
  }
  let start = openAt + 1;
  let end = closeAt;
  // A block whose brackets sit on their own lines keeps those lines.
  if (value[start] === "\n") start += 1;
  const endPos = text.pos(end);
  if (
    endPos.col > 0 &&
    /^[ \t]*$/.test(text.line(endPos.line).slice(0, endPos.col)) &&
    end > start
  ) {
    end = text.offset({ line: endPos.line, col: 0 }) - 1;
  }
  return { start: text.pos(start), end: text.pos(Math.max(start, end)), linewise: false };
}

/** ip/ap: a run of non-empty lines, or of empty lines. */
export function paragraphObject(
  text: VimText,
  pos: VimPos,
  inner: boolean,
  count: number,
): ObjectRange {
  const empty = (index: number) => text.line(index).length === 0;
  let first = pos.line;
  const kind = empty(first);
  while (first > 0 && empty(first - 1) === kind) first -= 1;
  let last = pos.line;
  const extendRun = () => {
    const runKind = empty(last);
    while (last < text.lastLine && empty(last + 1) === runKind) last += 1;
  };
  extendRun();
  for (let index = 1; index < count && last < text.lastLine; index += 1) {
    last += 1;
    extendRun();
  }
  if (!inner) {
    if (last < text.lastLine) {
      last += 1;
      extendRun();
    } else {
      while (first > 0 && empty(first - 1) !== kind) first -= 1;
    }
  }
  return {
    start: { line: first, col: 0 },
    end: { line: last, col: text.line(last).length },
    linewise: true,
  };
}
