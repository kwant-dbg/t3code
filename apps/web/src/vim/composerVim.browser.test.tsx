import type { Editor } from "@tiptap/core";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
  type ComposerPromptEditorProps,
} from "~/components/ComposerPromptEditorTiptap";
import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { registerCommands } from "~/shortcuts/dispatcher";

vi.mock(import("../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig, DEFAULT_KEYBINDINGS } =
    await import("@t3tools/shared/keybindings");
  return {
    ...(await original()),
    primaryServerKeybindingsAtom: Atom.make(compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS)),
  };
});

const keysSent = (handler: ReturnType<typeof vi.fn>) => handler.mock.calls.map(([key]) => key);

type CommandKeyHandler = NonNullable<ComposerPromptEditorProps["onCommandKeyDown"]>;

function VimComposer({
  value,
  onCommandKeyDown,
  jkEscape,
}: {
  value: string;
  onCommandKeyDown: CommandKeyHandler;
  jkEscape: boolean;
}) {
  const [prompt, setPrompt] = useState({ value, cursor: value.length });
  return (
    <ComposerPromptEditor
      editorRef={createRef<ComposerPromptEditorHandle>()}
      value={prompt.value}
      cursor={prompt.cursor}
      richTextEnabled
      vimMode
      vimJkEscape={jkEscape}
      contextRecords={new Map()}
      skills={[]}
      disabled={false}
      placeholder=""
      onChange={(next, cursor) => setPrompt({ value: next, cursor })}
      onPaste={() => {}}
      // Enter that sends clears the prompt, as the composer does.
      onCommandKeyDown={(key, event, isTaskItem) => {
        const handled = onCommandKeyDown(key, event, isTaskItem);
        if (handled && key === "Enter") setPrompt({ value: "", cursor: 0 });
        return handled;
      }}
    />
  );
}

async function mountVim(
  value: string,
  {
    onCommandKeyDown = () => false,
    container,
    jkEscape = false,
  }: { onCommandKeyDown?: CommandKeyHandler; container?: HTMLElement; jkEscape?: boolean } = {},
) {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <VimComposer value={value} onCommandKeyDown={onCommandKeyDown} jkEscape={jkEscape} />,
      container ? { container } : {},
    ),
  );
  const element = screen.container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  const editor = element.editor;
  await act(async () => {
    editor.commands.focus("end");
  });
  await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
  const environment = stack.move();
  return Object.assign(screen, {
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
    editor,
    markdown: () => serializeEditorDoc(editor.state.doc).value,
    mode: () => editor.view.dom.dataset.vimMode,
  });
}

