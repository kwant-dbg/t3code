import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";

import { fakeTimers } from "../../test/render";

import {
  dispatchMenuAction,
  getPendingKeySequence,
  registerCommandRunner,
  registerCommands,
  registerMenuAction,
} from "./dispatcher";

function bindings(entries: ReadonlyArray<[string, KeybindingCommand]>): ResolvedKeybindingsConfig {
  return entries.map(([key, command]) => ({
    command,
    shortcut: {
      key,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: false,
    },
  }));
}

const keybindings = () =>
  bindings([
    ["k", "chat.new"],
    ["j", "chat.newLocal"],
  ]);

function press(key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true });
  window.dispatchEvent(event);
  return event;
}

describe("command dispatcher", () => {
  it("runs the newest scope's handler and nothing below it", () => {
    const global = vi.fn();
    const outer = vi.fn();
    const inner = vi.fn();
    using stack = new DisposableStack();
    stack.defer(registerCommands({ "chat.new": global }, { keybindings }));
    stack.defer(registerCommands({ "chat.new": outer }, { keybindings }));
    stack.defer(registerCommands({ "chat.new": inner }, { keybindings }));

    press("k");

    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
    expect(global).not.toHaveBeenCalled();
  });

  it("falls through scopes that return false, skip the command, or fail their guard", () => {
    const global = vi.fn();
    const declined = vi.fn(() => false);
    const guarded = vi.fn();
    using stack = new DisposableStack();
    stack.defer(registerCommands({ "chat.new": global }, { keybindings }));
    stack.defer(registerCommands({ "chat.new": declined }, { keybindings }));
    stack.defer(registerCommands({ "chat.newLocal": vi.fn() }, { keybindings }));
    stack.defer(registerCommands({ "chat.new": guarded }, { keybindings, when: () => false }));

    press("k");

    expect(guarded).not.toHaveBeenCalled();
    expect(declined).toHaveBeenCalledOnce();
    expect(global).toHaveBeenCalledOnce();
  });

  it("stops once a handler prevents default, and unregisters on cleanup", () => {
    const lower = vi.fn();
    const upper = vi.fn((event: KeyboardEvent) => {
      event.preventDefault();
      return false;
    });
    using stack = new DisposableStack();
    stack.defer(registerCommands({ "chat.new": lower }, { keybindings }));
    const unregisterUpper = registerCommands({ "chat.new": upper }, { keybindings });

    press("k");
    expect(lower).not.toHaveBeenCalled();

    unregisterUpper();
    press("k");
    expect(upper).toHaveBeenCalledOnce();
    expect(lower).toHaveBeenCalledOnce();
  });

  it("lets a scope claim raw keys before command lookup", () => {
    const onEscape = vi.fn((event: KeyboardEvent) => (event.key === "Escape" ? undefined : false));
    const command = vi.fn();
    using stack = new DisposableStack();
    stack.defer(registerCommands({ "chat.new": command }, { keybindings, onKeyDown: onEscape }));

    press("Escape");
    press("k");

    expect(onEscape).toHaveBeenCalledTimes(2);
    expect(command).toHaveBeenCalledOnce();
  });

  it("tells observers whether a scope consumed the key, after the scopes ran", () => {
    const calls: Array<string> = [];
    using stack = new DisposableStack();
    stack.defer(
      registerCommands({}, { observe: (_event, consumed) => calls.push(`observe:${consumed}`) }),
    );
    stack.defer(
      registerCommands({ "chat.new": () => void calls.push("command") }, { keybindings }),
    );

    press("k");
    press("x");

    expect(calls).toEqual(["command", "observe:true", "observe:false"]);
  });

  it("consumes a command chord pressed inside a confirmation without running its handler", () => {
    const command = vi.fn();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "alertdialog");
    const cancel = document.createElement("button");
    dialog.append(cancel);
    document.body.append(dialog);
    using stack = new DisposableStack();
    stack.defer(() => dialog.remove());
    stack.defer(registerCommands({ "chat.new": command }, { keybindings }));
    cancel.focus();

    const event = new KeyboardEvent("keydown", { key: "k", cancelable: true, bubbles: true });
    cancel.dispatchEvent(event);

    expect(command).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("routes a menu action to its newest handler", () => {
    const older = vi.fn();
    const newer = vi.fn();
    using stack = new DisposableStack();
    stack.defer(registerMenuAction("test-action", older));
    const unregisterNewer = registerMenuAction("test-action", newer);

    dispatchMenuAction("test-action");
    unregisterNewer();
    dispatchMenuAction("test-action");

    expect(newer).toHaveBeenCalledOnce();
    expect(older).toHaveBeenCalledOnce();
  });
});

describe("key sequences", () => {
  const sequences = () =>
    compileResolvedKeybindingsConfig([
      { key: "g g", command: "chat.new" },
      { key: "space t", command: "chat.newLocal" },
      { key: "k", command: "chat.find" },
      { key: "k j", command: "chat.newWithoutProject" },
    ]);
  const pendingKeys = () => getPendingKeySequence()?.typed.map((step) => step.key) ?? null;

  it("runs a command once its keys come in order, listing what may follow meanwhile", () => {
    const first = vi.fn();
    using stack = new DisposableStack();
    stack.defer(registerCommands({ "chat.new": first }, { keybindings: sequences }));

    expect(press("g").defaultPrevented).toBe(true);
    expect(pendingKeys()).toEqual(["g"]);
    expect(getPendingKeySequence()?.next.map((next) => next.command)).toEqual(["chat.new"]);
    expect(first).not.toHaveBeenCalled();

    press("g");
    expect(first).toHaveBeenCalledOnce();
    expect(getPendingKeySequence()).toBeNull();
  });

  it("drops the keys typed so far after a second, as vim's timeoutlen does", () => {
    const first = vi.fn();
    using _clock = fakeTimers();
    using stack = new DisposableStack();
    stack.defer(registerCommands({ "chat.new": first }, { keybindings: sequences }));

    press("g");
    vi.advanceTimersByTime(1000);
    expect(getPendingKeySequence()).toBeNull();
    press("g");
    expect(first).not.toHaveBeenCalled();
    expect(pendingKeys()).toEqual(["g"]);
    press("Escape");
  });

  it("cancels on Esc, and lets a key that continues nothing go on as usual", () => {
    using stack = new DisposableStack();
    stack.defer(
      registerCommands(
        { "chat.new": vi.fn(), "chat.newLocal": vi.fn() },
        { keybindings: sequences },
      ),
    );

    press("g");
    expect(press("Escape").defaultPrevented).toBe(true);
    expect(getPendingKeySequence()).toBeNull();

    press(" ");
    expect(press("x").defaultPrevented).toBe(false);
    expect(getPendingKeySequence()).toBeNull();
  });

  it("never starts on a key that already runs a command, or while typing in a field", () => {
    const find = vi.fn();
    const later = vi.fn();
    using stack = new DisposableStack();
    stack.defer(
      registerCommands(
        { "chat.find": find, "chat.newWithoutProject": later, "chat.new": vi.fn() },
        { keybindings: sequences },
      ),
    );

    press("k");
    expect(find).toHaveBeenCalledOnce();
    expect(getPendingKeySequence()).toBeNull();

    const input = document.createElement("input");
    document.body.append(input);
    stack.defer(() => input.remove());
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "g", bubbles: true, cancelable: true }),
    );
    expect(getPendingKeySequence()).toBeNull();
  });

  it("runs a command a component handles with its own listener", () => {
    const run = vi.fn(() => true);
    using stack = new DisposableStack();
    // A scope gives the sequence its rules; the runner owns the command.
    stack.defer(registerCommands({}, { keybindings: sequences }));
    stack.defer(registerCommandRunner({ has: (command) => command === "chat.newLocal", run }));

    press(" ");
    press("t");
    expect(run).toHaveBeenCalledWith("chat.newLocal", expect.any(KeyboardEvent));
  });
});
