import { getSchemaByResolvedExtensions, Node, resolveExtensions } from "@tiptap/core";
import { TaskList } from "@tiptap/extension-task-list";
import StarterKit from "@tiptap/starter-kit";
import { history } from "@tiptap/pm/history";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, Plugin, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDocJson,
  ComposerBlockExtensions,
  ComposerCodeBlockExtension,
  ComposerCodeExtension,
  ComposerBoldExtension,
  ComposerListExtensions,
  ComposerTaskItemExtension,
  serializeEditorDoc,
} from "~/composer-rich-text-doc";
import { VimController } from "./controller";
import {
  pmToVimPos,
  type VimClipboard,
  vimLineIndex,
  vimPluginKey,
  vimPosToPm,
  vimStateField,
} from "./proseMirrorBuffer";
import { lastCharCol, type VimPos } from "./text";

function stubAtom(name: string, attrs: Record<string, { default: unknown }>) {
  return Node.create({
    name,
    group: "inline",
    inline: true,
    atom: true,
    addAttributes: () => attrs,
  });
}

const starterKit = StarterKit.configure({
  blockquote: false,
  bulletList: false,
  codeBlock: false,
  heading: false,
  horizontalRule: false,
  listItem: false,
  orderedList: false,
  dropcursor: false,
  gapcursor: false,
  trailingNode: false,
  code: false,
  bold: false,
  undoRedo: false,
});
const mention = stubAtom("composer-mention", { path: { default: "" }, source: { default: "" } });

const richSchema = getSchemaByResolvedExtensions(
  resolveExtensions([
    starterKit,
    ComposerCodeExtension,
    ComposerBoldExtension,
    mention,
    TaskList,
    ComposerTaskItemExtension,
    ComposerCodeBlockExtension,
    ...ComposerListExtensions,
    ...ComposerBlockExtensions,
  ]),
);
const plainSchema = getSchemaByResolvedExtensions(resolveExtensions([starterKit, mention]));

const skill = (name: string) => ({ label: name, description: null });

function setup(markdown: string, cursor: VimPos, options: { plain?: boolean } = {}) {
  const schema = options.plain ? plainSchema : richSchema;
  const parse = (value: string) =>
    ProseMirrorNode.fromJSON(schema, buildDocJson(value, skill, { styling: !options.plain }));
  let state = EditorState.create({
    doc: parse(markdown),
    plugins: [history(), new Plugin({ key: vimPluginKey, state: vimStateField })],
  });
  let clipboard: VimClipboard | null = null;
  let pasted: Promise<void> = Promise.resolve();
  const controller = new VimController({
    getState: () => state,
    dispatch: (tr) => {
      state = state.apply(tr);
    },
    screenLine: (pos, direction, count) => {
      const from = pmToVimPos(state.doc, pos);
      const { lines } = vimLineIndex(state.doc);
      const line = from.line + direction * count;
      if (line < 0 || line >= lines.length) return null;
      return vimPosToPm(state.doc, { line, col: Math.min(from.col, lastCharCol(lines[line]!)) });
    },
    history: () => {},
    writeClipboard: (value) => {
      clipboard = value;
    },
    readClipboard: () => {
      const read = Promise.resolve(clipboard);
      pasted = read.then(() => {});
      return read;
    },
    insertMarkdown: (text) => {
      state = state.apply(state.tr.insertText(text));
    },
    parseMarkdown: parse,
    beginUndoSession: () => {},
    endUndoSession: () => {},
  });
  controller.escape();
  state = state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, vimPosToPm(state.doc, cursor))),
  );

  const press = async (keys: string) => {
    for (const key of keys.match(/<[^>]+>|[\s\S]/g) ?? []) {
      if (controller.mode !== "insert") {
        controller.feed(key);
        await pasted;
        continue;
      }
      if (key === "<Esc>") controller.escape();
      else state = state.apply(state.tr.insertText(key));
    }
  };
  return {
    press,
    controller,
    get markdown() {
      return serializeEditorDoc(state.doc).value;
    },
    get cursor() {
      return pmToVimPos(state.doc, state.selection.head);
    },
  };
}

async function expectKeys(
  markdown: string,
  cursor: VimPos,
  keys: string,
  after: string,
  options: { plain?: boolean } = {},
) {
  const editor = setup(markdown, cursor, options);
  await editor.press(keys);
  expect(editor.markdown).toBe(after);
  return editor;
}

describe("ProseMirrorVimBuffer lines", () => {
  it("maps list items, code lines and chips to vim lines", () => {
    const doc = ProseMirrorNode.fromJSON(
      richSchema,
      buildDocJson("intro @README.md end\n- one\n- [ ] two\n```\nx\ny\n```", skill),
    );
    expect(vimLineIndex(doc).lines).toEqual(["intro ￼ end", "one", "two", "x", "y"]);
  });
});

