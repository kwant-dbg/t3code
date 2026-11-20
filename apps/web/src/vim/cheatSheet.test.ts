import {
  compileResolvedKeybindingsConfig,
  mergeVimKeybindings,
  VIM_DEFAULT_KEYBINDINGS,
} from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import { vimCheatSheetRows } from "./cheatSheet";

describe("vimCheatSheetRows", () => {
  const vim = compileResolvedKeybindingsConfig(VIM_DEFAULT_KEYBINDINGS);

  it("groups vim's keys by where they apply", () => {
    const rows = vimCheatSheetRows(vim);
    const groupOf = (command: string) => rows.find((row) => row.command === command)?.group;
    expect(groupOf("list.next")).toBe("lists");
    expect(groupOf("sidebar.renameThread")).toBe("sidebar");
    expect(groupOf("conversation.next")).toBe("conversation");
    expect(groupOf("diff.nextHunk")).toBe("rightPanel");
    // `!listFocus` is not a list key.
    expect(rows.find((row) => row.command === "scroll.halfPageDown")?.group).toBe("anywhere");
  });

  it("shows a user's rebinding and leaves out a key they removed", () => {
    const user = compileResolvedKeybindingsConfig([
      { key: "x", command: "list.next", when: "vimNormal && listFocus" },
      { key: "space t", command: "terminal.toggle", when: "false" },
    ]);
    const rows = vimCheatSheetRows(mergeVimKeybindings(vim, user, []));
    const keysFor = (command: string) =>
      rows.filter((row) => row.command === command).map((row) => row.binding.shortcut.key);
    expect(keysFor("list.next")).toEqual(["x"]);
    expect(keysFor("terminal.toggle")).toEqual([]);
  });
});
