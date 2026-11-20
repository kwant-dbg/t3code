// Vim's default "magic" patterns: `( ) | + ? { }` are literal and their backslashed forms are
// operators, the reverse of JavaScript. `\<` and `\>` are word edges; `\c` and `\C` set case.
const MAGIC_OPERATORS: Record<string, string> = {
  "(": "(",
  ")": ")",
  "|": "|",
  "+": "+",
  "=": "?",
  "?": "?",
  "{": "{",
  "}": "}",
  "<": "\\b",
  ">": "\\b",
};
const LITERAL_IN_MAGIC = new Set(["(", ")", "|", "+", "?", "{", "}"]);

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** A vim search pattern as a JavaScript regex; invalid patterns search for their literal text. */
export function compileVimPattern(pattern: string): RegExp {
  let ignoreCase = false;
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "\\" && index + 1 < pattern.length) {
      const next = pattern[index + 1]!;
      index += 1;
      if (next === "c" || next === "C") ignoreCase = next === "c";
      else source += MAGIC_OPERATORS[next] ?? `\\${next}`;
    } else if (LITERAL_IN_MAGIC.has(char)) source += `\\${char}`;
    else source += char;
  }
  const flags = ignoreCase ? "gmi" : "gm";
  try {
    return new RegExp(source, flags);
  } catch {
    return new RegExp(escapeRegExp(pattern.replace(/\\[cC]/g, "")), flags);
  }
}

/** `*` and `#` search a keyword, which holds no pattern characters, as a whole word. */
export const wholeWordPattern = (keyword: string) => `\\<${keyword}\\>`;

/**
 * The offset of the `count`th match after (or before) `from`, wrapping at the ends as vim's
 * `wrapscan` does. Null when the pattern matches nowhere.
 */
export function searchOffset(
  text: string,
  pattern: RegExp,
  from: number,
  backward: boolean,
  count: number,
): number | null {
  const starts: number[] = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    starts.push(match.index);
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  if (starts.length === 0) return null;
  let offset = from;
  for (let step = 0; step < count; step += 1) {
    if (backward) {
      const before = starts.findLast((start) => start < offset);
      offset = before ?? starts.at(-1)!;
    } else {
      const after = starts.find((start) => start > offset);
      offset = after ?? starts[0]!;
    }
  }
  return offset;
}

const isKeywordChar = (char: string | undefined) =>
  char !== undefined && /[\p{L}\p{N}_]/u.test(char);

/** The keyword under or after the cursor on its line, as `*` picks it. */
export function keywordAt(line: string, col: number): { start: number; text: string } | null {
  let start = col;
  while (start < line.length && !isKeywordChar(line[start])) start += 1;
  if (start >= line.length) return null;
  while (start > 0 && isKeywordChar(line[start - 1])) start -= 1;
  let end = start;
  while (end < line.length && isKeywordChar(line[end])) end += 1;
  return { start, text: line.slice(start, end) };
}