describe("composer vim mode", () => {
  it("leaves Esc to an open menu, then switches to Normal", async () => {
    let menuOpen = true;
    const onCommandKeyDown = vi.fn((key: string) => key === "Escape" && menuOpen);
    await using screen = await mountVim("hello", { onCommandKeyDown });
    expect(screen.mode()).toBe("insert");

    await userEvent.keyboard("{Escape}");
    expect(keysSent(onCommandKeyDown)).toContain("Escape");
    expect(screen.mode()).toBe("insert");

    menuOpen = false;
    await userEvent.keyboard("{Escape}");
    expect(screen.mode()).toBe("normal");
  });

  it("edits with Normal keys and never types them", async () => {
    await using screen = await mountVim("hello brave world");
    await userEvent.keyboard("{Escape}0dwqz$x");
    expect(screen.markdown()).toBe("brave worl");
    await userEvent.keyboard("0cwnew{Escape}");
    expect(screen.markdown()).toBe("new worl");
    expect(screen.mode()).toBe("normal");
  });

  it("draws a block cursor on the character under it", async () => {
    await using screen = await mountVim("abc");
    // Esc steps back onto the last character typed.
    await userEvent.keyboard("{Escape}");
    const cursor = () => screen.editor.view.dom.querySelector(".composer-vim-cursor")?.textContent;
    expect(cursor()).toBe("c");
    await userEvent.keyboard("h");
    expect(cursor()).toBe("b");
  });

  it("keeps Esc for an IME composition", async () => {
    await using screen = await mountVim("にほ");
    await act(async () => {
      screen.editor.view.dom.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true }),
      );
      screen.editor.view.dom.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", keyCode: 229, bubbles: true }),
      );
    });
    expect(screen.mode()).toBe("insert");
  });

  it("sends with Enter from Normal and starts the next prompt in Insert", async () => {
    const onCommandKeyDown = vi.fn((key: string) => key === "Enter");
    await using screen = await mountVim("- item", { onCommandKeyDown });
    await userEvent.keyboard("{Escape}");
    expect(screen.mode()).toBe("normal");
    await userEvent.keyboard("{Enter}");
    // List continuation must not apply: Enter from Normal only sends.
    expect(onCommandKeyDown).toHaveBeenCalledWith("Enter", expect.anything(), true);
    await vi.waitFor(() => expect(screen.markdown()).toBe(""));
    await vi.waitFor(() => expect(screen.mode()).toBe("insert"));
  });

  it("returns to Insert when the composer gains focus", async () => {
    await using screen = await mountVim("hello");
    await userEvent.keyboard("{Escape}");
    expect(screen.mode()).toBe("normal");
    await act(async () => {
      screen.editor.view.dom.blur();
      screen.editor.view.focus();
    });
    expect(screen.mode()).toBe("insert");
  });

  it("moves j and k by screen line and hands the first line's k to prompt history", async () => {
    const onCommandKeyDown = vi.fn(() => false);
    const container = document.createElement("div");
    container.style.width = "120px";
    await using screen = await mountVim("one two three four five six seven eight nine ten", {
      onCommandKeyDown,
      container,
    });
    const { editor } = screen;
    await act(async () => {
      editor.commands.setTextSelection(1);
    });
    await userEvent.keyboard("{Escape}");
    const lineTop = () => editor.view.coordsAtPos(editor.state.selection.head).top;
    const firstTop = lineTop();
    await userEvent.keyboard("j");
    expect(lineTop()).toBeGreaterThan(firstTop);
    expect(editor.state.selection.head).toBeGreaterThan(1);
    await userEvent.keyboard("k");
    expect(lineTop()).toBe(firstTop);
    expect(keysSent(onCommandKeyDown)).not.toContain("ArrowUp");
    await userEvent.keyboard("k");
    expect(keysSent(onCommandKeyDown)).toContain("ArrowUp");
  });

  it("lets an app shortcut on a ctrl key run from Normal", async () => {
    const next = vi.fn((event: KeyboardEvent) => event.preventDefault());
    using _commands = {
      [Symbol.dispose]: registerCommands(
        { "thread.next": next },
        {
          keybindings: () => [
            {
              command: "thread.next",
              shortcut: {
                key: "j",
                metaKey: false,
                ctrlKey: true,
                shiftKey: false,
                altKey: false,
                modKey: false,
              },
            },
          ],
        },
      ),
    };
    await using screen = await mountVim("abc");
    await userEvent.keyboard("{Escape}{Control>}j{/Control}");
    expect(next).toHaveBeenCalledTimes(1);
    expect(screen.markdown()).toBe("abc");
    expect(screen.mode()).toBe("normal");
  });

  it("undoes an Insert session in one step and a Normal command in another", async () => {
    await using screen = await mountVim("abc");
    await userEvent.keyboard("{Escape}0x");
    await userEvent.keyboard("Axy{Backspace}z{Escape}");
    expect(screen.markdown()).toBe("bcxz");
    await userEvent.keyboard("u");
    expect(screen.markdown()).toBe("bc");
    await userEvent.keyboard("u");
    expect(screen.markdown()).toBe("abc");
    await userEvent.keyboard("{Control>}r{/Control}");
    expect(screen.markdown()).toBe("bc");
  });

  it("puts a yanked list item back as a list item through the system clipboard", async () => {
    let clipboard = "";
    using _write = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (text) => {
      clipboard = text;
    });
    using _read = vi
      .spyOn(navigator.clipboard, "readText")
      .mockImplementation(async () => clipboard);
    await using screen = await mountVim("- one\n- two");
    await userEvent.keyboard("{Escape}ggyy");
    expect(clipboard).toBe("one\n");
    await userEvent.keyboard("p");
    await vi.waitFor(() => expect(screen.markdown()).toBe("- one\n- one\n- two"));
  });

  it("pastes text copied elsewhere after the cursor", async () => {
    using _read = vi.spyOn(navigator.clipboard, "readText").mockResolvedValue("XY");
    await using screen = await mountVim("ab");
    await userEvent.keyboard("{Escape}0p");
    await vi.waitFor(() => expect(screen.markdown()).toBe("aXYb"));
  });

  it("edits bold text as rendered text, without its Markdown markers", async () => {
    await using screen = await mountVim("a **bold** c");
    await userEvent.keyboard("{Escape}0wdw");
    expect(screen.markdown()).toBe("a c");
  });
});

describe("jk to leave Insert", () => {
  it("takes back the j and leaves Insert, with no j for undo to restore", async () => {
    await using screen = await mountVim("", { jkEscape: true });
    await userEvent.keyboard("abjk");
    expect(screen.markdown()).toBe("ab");
    expect(screen.mode()).toBe("normal");
    await userEvent.keyboard("u");
    expect(screen.markdown()).toBe("");
  });

  it.each([
    ["the setting is off", false, "jk"],
    ["another key comes between", true, "jxk"],
  ])("types every key when %s", async (_name, jkEscape, keys) => {
    await using screen = await mountVim("", { jkEscape });
    await userEvent.keyboard(keys);
    expect(screen.markdown()).toBe(keys);
    expect(screen.mode()).toBe("insert");
  });

  it("repeats the typed text with . but not the j", async () => {
    await using screen = await mountVim("a\nb", { jkEscape: true });
    await userEvent.keyboard("{Escape}ggA;jkj.");
    expect(screen.markdown()).toBe("a;\nb;");
  });

  it("types a k that comes after vim's timeout", async () => {
    await using screen = await mountVim("", { jkEscape: true });
    using now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    await userEvent.keyboard("j");
    now.mockReturnValue(11_001);
    await userEvent.keyboard("k");
    expect(screen.markdown()).toBe("jk");
    expect(screen.mode()).toBe("insert");
  });
});
