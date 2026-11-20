import { describe, expect, it } from "vite-plus/test";

import {
  VimEngine,
  type VimBuffer,
  type VimMode,
  type VimPasteRequest,
  type VimYank,
} from "./engine";
import { VimRegisters } from "./registers";
import { clampToLine, firstNonBlankCol, lastCharCol, VIM_CHIP, type VimPos, VimText } from "./text";

/** `◆` stands for a chip in test strings. */
const CHIP = "◆";

interface Snapshot {
  lines: string[];
  cursor: VimPos;
}

class TextBuffer implements VimBuffer<string> {
  lines_: string[];
  cursor_: VimPos;
  anchor: VimPos | null = null;
  visualLinewise = false;
  /** The system clipboard's text. */
  clipboard: string | null = null;
  history_: Array<1 | -1> = [];
  undoStack: Snapshot[] = [];
  redoStack: Snapshot[] = [];
  #goal: number | null = null;
  #insertBefore: string | null = null;
  #commandBefore: Snapshot | null = null;
  #historyMoved = false;

  constructor(lines: string[], cursor: VimPos) {
    this.lines_ = lines;
    this.cursor_ = cursor;
  }

  get text(): VimText {
    return new VimText(this.lines_);
  }

  snapshot(): Snapshot {
    return { lines: [...this.lines_], cursor: this.cursor_ };
  }

