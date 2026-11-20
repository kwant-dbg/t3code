import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { startWorkspaceFocus, workspaceAreaProps } from "~/lib/workspaceFocus";
import { startVimNavigation } from "./navigation";
import { setVimModeOn } from "./vimKeybindings";

vi.mock(import("../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig, DEFAULT_KEYBINDINGS } =
    await import("@t3tools/shared/keybindings");
  return {
    ...(await original()),
    primaryServerKeybindingsAtom: Atom.make(compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS)),
  };
});

function Workspace({ onSend = () => {} }: { onSend?: () => void }) {
  return (
    <div className="flex h-96">
      <nav {...workspaceAreaProps("sidebar", 0, "Sidebar")} className="w-40">
        <ul role="list">
          {["one", "two", "three", "four"].map((name, index) => (
            <li key={name} role="listitem" tabIndex={index === 0 ? 0 : -1} data-testid={name}>
              {name}
            </li>
          ))}
        </ul>
      </nav>
      <main {...workspaceAreaProps("conversation", 1, "Conversation")} className="flex-1">
        <div data-workspace-focus-default="" tabIndex={-1} data-testid="timeline">
          messages
        </div>
        <button type="button" onClick={onSend}>
          Send
        </button>
      </main>
    </div>
  );
}

async function mount(ui: React.ReactElement) {
  await using stack = new AsyncDisposableStack();
  // Ctrl is free for vim on macOS, where the app's own shortcuts use Cmd.
  stack.use(vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel"));
  const screen = stack.use(await render(ui));
  stack.defer(startWorkspaceFocus(screen.router!));
  setVimModeOn(true);
  stack.defer(() => setVimModeOn(false));
  stack.defer(startVimNavigation());
  const environment = stack.move();
  return Object.assign(screen, { [Symbol.asyncDispose]: () => environment.disposeAsync() });
}

const focusedArea = () =>
  document.activeElement?.closest<HTMLElement>("[data-workspace-area]")?.dataset.workspaceArea;

describe("vim navigation", () => {
  it("moves between areas with ctrl+w and through a list with j, k, G and gg", async () => {
    await using screen = await mount(<Workspace />);
    screen.getByTestId("timeline").element().focus();

    await userEvent.keyboard("{Control>}w{/Control}h");
    await vi.waitFor(() => expect(focusedArea()).toBe("sidebar"));
    screen.getByTestId("one").element().focus();

    await userEvent.keyboard("jj");
    await expect.element(screen.getByTestId("three")).toHaveFocus();
    await userEvent.keyboard("k");
    await expect.element(screen.getByTestId("two")).toHaveFocus();
    await userEvent.keyboard("{Shift>}G{/Shift}");
    await expect.element(screen.getByTestId("four")).toHaveFocus();
    await userEvent.keyboard("gg");
    await expect.element(screen.getByTestId("one")).toHaveFocus();

    await userEvent.keyboard("{Control>}w{/Control}l");
    await vi.waitFor(() => expect(focusedArea()).toBe("conversation"));
  });

  it("labels the visible controls with f and clicks the one whose label is typed", async () => {
    const onSend = vi.fn();
    await using screen = await mount(<Workspace onSend={onSend} />);
    screen.getByTestId("timeline").element().focus();

    await userEvent.keyboard("f");
    const labels = Array.from(document.querySelectorAll(".vim-hint"), (hint) => hint.textContent);
    expect(labels.length).toBeGreaterThan(0);
    // The Send button is the only control here, so it gets the first label.
    await userEvent.keyboard(labels[0]!);
    expect(onSend).toHaveBeenCalledOnce();
    expect(document.querySelector(".vim-hints")).toBeNull();

    await userEvent.keyboard("f{Escape}");
    expect(document.querySelector(".vim-hints")).toBeNull();
    expect(onSend).toHaveBeenCalledOnce();
  });
});
