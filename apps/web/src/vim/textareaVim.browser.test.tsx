import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { startTextareaVim } from "./textareaVim";

function Box({
  initial,
  onKeyDown,
  width,
  ...props
}: {
  initial: string;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  width?: number;
  "aria-expanded"?: boolean;
  "data-vim"?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <textarea
        aria-label="box"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        style={{ width: width ?? 400, font: "16px monospace", padding: 0, border: 0 }}
        rows={4}
        {...props}
      />
      <output data-testid="value">{value}</output>
    </>
  );
}

async function mount(ui: React.ReactElement, options: { start?: boolean } = {}) {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await render(ui, { router: false }));
  if (options.start !== false) stack.defer(startTextareaVim());
  const textarea = screen.container.querySelector("textarea")!;
  await userEvent.click(textarea);
  const environment = stack.move();
  return Object.assign(screen, {
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
    textarea,
    /** What React holds, which only changes through onChange. */
    value: () => screen.container.querySelector("output")!.textContent,
    mode: () => textarea.dataset.vimMode ?? "insert",
    cursor: () => textarea.selectionStart,
  });
}

describe("vim in text boxes", () => {
  it("edits with Normal keys and reports each change to React", async () => {
    await using screen = await mount(<Box initial="hello brave world" />);
    await userEvent.keyboard("{Escape}0dw");
    expect(screen.mode()).toBe("normal");
    expect(screen.value()).toBe("brave world");
    await userEvent.keyboard("ciwnew{Escape}");
    expect(screen.value()).toBe("new world");
    // The change and the text typed for it undo together.
    await userEvent.keyboard("u");
    expect(screen.value()).toBe("brave world");
    await userEvent.keyboard("u");
    expect(screen.value()).toBe("hello brave world");
    await userEvent.keyboard("{Control>}r{/Control}");
    expect(screen.value()).toBe("brave world");
  });

  it("undoes an Insert session as one step", async () => {
    await using screen = await mount(<Box initial="" />);
    await userEvent.keyboard("one two{Escape}");
    expect(screen.value()).toBe("one two");
    await userEvent.keyboard("u");
    expect(screen.value()).toBe("");
  });

  it("leaves Enter to the text box, and moves down a line when it is unused", async () => {
    const onSave = vi.fn();
    const saveOnEnter = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      onSave();
    };
    {
      await using screen = await mount(<Box initial={"one\ntwo"} onKeyDown={saveOnEnter} />);
      await userEvent.keyboard("{Escape}gg{Enter}");
      expect(onSave).toHaveBeenCalledOnce();
      expect(screen.value()).toBe("one\ntwo");
    }
    await using plain = await mount(<Box initial={"one\ntwo"} />);
    await userEvent.keyboard("{Escape}gg{Enter}");
    expect(plain.value()).toBe("one\ntwo");
    expect(plain.cursor()).toBe(4);
  });

  it("lets an open completion list take Esc, and keeps a second Esc in Normal from the page", async () => {
    const pageEscapes = vi.fn();
    function Page({ expanded }: { expanded: boolean }) {
      return (
        <div onKeyDown={(event) => event.key === "Escape" && pageEscapes()}>
          <Box initial="text" aria-expanded={expanded} />
        </div>
      );
    }
    await using screen = await mount(<Page expanded />);
    await userEvent.keyboard("{Escape}");
    expect(screen.mode()).toBe("insert");
    expect(pageEscapes).toHaveBeenCalledOnce();

    await screen.rerender(<Page expanded={false} />);
    // A dialog around the text box would close on any of these reaching it.
    await userEvent.keyboard("{Escape}d{Escape}{Escape}");
    expect(screen.mode()).toBe("normal");
    expect(pageEscapes).toHaveBeenCalledOnce();
  });

  it("moves j and k by wrapped screen line", async () => {
    const text = "aaaa bbbb cccc dddd eeee ffff";
    await using screen = await mount(<Box initial={text} width={100} />);
    await userEvent.keyboard("{Escape}0j");
    const below = screen.cursor();
    expect(below).toBeGreaterThan(0);
    expect(below).toBeLessThan(text.length);
    await userEvent.keyboard("k");
    expect(screen.cursor()).toBe(0);
  });

  it("shows the mode and a search pattern at the text box's corner", async () => {
    await using screen = await mount(<Box initial="one two" />);
    const status = () => document.querySelector(".vim-textarea-status")?.textContent ?? null;
    expect(status()).toBeNull();
    await userEvent.keyboard("{Escape}0/tw");
    expect(status()).toBe("NORMAL /tw");
    await userEvent.keyboard("{Enter}");
    expect(status()).toBe("NORMAL");
    expect(screen.cursor()).toBe(4);
    await userEvent.keyboard("i");
    expect(status()).toBeNull();
  });

  it("yanks and puts through the system clipboard", async () => {
    let clipboard = "";
    using _write = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (text) => {
      clipboard = text;
    });
    using _read = vi
      .spyOn(navigator.clipboard, "readText")
      .mockImplementation(async () => clipboard);
    await using screen = await mount(<Box initial={"one\ntwo"} />);
    await userEvent.keyboard("{Escape}ggyy");
    expect(clipboard).toBe("one\n");
    await userEvent.keyboard("p");
    await vi.waitFor(() => expect(screen.value()).toBe("one\none\ntwo"));
  });

  it("leaves opted-out text boxes and the terminal alone", async () => {
    {
      await using screen = await mount(<Box initial="" data-vim="off" />);
      await userEvent.keyboard("{Escape}x");
      expect(screen.value()).toBe("x");
      expect(screen.textarea.dataset.vimMode).toBeUndefined();
    }
    await using terminal = await mount(
      // xterm.js's own class, which the app's styles do not define.
      <div ref={(node) => node?.classList.add("xterm")}>
        <Box initial="" />
      </div>,
    );
    await userEvent.keyboard("{Escape}x");
    expect(terminal.value()).toBe("x");
  });

  it("types normally again once vim stops", async () => {
    await using stack = new AsyncDisposableStack();
    const screen = stack.use(await mount(<Box initial="" />, { start: false }));
    const stop = startTextareaVim();
    await userEvent.keyboard("{Escape}");
    expect(screen.mode()).toBe("normal");
    stop();
    expect(screen.textarea.dataset.vimMode).toBeUndefined();
    await userEvent.keyboard("x");
    expect(screen.value()).toBe("x");
  });
});