  #setText(value: string): void {
    this.lines_ = value.split("\n");
  }

  beginCommand(): void {
    this.#commandBefore = this.snapshot();
  }

  endCommand(mode: VimMode): void {
    // An Insert or Replace session ends the command that opened it.
    if (mode === "insert" || mode === "replace") return;
    const before = this.#commandBefore;
    this.#commandBefore = null;
    const moved = this.#historyMoved;
    this.#historyMoved = false;
    if (!before || moved) return;
    if (before.lines.join("\n") !== this.lines_.join("\n")) {
      this.undoStack.push(before);
      this.redoStack = [];
    }
  }

  lines() {
    return this.lines_;
  }
  cursor() {
    return this.cursor_;
  }
  setCursor(pos: VimPos) {
    this.cursor_ = pos;
    this.anchor = null;
  }
  visualAnchor() {
    return this.anchor;
  }
  setVisual(anchor: VimPos, head: VimPos, linewise: boolean) {
    this.anchor = anchor;
    this.cursor_ = head;
    this.visualLinewise = linewise;
  }
  screenLine(from: VimPos, direction: 1 | -1, count: number, keepGoal: boolean) {
    if (!keepGoal || this.#goal === null) this.#goal = from.col;
    const edge = direction === 1 ? this.lines_.length - 1 : 0;
    if (from.line === edge) return null;
    const line = Math.max(0, Math.min(this.lines_.length - 1, from.line + direction * count));
    return { line, col: Math.min(this.#goal, lastCharCol(this.lines_[line]!)) };
  }
  history(direction: 1 | -1) {
    this.history_.push(direction);
  }
  deleteRange(from: VimPos, to: VimPos) {
    const text = this.text;
    this.#setText(text.value.slice(0, text.offset(from)) + text.value.slice(text.offset(to)));
  }
  deleteLines(first: number, last: number) {
    this.lines_.splice(first, last - first + 1);
    if (this.lines_.length === 0) this.lines_ = [""];
  }
  replaceRange(from: VimPos, to: VimPos, value: string) {
    const text = this.text;
    this.#setText(
      text.value.slice(0, text.offset(from)) + value + text.value.slice(text.offset(to)),
    );
  }
  openLine(line: number, below: boolean) {
    const index = below ? line + 1 : line;
    this.lines_.splice(index, 0, "");
    return { line: index, col: 0 };
  }
  transformText(from: VimPos, to: VimPos, transform: (value: string) => string) {
    const text = this.text;
    const start = text.offset(from);
    const end = text.offset(to);
    this.#setText(
      text.value.slice(0, start) + transform(text.value.slice(start, end)) + text.value.slice(end),
    );
  }
  indentLines(first: number, last: number, direction: 1 | -1) {
    for (let line = first; line <= last; line += 1) {
      const value = this.lines_[line]!;
      this.lines_[line] = direction === 1 ? `  ${value}` : value.replace(/^ {1,2}/, "");
    }
  }
  read(from: VimPos, to: VimPos, linewise: boolean): VimYank {
    const text = this.text;
    const value = text.value.slice(text.offset(from), text.offset(to));
    return { text: linewise ? `${value}\n` : value, linewise };
  }
  writeClipboard(yank: VimYank) {
    this.clipboard = yank.text;
  }
  paste(request: VimPasteRequest) {
    const { source } = request;
    const register = source.type === "register" ? source.yank : source.resolve(this.clipboard);
    if (!register) return;
    let at = request.at;
    if (request.replace) {
      if (request.replace.linewise) {
        this.deleteLines(request.replace.from.line, request.replace.to.line);
        at = { line: request.replace.from.line, col: 0 };
        if (!register.linewise) {
          this.lines_.splice(at.line, 0, "");
        }
      } else {
        this.deleteRange(request.replace.from, request.replace.to);
      }
    }
    if (register.linewise) {
      const pasted = register.text.replace(/\n$/, "").split("\n");
      const lines = Array.from({ length: request.count }, () => pasted).flat();
      const index = request.replace?.linewise ? at.line : request.before ? at.line : at.line + 1;
      this.lines_.splice(index, 0, ...lines);
      this.cursor_ = { line: index, col: firstNonBlankCol(this.lines_[index]!) };
      return;
    }
    const value = register.text.repeat(request.count);
    const line = this.lines_[at.line]!;
    const col = request.before || request.replace || line.length === 0 ? at.col : at.col + 1;
    const text = this.text;
    const offset = text.offset({ line: at.line, col });
    this.#setText(text.value.slice(0, offset) + value + text.value.slice(offset));
    this.cursor_ = this.text.pos(offset + value.length - 1);
  }
  undo(count: number) {
    this.#historyMoved = true;
    for (let index = 0; index < count; index += 1) {
      const snapshot = this.undoStack.pop();
      if (!snapshot) return;
      this.redoStack.push(this.snapshot());
      this.lines_ = snapshot.lines;
      this.cursor_ = snapshot.cursor;
    }
  }
  redo(count: number) {
    this.#historyMoved = true;
    for (let index = 0; index < count; index += 1) {
      const snapshot = this.redoStack.pop();
      if (!snapshot) return;
      this.undoStack.push(this.snapshot());
      this.lines_ = snapshot.lines;
      this.cursor_ = snapshot.cursor;
    }
  }
  beginInsert() {
    this.#insertBefore = this.text.value;
  }
  endInsert() {
    const before = this.#insertBefore;
    this.#insertBefore = null;
    if (before === null) return null;
    const after = this.text.value;
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start])
      start += 1;
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
  insert(insertion: string) {
    const text = this.text;
    const offset = text.offset(this.cursor_);
    this.#setText(text.value.slice(0, offset) + insertion + text.value.slice(offset));
    this.cursor_ = this.text.pos(offset + insertion.length);
  }
  type(key: string) {
    const text = this.text;
    const offset = text.offset(this.cursor_);
    if (key === "<BS>") {
      if (offset === 0) return;
      this.#setText(text.value.slice(0, offset - 1) + text.value.slice(offset));
      this.cursor_ = this.text.pos(offset - 1);
      return;
    }
    const char = key === "<CR>" ? "\n" : key;
    this.#setText(text.value.slice(0, offset) + char + text.value.slice(offset));
    this.cursor_ = this.text.pos(offset + 1);
  }
}

function parseState(marked: string): { lines: string[]; cursor: VimPos } {
  const value = marked.replaceAll(CHIP, VIM_CHIP);
  const offset = value.indexOf("|");
  const text = value.replace("|", "");
  const lines = text.split("\n");
  const cursor = offset < 0 ? { line: 0, col: 0 } : new VimText(lines).pos(offset);
  return { lines, cursor };
}