describe("ProseMirrorVimBuffer linewise edits keep the Markdown structure", () => {
  it.each([
    ["dd removes a list item", "- a\n- b\n- c", { line: 1, col: 0 }, "dd", "- a\n- c"],
    ["dd removes a list it empties", "intro\n- a", { line: 1, col: 0 }, "dd", "intro"],
    ["dd keeps the next task's state", "- [x] a\n- [ ] b", { line: 0, col: 0 }, "dd", "- [ ] b"],
    ["dd on a code line", "```\none\ntwo\n```", { line: 0, col: 0 }, "dd", "```\ntwo\n```"],
    ["dd on the last code line", "```\none\ntwo\n```", { line: 1, col: 0 }, "dd", "```\none\n```"],
    [
      "dd on a whole code block",
      "before\n```\none\n```\nafter",
      { line: 1, col: 0 },
      "dd",
      "before\nafter",
    ],
    ["dd on the only line", "only", { line: 0, col: 2 }, "dd", ""],
    ["2dd across a paragraph and a list", "a\n- b\n- c", { line: 0, col: 0 }, "2dd", "- c"],
    ["o adds a list item", "- a\n- b", { line: 0, col: 0 }, "ox<Esc>", "- a\n- x\n- b"],
    ["o adds an unchecked task", "- [x] a", { line: 0, col: 0 }, "ox<Esc>", "- [x] a\n- [ ] x"],
    ["O adds a list item above", "- a", { line: 0, col: 0 }, "Ox<Esc>", "- x\n- a"],
    ["o after a heading adds a paragraph", "# T", { line: 0, col: 0 }, "ox<Esc>", "# T\nx"],
    [
      "o in a code block adds a code line",
      "```\na\n```",
      { line: 0, col: 0 },
      "ox<Esc>",
      "```\na\nx\n```",
    ],
    ["J joins list items", "- a\n- b", { line: 0, col: 0 }, "J", "- a b"],
    ["J joins paragraphs", "a\n  b", { line: 0, col: 0 }, "J", "a b"],
    [">> indents a list item", "- a\n- b", { line: 1, col: 0 }, ">>", "- a\n  - b"],
    ["<< outdents a list item", "- a\n  - b", { line: 1, col: 0 }, "<<", "- a\n- b"],
    [">> on a paragraph does nothing", "a\nb", { line: 1, col: 0 }, ">>", "a\nb"],
    ["yyp duplicates a list item", "- a\n- b", { line: 0, col: 0 }, "yyp", "- a\n- a\n- b"],
    ["ddp swaps paragraphs", "a\nb", { line: 0, col: 0 }, "ddp", "b\na"],
    ["Vjd removes list items", "- a\n- b\n- c", { line: 0, col: 0 }, "Vjd", "- c"],
    ["vjd joins paragraphs", "ab\ncd", { line: 0, col: 1 }, "vjd", "a"],
  ])("%s", async (_name, markdown, cursor, keys, after) => {
    await expectKeys(markdown, cursor, keys, after);
  });

  it(">> indents a list line in plain text", async () => {
    await expectKeys("- a\n- b", { line: 1, col: 0 }, ">>", "- a\n  - b", { plain: true });
  });
});

describe("ProseMirrorVimBuffer charwise edits", () => {
  it.each([
    ["x removes a chip whole", "see @README.md now", { line: 0, col: 4 }, "x", "see  now"],
    ["diw on a chip", "see @README.md now", { line: 0, col: 4 }, "diw", "see  now"],
    ["ciw on bold types bold", "a **bold** c", { line: 0, col: 3 }, "ciwx<Esc>", "a **x** c"],
    [
      "cw types with the style it replaced",
      "**ab** cd",
      { line: 0, col: 0 },
      "cwx<Esc>",
      "**x** cd",
    ],
    ["dw then i types plain", "a **b** c", { line: 0, col: 2 }, "dwix<Esc>", "a xc"],
    // Undo restores the visual selection a change started from; the next u must still undo.
    [
      "u after a visual change keeps undoing",
      "- ab\n- c",
      { line: 0, col: 0 },
      "xjVk>uu",
      "- ab\n- c",
    ],
    ["gUiw keeps marks", "**ab**cd", { line: 0, col: 0 }, "gUiw", "**AB**CD"],
    ["yl p", "ab", { line: 0, col: 0 }, "ylp", "aab"],
    [". repeats an Insert session", "a\nb", { line: 0, col: 0 }, "A;<Esc>j.", "a;\nb;"],
    ["u undoes one command", "abc", { line: 0, col: 0 }, "xxu", "bc"],
    [
      "u undoes a change with its typed text",
      "one two",
      { line: 0, col: 0 },
      "cwxyz<Esc>u",
      "one two",
    ],
  ])("%s", async (_name, markdown, cursor, keys, after) => {
    await expectKeys(markdown, cursor, keys, after);
  });

  it("leaves the cursor on the line a dd moved up", async () => {
    const editor = await expectKeys("- a\n- b\n- c", { line: 1, col: 0 }, "dd", "- a\n- c");
    expect(editor.cursor).toEqual({ line: 1, col: 0 });
  });

  it("keeps a visual selection through edits it does not own", async () => {
    const editor = setup("abc", { line: 0, col: 0 });
    await editor.press("vl");
    expect(editor.controller.mode).toBe("visual");
    expect(editor.cursor).toEqual({ line: 0, col: 2 });
  });
});
