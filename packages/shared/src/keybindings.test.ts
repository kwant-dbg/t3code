import { describe, expect, it } from "vite-plus/test";

import {
  compileResolvedKeybindingRule,
  compileResolvedKeybindingsConfig,
  DEFAULT_KEYBINDINGS,
  DEFAULT_RESOLVED_KEYBINDINGS,
  mergeVimKeybindings,
  mergeWithDefaultKeybindings,
  parseKeybindingSequence,
  VIM_DEFAULT_KEYBINDINGS,
} from "./keybindings.ts";

describe("parseKeybindingSequence", () => {
  it.each([
    ["mod+k", ["mod+k"]],
    ["mod + k", ["mod+k"]],
    ["g g", ["g", "g"]],
    ["space t", [" ", "t"]],
    ["ctrl+w  h", ["ctrl+w", "h"]],
    ["ctrl+\\ ctrl+n", ["ctrl+\\", "ctrl+n"]],
  ])("reads %j", (value, steps) => {
    const parsed = parseKeybindingSequence(value);
    expect(
      parsed?.map(
        (step) =>
          `${step.modKey ? "mod+" : ""}${step.ctrlKey ? "ctrl+" : ""}${step.key === " " ? " " : step.key}`,
      ),
    ).toEqual(steps);
  });

  it("rejects too many steps and steps that are not keys", () => {
    expect(parseKeybindingSequence("a b c d e")).toBeNull();
    expect(parseKeybindingSequence("g mod+shift")).toBeNull();
  });
});

describe("compileResolvedKeybindingRule", () => {
  it("compiles a sequence with a shortcut no single keypress matches", () => {
    const rule = compileResolvedKeybindingRule({ key: "g  G", command: "chat.new" });
    expect(rule?.sequence?.map((step) => step.key)).toEqual(["g", "g"]);
    // Clients from before sequences match `shortcut` alone; a key with a space never comes.
    expect(rule?.shortcut.key).toBe("g g");
    expect(rule?.shortcut.ctrlKey || rule?.shortcut.modKey).toBe(false);
  });

  it("keeps one-key rules as they were", () => {
    expect(compileResolvedKeybindingRule({ key: "mod+k", command: "chat.new" })).toEqual({
      command: "chat.new",
      shortcut: {
        key: "k",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      },
    });
  });
});

describe("vim keybindings", () => {
  const vim = compileResolvedKeybindingsConfig(VIM_DEFAULT_KEYBINDINGS);

  it("compiles every vim default", () => {
    expect(vim).toHaveLength(VIM_DEFAULT_KEYBINDINGS.length);
  });

  it("go under the app's rules, which win a shared key", () => {
    const merged = mergeVimKeybindings(vim, DEFAULT_RESOLVED_KEYBINDINGS);
    expect(merged.slice(0, vim.length)).toEqual(vim);
    expect(merged.slice(vim.length)).toEqual(DEFAULT_RESOLVED_KEYBINDINGS);
  });

  it("keep their key for a command the user left at its default", () => {
    // The server writes defaults into keybindings.json; that is not a customization.
    const fromFile = mergeWithDefaultKeybindings(
      compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS),
    );
    const merged = mergeVimKeybindings(vim, fromFile);
    expect(
      merged
        .filter((rule) => rule.command === "commandPalette.toggle")
        .map((rule) => rule.shortcut.key),
    ).toEqual([";", "k"]);
  });

  it("drop out for a command the user bound themselves", () => {
    const custom = mergeWithDefaultKeybindings(
      compileResolvedKeybindingsConfig([
        { key: "x", command: "list.next", when: "vimNormal && listFocus" },
        { key: "mod+shift+p", command: "commandPalette.toggle" },
      ]),
    );
    const merged = mergeVimKeybindings(vim, custom);
    const keysFor = (command: string) =>
      merged.filter((rule) => rule.command === command).map((rule) => rule.shortcut.key);
    expect(keysFor("list.next")).toEqual(["x"]);
    expect(keysFor("commandPalette.toggle")).toEqual(["p"]);
    // Other vim keys stay.
    expect(keysFor("list.previous")).toEqual(["k", "p"]);
  });

  it("never count toward the 256 rules of keybindings.json", () => {
    const full = Array.from({ length: 256 }, (_, index) => ({
      key: `mod+alt+shift+f${(index % 12) + 1}`,
      command: "chat.new" as const,
      when: `custom${index}`,
    }));
    const userRules = compileResolvedKeybindingsConfig(full);
    const merged = mergeVimKeybindings(vim, mergeWithDefaultKeybindings(userRules));
    // All of the user's rules survive, with vim's beside them rather than in their place.
    expect(merged.filter((rule) => rule.command === "chat.new" && rule.whenAst)).toHaveLength(256);
    expect(merged.some((rule) => rule.command === "list.next")).toBe(true);
  });
});