function render(buffer: TextBuffer): string {
  const text = buffer.text;
  const offset = text.offset(buffer.cursor_);
  return (text.value.slice(0, offset) + "|" + text.value.slice(offset)).replaceAll(VIM_CHIP, CHIP);
}

function tokenize(keys: string): string[] {
  return keys.match(/<[^>]+>|[\s\S]/g) ?? [];
}

function run(
  before: string,
  keys: string,
  options: { startInsert?: boolean; registers?: VimRegisters; clipboard?: string } = {},
) {
  const { lines, cursor } = parseState(before);
  const buffer = new TextBuffer(lines, cursor);
  if (options.clipboard !== undefined) buffer.clipboard = options.clipboard;
  const engine = new VimEngine(buffer, options.registers ?? new VimRegisters());
  if (options.startInsert) buffer.beginCommand();
  else engine.escape();
  // Esc steps left; tests mark the Normal cursor directly.
  buffer.cursor_ = clampToLine(buffer.lines_, cursor, options.startInsert);
  for (const key of tokenize(keys)) {
    if (engine.mode === "insert") {
      // Typing in Insert belongs to the editor, not the engine.
      if (key === "<Esc>") {
        engine.escape();
        buffer.endCommand(engine.mode);
      } else buffer.type(key);
      continue;
    }
    if (engine.mode !== "replace") buffer.beginCommand();
    engine.feed(key);
    buffer.endCommand(engine.mode);
  }
  return { buffer, engine };
}

function expectKeys(before: string, keys: string, after: string, mode: VimMode = "normal") {
  const { buffer, engine } = run(before, keys);
  expect({ text: render(buffer), mode: engine.mode }).toEqual({ text: after, mode });
}

describe("VimEngine motions", () => {
  it.each([
    ["h l", "ab|cd", "hh", "|abcd"],
    ["l stops on the last char", "ab|cd", "5l", "abc|d"],
    ["count before motion", "|one two three four", "2w", "one two |three four"],
    ["w crosses lines", "one |two\nthree", "w", "one two\n|three"],
    ["w stops on an empty line", "|one\n\ntwo", "w", "one\n|\ntwo"],
    ["w on the last word goes to the end", "one t|wo", "w", "one tw|o"],
    ["w splits punctuation", "|foo.bar", "w", "foo|.bar"],
    ["W skips punctuation", "|foo.bar baz", "W", "foo.bar |baz"],
    ["e", "|one two", "e", "on|e two"],
    ["e from a word end", "on|e two", "e", "one tw|o"],
    ["b", "one two t|hree", "b", "one two |three"],
    ["b twice", "one two t|hree", "2b", "one |two three"],
    ["B", "a foo.ba|r", "B", "a |foo.bar"],
    ["0 ^ $", "  ab|cd", "0", "|  abcd"],
    ["^", "  ab|cd", "^", "  |abcd"],
    ["$", "  ab|cd ef", "$", "  abcd e|f"],
    ["gg", "one\ntwo\n  th|ree", "gg", "|one\ntwo\n  three"],
    [
      "G goes to the first non-blank of the last line",
      "o|ne\ntwo\n  three",
      "G",
      "one\ntwo\n  |three",
    ],
    ["count G", "o|ne\n  two\nthree", "2G", "one\n  |two\nthree"],
    ["f", "|a,b,c", "f,", "a|,b,c"],
    ["2f", "|a,b,c", "2f,", "a,b|,c"],
    ["t", "|a,b,c", "t,", "|a,b,c"],
    ["t from before", "|ab,c", "t,", "a|b,c"],
    ["F", "a,b,|c", "F,", "a,b|,c"],
    ["T", "a,b,|c", "T,", "a,b,|c"],
    [";", "|a,b,c", "f,;", "a,b|,c"],
    [", reverses", "|a,b,c", "f,;,", "a|,b,c"],
    ["; after t moves past the adjacent target", "|a,b,c", "t,;", "a,|b,c"],
    ["%", "|if (a(b)) x", "%", "if (a(b)|) x"],
    ["% back", "if (a(b)|) x", "%", "if |(a(b)) x"],
    ["}", "|one\ntwo\n\nthree", "}", "one\ntwo\n|\nthree"],
    ["} at the end", "one\n|two", "}", "one\ntw|o"],
    ["{", "one\n\ntwo\nth|ree", "{", "one\n|\ntwo\nthree"],
    ["j keeps its column", "abc|d\nef\nghij", "jj", "abcd\nef\nghi|j"],
    ["k", "ab\nc|d", "k", "a|b\ncd"],
    ["$ then j stays at the end", "a|b\ncdef", "$j", "ab\ncde|f"],
    ["arrows", "a|b\ncd", "<Right><Down>", "ab\nc|d"],
  ])("%s", (_name, before, keys, after) => {
    expectKeys(before, keys, after);
  });

  it("w treats every chip as its own word", () => {
    expectKeys(`|see ${CHIP}${CHIP}now`, "w", `see |${CHIP}${CHIP}now`);
    expectKeys(`see |${CHIP}${CHIP}now`, "w", `see ${CHIP}|${CHIP}now`);
    expectKeys(`see ${CHIP}|${CHIP}now`, "W", `see ${CHIP}${CHIP}|now`);
  });

  it("k on the first line and j on the last ask for prompt history", () => {
    const up = run("o|ne\ntwo", "k");
    expect(up.buffer.history_).toEqual([-1]);
    const down = run("one\nt|wo", "j");
    expect(down.buffer.history_).toEqual([1]);
    const middle = run("one\nt|wo\nthree", "j");
    expect(middle.buffer.history_).toEqual([]);
  });
});

