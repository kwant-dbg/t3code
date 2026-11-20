import type {
  KeybindingCommand,
  KeybindingWhenNode,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";

export type CheatSheetGroup = "anywhere" | "lists" | "sidebar" | "conversation" | "rightPanel";

export interface CheatSheetRow {
  readonly group: CheatSheetGroup;
  readonly binding: ResolvedKeybindingRule;
  readonly command: KeybindingCommand;
}

function identifiers(node: KeybindingWhenNode | undefined, into = new Set<string>()): Set<string> {
  if (!node) return into;
  if (node.type === "identifier") into.add(node.name);
  else if (node.type === "not") identifiers(node.node, into);
  else {
    identifiers(node.left, into);
    identifiers(node.right, into);
  }
  return into;
}

const GROUP_BY_KEY: ReadonlyArray<readonly [string, CheatSheetGroup]> = [
  ["sidebarFocus", "sidebar"],
  ["conversationFocus", "conversation"],
  ["rightPanelFocus", "rightPanel"],
  ["listFocus", "lists"],
  ["popupOpen", "lists"],
];

/**
 * The vim keys in effect: every rule that applies in vim mode, the user's own included, so the
 * sheet shows a rebinding as it is. Grouped by where the rule applies.
 */
export function vimCheatSheetRows(keybindings: ResolvedKeybindingsConfig): CheatSheetRow[] {
  const rows: CheatSheetRow[] = [];
  for (const binding of keybindings) {
    const names = identifiers(binding.whenAst);
    if (!names.has("vimNormal") && !names.has("vimMode")) continue;
    if (names.has("false")) continue;
    const group =
      GROUP_BY_KEY.find(([key]) => names.has(key) && !isNegated(binding.whenAst, key))?.[1] ??
      "anywhere";
    rows.push({ group, binding, command: binding.command });
  }
  return rows;
}

function isNegated(node: KeybindingWhenNode | undefined, name: string): boolean {
  if (!node || node.type === "identifier") return false;
  if (node.type === "not") return node.node.type === "identifier" && node.node.name === name;
  return isNegated(node.left, name) || isNegated(node.right, name);
}
