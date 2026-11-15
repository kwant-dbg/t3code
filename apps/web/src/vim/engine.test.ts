import { describe, expect, it } from "vite-plus/test";

import { VimEngine, type VimBuffer, type VimMode, type VimPasteRequest } from "./engine";
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
  register: { text: string; linewise: boolean } | null = null;
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
    // An Insert session ends the command that opened it.
    if (mode === "insert") return;
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
  yank(from: VimPos, to: VimPos, linewise: boolean) {
    const text = this.text;
    const value = text.value.slice(text.offset(from), text.offset(to));
    this.register = { text: linewise ? `${value}\n` : value, linewise };
  }
  paste(request: VimPasteRequest) {
    const register = this.register;
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

function run(before: string, keys: string, options: { startInsert?: boolean } = {}) {
  const { lines, cursor } = parseState(before);
  const buffer = new TextBuffer(lines, cursor);
  const engine = new VimEngine(buffer);
  if (options.startInsert) buffer.beginCommand();
  else engine.escape();
  // Esc steps left; tests mark the Normal cursor directly.
  buffer.cursor_ = clampToLine(buffer.lines_, cursor, options.startInsert);
  for (const key of tokenize(keys)) {
    if (engine.mode === "insert") {
      if (key === "<Esc>") {
        engine.escape();
        buffer.endCommand(engine.mode);
      } else buffer.type(key);
      continue;
    }
    buffer.beginCommand();
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