describe("VimEngine edits", () => {
  it.each([
    ["x", "a|bc", "x", "a|c"],
    ["3x", "a|bcde", "3x", "a|e"],
    ["x at the end moves left", "ab|c", "x", "a|b"],
    ["X", "ab|c", "X", "a|c"],
    ["x on a chip removes the whole chip", `a|${CHIP}b`, "x", "a|b"],
    ["dw", "one |two three", "dw", "one |three"],
    ["d2w", "|one two three", "d2w", "|three"],
    ["2dw", "|one two three", "2dw", "|three"],
    [
      "dw on the last word of a line keeps the line break",
      "one t|wo\nthree",
      "dw",
      "one |t\nthree",
    ],
    ["dw at the start of the last word", "one |two\nthree", "dw", "one| \nthree"],
    ["de", "|one two", "de", "| two"],
    ["db", "one tw|o", "db", "one |o"],
    ["d$", "on|e two", "d$", "o|n"],
    ["D", "on|e two", "D", "o|n"],
    ["d0", "one t|wo", "d0", "|wo"],
    ["dt", "|a,b,c", "dt,", "|,b,c"],
    ["df", "|a,b,c", "df,", "|b,c"],
    ["dd", "one\nt|wo\nthree", "dd", "one\n|three"],
    ["dd keeps the indent column", "one\nt|wo\n  three", "dd", "one\n  |three"],
    ["dd on the last line", "one\nt|wo", "dd", "|one"],
    ["dd on the only line", "o|ne", "dd", "|"],
    ["2dd", "|one\ntwo\nthree", "2dd", "|three"],
    ["dj", "|one\ntwo\nthree", "dj", "|three"],
    ["dk", "one\n|two\nthree", "dk", "|three"],
    ["dG", "one\n|two\nthree", "dG", "|one"],
    ["dgg", "one\ntwo\n|three", "dgg", "|"],
    ["d} from a line start is linewise", "|one\ntwo\n\nthree", "d}", "|\nthree"],
    ["d} from mid line stops at the line end", "o|ne\ntwo\n\nthree", "d}", "|o\n\nthree"],
    ["diw", "foo b|ar baz", "diw", "foo | baz"],
    ["daw", "foo b|ar baz", "daw", "foo |baz"],
    ["daw at the end takes the leading space", "foo b|ar", "daw", "fo|o"],
    ["diw on a chip", `a ${CHIP}| b`, "hdiw", "a | b"],
    ["di(", "f(a, |b)", "di(", "f(|)"],
    ["da(", "f(a, |b) x", "da(", "f| x"],
    ["di( across lines", "f(\n  a|b\n)", "di(", "f(\n|)"],
    ["di{ from the brace", "|{ab}", "di{", "{|}"],
    ['di"', 'say "he|llo" now', 'di"', 'say "|" now'],
    ['da"', 'say "he|llo" now', 'da"', "say |now"],
    ['di" before the quotes', 'sa|y "hello"', 'di"', 'say "|"'],
    ["dip", "one\n|two\n\nthree", "dip", "|\nthree"],
    ["dap", "one\n|two\n\nthree", "dap", "|three"],
    ["d%", "a |(b) c", "d%", "a | c"],
    ["r", "a|bc", "rx", "a|xc"],
    ["3r", "|abcd", "3rx", "xx|xd"],
    ["r past the end does nothing", "a|b", "3rx", "a|b"],
    ["~", "|ab", "~~", "A|B"],
    ["g~w", "|ab Cd", "g~w", "|AB Cd"],
    ["gUiw", "a|bc d", "gUiw", "|ABC d"],
    ["guu", "A|BC\nD", "guu", "a|bc\nD"],
    ["gUgU", "a|bc", "gUgU", "A|BC"],
    ["J", "o|ne\n  two", "J", "one| two"],
    ["J with a count", "|a\nb\nc", "3J", "a b| c"],
    ["J after a trailing space", "|a \nb", "J", "a |b"],
    ["J before )", "|a\n)", "J", "a|)"],
    ["gJ", "|a\n  b", "gJ", "a|  b"],
    [">>", "|a\nb", ">>", "  |a\nb"],
    ["2>>", "|a\nb", "2>>", "  |a\n  b"],
    ["<<", "    |a", "<<", "  |a"],
    [">j", "|a\nb\nc", ">j", "  |a\n  b\nc"],
  ])("%s", (_name, before, keys, after) => {
    expectKeys(before, keys, after);
  });
});

describe("VimEngine Insert entries", () => {
  it.each([
    ["i", "a|bc", "ix<Esc>", "a|xbc"],
    ["a", "a|bc", "ax<Esc>", "ab|xc"],
    ["a on an empty line", "|", "ax<Esc>", "|x"],
    ["I", "  a|bc", "Ix<Esc>", "  |xabc"],
    ["A", "a|bc", "Axy<Esc>", "abcx|y"],
    ["o", "a|b\nc", "ox<Esc>", "ab\n|x\nc"],
    ["O", "ab\n|c", "Ox<Esc>", "ab\n|x\nc"],
    ["s", "a|bc", "sx<Esc>", "a|xc"],
    ["S", "  a|bc\nd", "Sx<Esc>", "|x\nd"],
    ["cc", "a|bc\nd", "ccx<Esc>", "|x\nd"],
    ["C", "a|bc", "Cx<Esc>", "a|x"],
    ["C on an empty line", "a\n|", "Cx<Esc>", "a\n|x"],
    ["cw changes to the word end", "|one two", "cwx<Esc>", "|x two"],
    ["cw on the last char of a word", "on|e two", "cwx<Esc>", "on|x two"],
    ["c2w", "|one two three", "c2wx<Esc>", "|x three"],
    ["ciw", "a b|cd e", "ciwx<Esc>", "a |x e"],
    ["ci(", "f(a|b)", "ci(x<Esc>", "f(|x)"],
    ["ci( on empty parens", "f|()", "ci(x<Esc>", "f(|x)"],
    ["3i", "|a", "3ix<Esc>", "xx|xa"],
    ["3o opens three lines", "|a\nb", "3ox<Esc>", "a\nx\nx\n|x\nb"],
    ["2O opens two lines above", "a\n|b", "2Ox<Esc>", "a\nx\n|x\nb"],
    ["Esc at the line start stays", "|ab", "i<Esc>", "|ab"],
    ["typing then backspace", "|ab", "ixy<BS><Esc>", "|xab"],
  ])("%s", (_name, before, keys, after) => {
    expectKeys(before, keys, after);
  });

  it("enters Insert for Insert entries", () => {
    expectKeys("a|b", "a", "ab|", "insert");
    expectKeys("a|b", "cw", "a|", "insert");
  });
});

describe("VimEngine registers and paste", () => {
  it.each([
    ["yy p", "|one\ntwo", "yyp", "one\n|one\ntwo"],
    ["yy P", "one\n|two", "yyP", "one\n|two\ntwo"],
    ["dd p swaps lines", "|one\ntwo", "ddp", "two\n|one"],
    ["yw p", "|one two", "ywP", "one| one two"],
    ["x p swaps characters", "|ab", "xp", "b|a"],
    ["yiw then p with a count", "|ab", "yiw2p", "aaba|bb"],
    ["Y is linewise", "|ab\ncd", "Yjp", "ab\ncd\n|ab"],
    ["y moves to the start of a backward range", "one tw|o", "yb", "one |two"],
  ])("%s", (_name, before, keys, after) => {
    expectKeys(before, keys, after);
  });
});

describe("VimEngine named registers", () => {
  it.each([
    ['"a keeps a yank out of the clipboard', "|one\ntwo", '"ayyj"ap', "one\ntwo\n|one"],
    ['"A appends charwise text', "|ab cd", '"ayiww"Ayiw$"ap', "ab cdabc|d"],
    ['"A appends a line to a word', "|ab\ncd", '"ayiwj"Ayy"ap', "ab\ncd\n|ab\ncd"],
    ["count before the register", "|a\nb\nc", '2"ayyG"ap', "a\nb\nc\n|a\nb"],
    ["count after the register", "|a\nb\nc", '"a2yyG"ap', "a\nb\nc\n|a\nb"],
    ['"0 keeps the last yank through a delete', "|one\ntwo", 'yyjdd"0p', "one\n|one"],
    ['"+ is the clipboard', "|one\ntwo", '"+yyjp', "one\ntwo\n|one"],
    ["visual yank into a register", "|abc", 'vl"ay$"ap', "abca|b"],
    ['. repeats a put from "a', "|x\ny", '"ayyj"ap.', "x\ny\nx\n|x"],
    ["an empty register puts nothing", "a|b", '"zp', "a|b"],
  ])("%s", (_name, before, keys, after) => {
    expectKeys(before, keys, after);
  });

  it("writes the unnamed register to the clipboard and the black hole nowhere", () => {
    const yanked = run("|one\ntwo", "yy");
    expect(yanked.buffer.clipboard).toBe("one\n");
    const kept = run("|one\ntwo", '"_dd', { clipboard: "kept" });
    expect(kept.buffer.clipboard).toBe("kept");
    expect(render(kept.buffer)).toBe("|two");
  });

  it("puts clipboard text from other apps by its trailing newline", () => {
    const charwise = run("|ab", "p", { clipboard: "XY" });
    expect(render(charwise.buffer)).toBe("aX|Yb");
    const linewise = run("|ab", "p", { clipboard: "XY\n" });
    expect(render(linewise.buffer)).toBe("ab\n|XY");
  });

  it("shares registers between editors", () => {
    const registers = new VimRegisters();
    run("|shared", '"ayiw', { registers });
    const other = run("|x", '"ap', { registers });
    expect(render(other.buffer)).toBe("xshare|d");
  });
});

describe("VimEngine search", () => {
  it.each([
    ["/ moves to the next match", "|one two one two", "/two<CR>", "one |two one two"],
    ["n repeats forward", "|one two one two", "/two<CR>n", "one two one |two"],
    ["N reverses", "|one two one two", "/two<CR>nN", "one |two one two"],
    ["? searches backward", "one two one tw|o", "?one<CR>", "one two |one two"],
    ["n after ? keeps going backward", "one two one tw|o", "?one<CR>n", "|one two one two"],
    ["search wraps around", "one t|wo", "/one<CR>", "|one two"],
    ["search crosses lines", "|ab\ncd", "/c<CR>", "ab\n|cd"],
    ["a count finds the nth match", "|a1 a2 a3", "/a<CR>", "a1 |a2 a3"],
    ["2/ skips a match", "|a1 a2 a3", "2/a<CR>", "a1 a2 |a3"],
    ["no match stays", "a|b", "/zz<CR>", "a|b"],
    ["an empty pattern repeats the last", "|xa xb xc", "/x<CR>/<CR>", "xa xb |xc"],
    ["Esc cancels the search", "|ab ab", "/b<Esc>", "|ab ab"],
    ["Backspace edits the pattern", "|ab cd", "/cx<BS><CR>", "ab |cd"],
    ["Backspace on an empty pattern cancels", "|ab cd", "/<BS>x", "|b cd"],
    ["d/ deletes up to the match", "|one two three", "d/thr<CR>", "|three"],
    ["c/ changes up to the match", "|one two", "c/two<CR>x<Esc>", "|xtwo"],
    ["v/ extends the selection", "|one two", "v/tw<CR>d", "|wo"],
    ["* finds the word under the cursor", "f|oo bar foo", "*", "foo bar |foo"],
    ["* matches whole words", "|foo food foo", "*", "foo food |foo"],
    ["# finds the previous one", "foo bar f|oo", "#", "|foo bar foo"],
    ["n after * repeats it", "|ab x ab x ab", "*n", "ab x ab x |ab"],
    ["\\| is alternation", "|xa yb", "/b\\|y<CR>", "xa |yb"],
    ["( is literal", "|f(x) g(y)", "/g(<CR>", "f(x) |g(y)"],
    ["\\> marks a word end", "|abx ab", "/ab\\><CR>", "abx |ab"],
    ["\\c ignores case", "|a B b", "/\\cb<CR>", "a |B b"],
    ["case matters by default", "|a B b", "/b<CR>", "a B |b"],
    ["an invalid regex searches literally", "|a [b", "/[b<CR>", "a |[b"],
  ])("%s", (_name, before, keys, after) => {
    expectKeys(before, keys, after);
  });

  it("shows the pattern as it is typed", () => {
    const typing = run("|ab", "d/x");
    expect(typing.engine.pendingKeys).toBe("d/x");
    expect(typing.engine.commandLineOpen).toBe(true);
    expect(run("|ab", "/x<CR>").engine.commandLineOpen).toBe(false);
  });
});

describe("VimEngine replace mode", () => {
  it.each([
    ["R types over text", "|abcd", "Rxy<Esc>", "x|ycd"],
    ["R extends past the line end", "a|b", "Rxyz<Esc>", "axy|z"],
    ["Backspace brings the text back", "|abcd", "Rxy<BS><Esc>", "|xbcd"],
    ["Backspace before the start only moves", "a|bc", "R<BS>x<Esc>", "|xbc"],
    ["a count repeats the typed text", "|abcdef", "2Rxy<Esc>", "xyx|yef"],
    [". repeats the replacement", "|abcdef", "Rxy<Esc>l.", "xyx|yef"],
    ["R never types over a chip", `|a${CHIP}b`, "Rxyz<Esc>", `xy|z${CHIP}b`],
    ["one Replace session is one undo step", "|abcd", "Rxyz<Esc>u", "|abcd"],
  ])("%s", (_name, before, keys, after) => {
    expectKeys(before, keys, after);
  });

  it("is its own mode until Esc", () => {
    expect(run("|ab", "Rx").engine.mode).toBe("replace");
    expect(run("|ab", "Rx<Esc>").engine.mode).toBe("normal");
  });
});

describe("VimEngine numbers", () => {
  it.each([
    ["ctrl+a adds one", "x |9 y", "<C-a>", "x 1|0 y"],
    ["ctrl+a finds the number after the cursor", "|v 41", "<C-a>", "v 4|2"],
    ["a count adds that many", "|1", "5<C-a>", "|6"],
    ["ctrl+x goes below zero", "|1", "3<C-x>", "-|2"],
    ["a minus sign makes it negative", "x -|3", "<C-a>", "x -|2"],
    ["hex keeps its width and case", "|0x0f 0xFF", "<C-a>w<C-a>", "0x10 0x10|0"],
    ["leading zeros keep the width", "|007", "<C-a>", "00|8"],
    ["no number does nothing", "|abc", "<C-a>", "|abc"],
    [". repeats it", "|1", "2<C-a>.", "|5"],
  ])("%s", (_name, before, keys, after) => {
    expectKeys(before, keys, after);
  });
});

describe("VimEngine undo and repeat", () => {
  it.each([
    ["u", "a|bc", "xu", "a|bc"],
    ["u then redo", "a|bc", "xu<C-r>", "a|c"],
    ["one Insert session is one undo step", "|ab", "ixy<Esc>Az<Esc>u", "x|yab"],
    ["a change with its typed text undoes together", "|one two", "cwxyz<Esc>u", "|one two"],
    [". repeats x", "|abcd", "x.", "|cd"],
    [". repeats dw", "|a b c d", "dw.", "|c d"],
    [". repeats cw with its text", "|a b c", "cwx<Esc>w.", "x |x c"],
    [". repeats A", "|a\nb", "A;<Esc>j.", "a;\nb|;"],
    [". repeats o", "|a", "ox<Esc>.", "a\nx\n|x"],
    [". repeats a counted o", "|a", "2ox<Esc>.", "a\nx\nx\nx\n|x"],
    ["count . replaces the count", "|abcdef", "2x3.", "|f"],
    [". repeats a visual delete over the same width", "|abcdef", "vld.", "|ef"],
    [". repeats a visual line delete", "|a\nb\nc\nd\ne", "Vjd.", "|e"],
  ])("%s", (_name, before, keys, after) => {
    expectKeys(before, keys, after);
  });
});

describe("VimEngine visual mode", () => {
  it.each([
    ["v d", "a|bcd", "vld", "a|d"],
    ["v backwards", "ab|cd", "vhd", "a|d"],
    ["v across lines", "a|b\ncd", "vjd", "|a"],
    ["V d", "a\n|b\nc", "Vd", "a\n|c"],
    ["V j d", "|a\nb\nc", "Vjd", "|c"],
    ["v o swaps the moving end", "a|bcd", "vlohd", "|d"],
    ["v y", "a|bcd", "vly$p", "abcdb|c"],
    ["v c", "a|bcd", "vlcx<Esc>", "a|xd"],
    ["v ~", "|ab", "vl~", "|AB"],
    ["v U", "|ab", "vlU", "|AB"],
    ["v u", "|AB", "vlu", "|ab"],
    ["v J", "|a\nb\nc", "VjjJ", "a b| c"],
    ["v >", "|a\nb", "Vj>", "  |a\n  b"],
    ["viw", "a b|cd e", "viwd", "a | e"],
    ["vip is linewise", "a\nb\n\n|c\nd\n\ne", "vipd", "a\nb\n\n|\ne"],
    ["v Esc", "a|bc", "vl<Esc>", "ab|c"],
    ["v v exits", "a|bc", "vlv", "ab|c"],
    ["V then v is charwise", "a|bc\nd", "Vvld", "|a\nd"],
    ["v r", "|abc", "vlrx", "|xxc"],
    ["v p replaces the selection", "|ab cd", "yiwwviwp", "ab a|b"],
    ["gv selects the last selection again", "|abcd", "vl<Esc>$gvd", "|cd"],
    ["gv keeps linewise", "|a\nb\nc", "Vj<Esc>Ggvd", "|c"],
  ])("%s", (_name, before, keys, after) => {
    expectKeys(before, keys, after);
  });

  it("enters and leaves Visual modes", () => {
    expect(run("a|b", "v").engine.mode).toBe("visual");
    expect(run("a|b", "V").engine.mode).toBe("visual-line");
    expect(run("a|b", "vV").engine.mode).toBe("visual-line");
    expect(run("a|b", "vd").engine.mode).toBe("normal");
  });
});

describe("VimEngine key handling", () => {
  it("swallows unknown keys and waits for pending ones", () => {
    expectKeys("a|bc", "qzQ", "a|bc");
    const pending = run("a|bc", "2d");
    expect(pending.engine.pendingKeys).toBe("2d");
    expectKeys("a|bc", "d<Esc>x", "a|c");
  });

  it("Esc in Normal does nothing", () => {
    expectKeys("a|bc", "<Esc><Esc>", "a|bc");
  });
});
