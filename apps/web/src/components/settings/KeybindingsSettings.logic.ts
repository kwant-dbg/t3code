import {
  MAX_KEYBINDING_SEQUENCE_STEPS,
  STATIC_KEYBINDING_COMMANDS,
  VIM_KEYBINDING_COMMANDS,
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingRule,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
  parseKeybindingSequence,
  parseKeybindingWhenExpression,
  US_SHIFTED_TO_UNSHIFTED_KEYS,
  VIM_DEFAULT_KEYBINDINGS,
} from "@t3tools/shared/keybindings";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import { shortcutConflictKey, shortcutKeyFromEvent } from "../../keybindings";
import { isMacPlatform } from "../../lib/utils";
import { METRIC_OPTIONS, WINDOW_OPTIONS } from "../usage/usageShortcuts";

// Rank every usage command; mixing rank and alphabetical comparisons makes order input-dependent.
const usageCommandOrder = new Map<KeybindingCommand, number>(
  [
    "usage.open" as const,
    ...[...METRIC_OPTIONS, ...WINDOW_OPTIONS].map((option) => option.command),
  ].map((command, index) => [command, index]),
);

const firstUsageCommand = METRIC_OPTIONS[0].command;

function compareCommands(
  left: KeybindingCommand,
  right: KeybindingCommand,
  key: (command: KeybindingCommand) => string,
): number {
  const leftRank = usageCommandOrder.get(left);
  const rightRank = usageCommandOrder.get(right);
  if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
  return key(leftRank === undefined ? left : firstUsageCommand).localeCompare(
    key(rightRank === undefined ? right : firstUsageCommand),
  );
}

export type KeybindingSource = "Default" | "Custom" | "Project";

export interface KeybindingRow {
  readonly id: string;
  readonly command: KeybindingCommand;
  readonly key: string;
  readonly when: string;
  readonly source: KeybindingSource;
  readonly isUnassigned: boolean;
  readonly defaultKey: string | null;
  readonly defaultWhen: string;
  readonly binding: ResolvedKeybindingRule;
  readonly conflicts: ReadonlyArray<string>;
}

export type WhenVariableOption = string;
export type KeybindingCommandOption = KeybindingCommand;

const CORE_WHEN_VARIABLES = [
  "terminalFocus",
  "terminalOpen",
  "previewOpen",
  "isWeb",
  "isDesktop",
  "true",
  "false",
] as const;

// The app's defaults and vim mode's: a rule equal to either is a default, not the user's own.
const DEFAULT_BINDINGS = [
  ...DEFAULT_RESOLVED_KEYBINDINGS,
  ...compileResolvedKeybindingsConfig(VIM_DEFAULT_KEYBINDINGS),
];

const DEFAULT_WHEN_VARIABLES = new Set<string>(CORE_WHEN_VARIABLES);
for (const binding of DEFAULT_BINDINGS) {
  collectWhenIdentifiersFromNode(binding.whenAst, DEFAULT_WHEN_VARIABLES);
}

export const DEFAULT_WHEN_VARIABLE =
  [...DEFAULT_WHEN_VARIABLES].find(
    (identifier) => identifier !== "true" && identifier !== "false",
  ) ?? "terminalFocus";
const KNOWN_WHEN_VARIABLES = new Set(DEFAULT_WHEN_VARIABLES);

export function shortcutToKeybindingInput(shortcut: KeybindingShortcut): string {
  const parts: string[] = [];
  if (shortcut.modKey) parts.push("mod");
  if (shortcut.metaKey) parts.push("meta");
  if (shortcut.ctrlKey) parts.push("ctrl");
  if (shortcut.altKey) parts.push("alt");
  if (shortcut.shiftKey) parts.push("shift");
  parts.push(shortcut.key === " " ? "space" : shortcut.key === "escape" ? "esc" : shortcut.key);
  return parts.join("+");
}

/** A binding's keys as keybindings.json writes them: `mod+k`, or `g g` for a sequence. */
function bindingToKeybindingInput(
  binding: Pick<ResolvedKeybindingRule, "shortcut" | "sequence">,
): string {
  return (binding.sequence ?? [binding.shortcut]).map(shortcutToKeybindingInput).join(" ");
}

function bindingConflictKey(
  binding: Pick<ResolvedKeybindingRule, "shortcut" | "sequence">,
  platform: string,
): string {
  return (binding.sequence ?? [binding.shortcut])
    .map((step) => shortcutConflictKey(step, platform))
    .join(" ");
}

export function whenAstToExpression(node: KeybindingWhenNode | undefined): string {
  if (!node) return "";
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!${wrapWhenExpression(node.node)}`;
    case "and":
      return `${wrapWhenExpression(node.left)} && ${wrapWhenExpression(node.right)}`;
    case "or":
      return `${wrapWhenExpression(node.left)} || ${wrapWhenExpression(node.right)}`;
  }
}

export function whenNodeRemoveLabel(
  node: KeybindingWhenNode,
  depth: number,
  resolve: MessageResolver = m,
): string {
  if (depth === 0) return resolve(msg("Clear all conditions"));
  if (node.type === "identifier" || (node.type === "not" && node.node.type === "identifier")) {
    return resolve(msg("Remove condition"));
  }
  return resolve(msg("Remove group and its conditions"));
}

function wrapWhenExpression(node: KeybindingWhenNode): string {
  if (node.type === "identifier" || node.type === "not") return whenAstToExpression(node);
  return `(${whenAstToExpression(node)})`;
}

export function parseWhenExpressionDraft(
  expression: string,
  resolve: MessageResolver = m,
): { ok: true; value: KeybindingWhenNode | undefined } | { ok: false; message: string } {
  const trimmed = expression.trim();
  if (trimmed.length === 0) return { ok: true, value: undefined };

  const ast = parseKeybindingWhenExpression(trimmed);
  if (!ast) {
    return {
      ok: false,
      message: resolve(msg("Use variables with !, &&, ||, and parentheses.")),
    };
  }

  return { ok: true, value: ast };
}

function sourceForBinding(binding: ResolvedKeybindingRule): KeybindingSource {
  if (String(binding.command).startsWith("script.")) {
    const source: KeybindingSource = "Project";
    return source;
  }

  const bindingKey = bindingToKeybindingInput(binding);
  const bindingWhen = whenAstToExpression(binding.whenAst);
  const isDefault = DEFAULT_BINDINGS.some(
    (entry) =>
      entry.command === binding.command &&
      bindingToKeybindingInput(entry) === bindingKey &&
      whenAstToExpression(entry.whenAst) === bindingWhen,
  );

  const source: KeybindingSource = isDefault ? "Default" : "Custom";
  return source;
}

function defaultBindingForBinding(
  binding: ResolvedKeybindingRule,
): ResolvedKeybindingRule | undefined {
  const bindingKey = bindingToKeybindingInput(binding);
  const bindingWhen = whenAstToExpression(binding.whenAst);

  return (
    DEFAULT_BINDINGS.find(
      (entry) =>
        entry.command === binding.command &&
        bindingToKeybindingInput(entry) === bindingKey &&
        whenAstToExpression(entry.whenAst) === bindingWhen,
    ) ??
    (bindingWhen === "false"
      ? DEFAULT_BINDINGS.find(
          (entry) =>
            entry.command === binding.command && bindingToKeybindingInput(entry) === bindingKey,
        )
      : undefined) ??
    DEFAULT_BINDINGS.find(
      (entry) =>
        entry.command === binding.command && whenAstToExpression(entry.whenAst) === bindingWhen,
    ) ??
    DEFAULT_BINDINGS.find((entry) => entry.command === binding.command)
  );
}

function keybindingRowId(command: KeybindingCommand, key: string, when: string): string {
  return `${command}\u0000${key}\u0000${when}`;
}

function conflictsWithWhen(leftWhen: string, rightWhen: string): boolean {
  if (leftWhen === "false" || rightWhen === "false") return false;
  return leftWhen.length === 0 || rightWhen.length === 0 || leftWhen === rightWhen;
}

export function keybindingConflictLabels(
  rows: ReadonlyArray<KeybindingRow>,
  input: { readonly rowId: string; readonly key: string; readonly when: string },
  platform = navigator.platform,
  resolve: MessageResolver = m,
): ReadonlyArray<string> {
  if (input.key.trim().length === 0) return [];
  const steps = parseKeybindingSequence(input.key);
  if (!steps?.[0]) return [];
  // Compare resolved chords so mod+k and ctrl+k collide where mod is Ctrl.
  const conflictKey = bindingConflictKey(
    { shortcut: steps[0], ...(steps.length > 1 ? { sequence: steps } : {}) },
    platform,
  );
  const conflicts: Array<string> = [];
  for (const candidate of rows) {
    if (
      candidate.id !== input.rowId &&
      bindingConflictKey(candidate.binding, platform) === conflictKey &&
      conflictsWithWhen(candidate.when, input.when)
    ) {
      conflicts.push(commandLabel(candidate.command, resolve));
    }
  }
  return [...new Set(conflicts)].toSorted();
}

export interface KeybindingGroup {
  readonly id: string;
  readonly title: string;
  readonly rows: ReadonlyArray<KeybindingRow>;
}

const KEYBINDING_GROUPS = [
  {
    id: "navigation",
    title: msg("Navigation"),
    prefixes: ["sidebar", "rightPanel", "commandPalette", "filePicker", "projectSearch", "editor"],
  },
  { id: "threads", title: msg("Threads"), prefixes: ["thread", "chat", "pullRequest"] },
  { id: "composer", title: msg("Composer"), prefixes: ["composer", "modelPicker"] },
  {
    id: "moving",
    title: msg("Moving around"),
    prefixes: ["workspace", "list", "scroll", "conversation", "hints", "keybindings"],
  },
  { id: "terminal", title: msg("Terminal"), prefixes: ["terminal"] },
  { id: "preview", title: msg("Preview & diff"), prefixes: ["preview", "diff"] },
  {
    id: "appearance",
    title: msg("Appearance"),
    prefixes: ["theme", "appearance", "themeEditor"],
  },
  { id: "scripts", title: msg("Project scripts"), prefixes: ["script"] },
] as const;
const OTHER_KEYBINDING_GROUP = {
  id: "other",
  title: msg("Other", { $context: "keybinding group" }),
} as const;

function keybindingGroupFor(command: KeybindingCommand): { id: string; title: string } {
  const prefix = String(command).split(".")[0] ?? "";
  return (
    KEYBINDING_GROUPS.find((group) => (group.prefixes as ReadonlyArray<string>).includes(prefix)) ??
    OTHER_KEYBINDING_GROUP
  );
}

export function groupKeybindingRows(
  rows: ReadonlyArray<KeybindingRow>,
): ReadonlyArray<KeybindingGroup> {
  const rowsByGroup = new Map<string, Array<KeybindingRow>>();
  for (const row of rows) {
    const group = keybindingGroupFor(row.command);
    const bucket = rowsByGroup.get(group.id);
    if (bucket) bucket.push(row);
    else rowsByGroup.set(group.id, [row]);
  }
  return [...KEYBINDING_GROUPS, OTHER_KEYBINDING_GROUP].flatMap((group) => {
    const groupRows = rowsByGroup.get(group.id);
    return groupRows ? [{ id: group.id, title: group.title, rows: groupRows }] : [];
  });
}

export function buildKeybindingRows(
  keybindings: ResolvedKeybindingsConfig,
  platform = navigator.platform,
  resolve: MessageResolver = m,
): ReadonlyArray<KeybindingRow> {
  const rowsById = new Map<string, KeybindingRow>();
  for (const binding of keybindings) {
    const defaultBinding = defaultBindingForBinding(binding);
    const key = bindingToKeybindingInput(binding);
    const when = whenAstToExpression(binding.whenAst);
    const id = keybindingRowId(binding.command, key, when);
    rowsById.set(id, {
      id,
      command: binding.command,
      key,
      when,
      source: sourceForBinding(binding),
      isUnassigned:
        when === "false" &&
        defaultBinding !== undefined &&
        key === bindingToKeybindingInput(defaultBinding),
      defaultKey: defaultBinding ? bindingToKeybindingInput(defaultBinding) : null,
      defaultWhen: whenAstToExpression(defaultBinding?.whenAst),
      binding,
      conflicts: [],
    });
  }
  const rows = [...rowsById.values()];

  const rowsWithConflicts = rows.map((row) => {
    const conflicts = keybindingConflictLabels(
      rows,
      {
        rowId: row.id,
        key: row.key,
        when: row.when,
      },
      platform,
      resolve,
    );
    return conflicts.length > 0
      ? Object.assign({}, row, { conflicts: [...new Set(conflicts)].toSorted() })
      : row;
  });

  rowsWithConflicts.sort((left, right) => {
    const commandCompare = compareCommands(left.command, right.command, (command) => command);
    if (commandCompare !== 0) return commandCompare;
    return left.key.localeCompare(right.key);
  });

  return rowsWithConflicts;
}

export function filterKeybindingRows(
  rows: ReadonlyArray<KeybindingRow>,
  query: string,
  resolve: MessageResolver = m,
): ReadonlyArray<KeybindingRow> {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return rows;
  return rows.filter((row) => {
    return (
      row.command.toLowerCase().includes(normalizedQuery) ||
      commandLabel(row.command, resolve).toLowerCase().includes(normalizedQuery) ||
      row.key.toLowerCase().includes(normalizedQuery) ||
      row.when.toLowerCase().includes(normalizedQuery) ||
      row.source.toLowerCase().includes(normalizedQuery)
    );
  });
}

function collectWhenIdentifiersFromNode(
  node: KeybindingWhenNode | undefined,
  identifiers: Set<string>,
): void {
  if (!node) return;
  switch (node.type) {
    case "identifier":
      identifiers.add(node.name);
      return;
    case "not":
      collectWhenIdentifiersFromNode(node.node, identifiers);
      return;
    case "and":
    case "or":
      collectWhenIdentifiersFromNode(node.left, identifiers);
      collectWhenIdentifiersFromNode(node.right, identifiers);
      return;
  }
}

export function isKnownWhenVariable(identifier: string): boolean {
  return KNOWN_WHEN_VARIABLES.has(identifier);
}

export function unknownWhenVariables(node: KeybindingWhenNode | undefined): ReadonlyArray<string> {
  const identifiers = new Set<string>();
  collectWhenIdentifiersFromNode(node, identifiers);
  return [...identifiers].filter((identifier) => !isKnownWhenVariable(identifier)).toSorted();
}

export function buildWhenVariableOptions(): ReadonlyArray<WhenVariableOption> {
  return [...KNOWN_WHEN_VARIABLES].toSorted((left, right) => {
    const leftCoreIndex = CORE_WHEN_VARIABLES.indexOf(left as (typeof CORE_WHEN_VARIABLES)[number]);
    const rightCoreIndex = CORE_WHEN_VARIABLES.indexOf(
      right as (typeof CORE_WHEN_VARIABLES)[number],
    );
    if (leftCoreIndex !== -1 || rightCoreIndex !== -1) {
      return (
        (leftCoreIndex === -1 ? Number.MAX_SAFE_INTEGER : leftCoreIndex) -
        (rightCoreIndex === -1 ? Number.MAX_SAFE_INTEGER : rightCoreIndex)
      );
    }
    return left.localeCompare(right);
  });
}

export function buildKeybindingCommandOptions(
  keybindings: ResolvedKeybindingsConfig,
  resolve: MessageResolver = m,
): ReadonlyArray<KeybindingCommandOption> {
  const commands = new Set<KeybindingCommand>(STATIC_KEYBINDING_COMMANDS);
  for (const binding of keybindings) {
    commands.add(binding.command);
  }
  return [...commands].toSorted((left, right) =>
    compareCommands(left, right, (command) => commandLabel(command, resolve)),
  );
}

const COMMAND_LABELS: Partial<Record<KeybindingCommand, string>> = {
  "workspace.focusNext": msg("Focus Next Workspace Area"),
  "workspace.focusPrevious": msg("Focus Previous Workspace Area"),
  "composer.sendAlternate": msg("Composer: Opposite Queue or Steer Action"),
  "composer.sendBackground": msg("Composer: Start in Background"),
  "composer.sendAndNewThread": msg("Composer: Send and Start New Thread"),
  "composer.dictation": msg("Composer: Start or Finish Dictation"),
  "thread.steerQueuedMessage": msg("Queue: Send First Queued Message"),
  "thread.editQueuedMessage": msg("Queue: Edit Last Queued Message"),
  "thread.copyReference": msg("Pull Request: Copy Link or Thread"),
  "sidebar.toggle": msg("Sidebar: Toggle"),
  "navigation.back": msg("Navigation: Back"),
  "navigation.forward": msg("Navigation: Forward"),
  "terminal.toggle": msg("Terminal: Toggle"),
  "terminal.split": msg("Terminal: Split"),
  "terminal.splitVertical": msg("Terminal: Split Vertical"),
  "terminal.new": msg("Terminal: New"),
  "terminal.close": msg("Terminal: Close"),
  "rightPanel.toggle": msg("Right Panel: Toggle"),
  "rightPanel.new": msg("Right Panel: New"),
  "threadPanel.toggle": msg("Thread Panel: Toggle"),
  "rightPanel.toggleMaximized": msg("Right Panel: Toggle Maximized"),
  "rightPanel.close": msg("Right Panel: Close"),
  "pullRequest.copyNumber": msg("Pull Request: Copy Number"),
  "diff.toggle": msg("Diff: Toggle"),
  "preview.toggle": msg("Preview: Toggle"),
  "preview.refresh": msg("Preview: Refresh"),
  "preview.zoomIn": msg("Preview: Zoom In"),
  "preview.zoomOut": msg("Preview: Zoom Out"),
  "preview.resetZoom": msg("Preview: Reset Zoom"),
  "commandPalette.toggle": msg("Command Palette: Toggle"),
  "filePicker.toggle": msg("File Picker: Toggle"),
  "projectSearch.toggle": msg("Project Search: Toggle"),
  "usage.open": msg("Usage: Open"),
  "theme.select": msg("Theme: Select"),
  "appearance.cycle": msg("Appearance: Cycle"),
  "themeEditor.toggle": msg("Theme Editor: Toggle"),
  "composer.stash": msg("Composer: Stash"),
  "composer.host": msg("Composer: Host"),
  "composer.cycleHost": msg("Composer: Cycle Host"),
  "composer.effort": msg("Composer: Effort"),
  "composer.increaseEffort": msg("Composer: Increase Effort"),
  "composer.decreaseEffort": msg("Composer: Decrease Effort"),
  "composer.mode": msg("Composer: Mode"),
  "composer.workspace": msg("Composer: Workspace"),
  "composer.previousWorktree": msg("Composer: Previous Worktree"),
  "composer.branch": msg("Composer: Branch"),
  "chat.new": msg("Chat: New"),
  "chat.newLocal": msg("Chat: New Local"),
  "chat.newWithoutProject": msg("Chat: New Without Project"),
  "chat.find": msg("Chat: Find"),
  "editor.openFavorite": msg("Editor: Open Favorite"),
  "modelPicker.toggle": msg("Model Picker: Toggle"),
  "modelPicker.previousProvider": msg("Model Picker: Previous Provider"),
  "modelPicker.nextProvider": msg("Model Picker: Next Provider"),
  "thread.stop": msg("Thread: Stop"),
  "thread.previous": msg("Thread: Previous"),
  "thread.next": msg("Thread: Next"),
  "thread.settle": msg("Thread: Settle"),
  "thread.pin": msg("Thread: Pin"),
  "thread.regenerateTitle": msg("Thread: Regenerate Title"),
  "thread.undo": msg("Thread: Undo"),
};

// Whole labels: search titles keep the encoded message, which cannot nest another one.
const USAGE_COMMAND_LABELS: Record<
  (typeof METRIC_OPTIONS)[number]["command"] | (typeof WINDOW_OPTIONS)[number]["command"],
  string
> = {
  "usage.cost": msg("Usage: Cost"),
  "usage.tokens": msg("Usage: Tokens"),
  "usage.limits": msg("Usage: Limits"),
  "usage.period.day": msg("Usage: Period: Past 24h"),
  "usage.period.week": msg("Usage: Period: 7 days"),
  "usage.period.month": msg("Usage: Period: 30 days"),
  "usage.period.quarter": msg("Usage: Period: 90 days"),
};

const LATE_COMMAND_LABELS: Partial<Record<KeybindingCommand, string>> = {
  "view.reopenClosed": msg("Reopen Closed Tab"),
  "preview.focusUrl": msg("Preview: Focus URL"),
  "preview.find": msg("Preview: Find on Page"),
};

const VIM_COMMAND_LABELS: Record<(typeof VIM_KEYBINDING_COMMANDS)[number], string> = {
  "workspace.focusLeft": msg("Focus Workspace Area to the Left"),
  "workspace.focusRight": msg("Focus Workspace Area to the Right"),
  "workspace.focusUp": msg("Focus Workspace Area Above"),
  "workspace.focusDown": msg("Focus Workspace Area Below"),
  "workspace.leaveTerminal": msg("Leave the Terminal or Browser Page"),
  "composer.focus": msg("Composer: Focus"),
  "list.next": msg("List: Next Item"),
  "list.previous": msg("List: Previous Item"),
  "list.first": msg("List: First Item"),
  "list.last": msg("List: Last Item"),
  "list.pageDown": msg("List: Half Page Down"),
  "list.pageUp": msg("List: Half Page Up"),
  "list.open": msg("List: Open or Expand"),
  "list.close": msg("List: Collapse"),
  "sidebar.renameThread": msg("Sidebar: Rename Thread"),
  "sidebar.archiveThread": msg("Sidebar: Archive Thread"),
  "sidebar.copyThreadReference": msg("Sidebar: Copy Thread Link"),
  "sidebar.search": msg("Sidebar: Search Threads"),
  "conversation.next": msg("Conversation: Next Message"),
  "conversation.previous": msg("Conversation: Previous Message"),
  "conversation.nextPrompt": msg("Conversation: Next Prompt"),
  "conversation.previousPrompt": msg("Conversation: Previous Prompt"),
  "conversation.first": msg("Conversation: First Message"),
  "conversation.last": msg("Conversation: Last Message"),
  "conversation.toggle": msg("Conversation: Expand or Collapse"),
  "conversation.copy": msg("Conversation: Copy Message"),
  "scroll.lineDown": msg("Scroll: Line Down"),
  "scroll.lineUp": msg("Scroll: Line Up"),
  "scroll.halfPageDown": msg("Scroll: Half Page Down"),
  "scroll.halfPageUp": msg("Scroll: Half Page Up"),
  "scroll.top": msg("Scroll: Top"),
  "scroll.bottom": msg("Scroll: Bottom"),
  "chat.findNext": msg("Chat: Next Match"),
  "chat.findPrevious": msg("Chat: Previous Match"),
  "diff.nextHunk": msg("Diff: Next Hunk"),
  "diff.previousHunk": msg("Diff: Previous Hunk"),
  "diff.nextFile": msg("Diff: Next File"),
  "diff.previousFile": msg("Diff: Previous File"),
  "diff.toggleFile": msg("Diff: Fold or Unfold File"),
  "rightPanel.nextTab": msg("Right Panel: Next Tab"),
  "rightPanel.previousTab": msg("Right Panel: Previous Tab"),
  "hints.click": msg("Hints: Click a Control"),
  "hints.focus": msg("Hints: Focus a Control"),
  "keybindings.cheatSheet": msg("Keybindings: Show Cheat Sheet"),
};

export function commandLabel(command: KeybindingCommand, resolve: MessageResolver = m): string {
  const label = COMMAND_LABELS[command];
  if (label) return resolve(label);
  const usageLabel = USAGE_COMMAND_LABELS[command as keyof typeof USAGE_COMMAND_LABELS];
  if (usageLabel) return resolve(usageLabel);
  const lateLabel = LATE_COMMAND_LABELS[command];
  if (lateLabel) return resolve(lateLabel);
  const vimLabel = VIM_COMMAND_LABELS[command as keyof typeof VIM_COMMAND_LABELS];
  if (vimLabel) return resolve(vimLabel);
  const raw = String(command);
  if (raw.startsWith("thread.jump.")) {
    return resolve(msg("Thread: Jump: {n}", { n: raw.slice("thread.jump.".length) }));
  }
  if (raw.startsWith("modelPicker.jump.")) {
    return resolve(msg("Model Picker: Jump: {n}", { n: raw.slice("modelPicker.jump.".length) }));
  }
  if (raw.startsWith("script.") && raw.endsWith(".run")) {
    return resolve(
      msg("Run Script: {name}", {
        name: titleCaseCommandSegment(raw.slice("script.".length, -".run".length)),
      }),
    );
  }
  return raw.split(".").map(titleCaseCommandSegment).join(": ");
}

function titleCaseCommandSegment(segment: string): string {
  const words: Array<string> = [];
  for (const part of segment.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[-_\s]+/)) {
    if (part.length > 0) {
      words.push(part.slice(0, 1).toUpperCase() + part.slice(1));
    }
  }
  return words.join(" ");
}

function recordedLayoutShortcutKey(
  event: Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "altKey">,
): string {
  const physicalKey = shortcutKeyFromEvent(event);
  const layoutKey = event.key.toLowerCase();
  if (event.altKey || layoutKey.length !== 1) return physicalKey;
  // Normalize only US shifted glyphs at their US position. Other layouts can
  // produce the same glyph without Shift or at a different position.
  const unshiftedKey = event.shiftKey ? US_SHIFTED_TO_UNSHIFTED_KEYS.get(layoutKey) : undefined;
  return unshiftedKey === physicalKey ? physicalKey : layoutKey;
}

function normalizeShortcutKeyToken(key: string): string | null {
  const normalized = key.toLowerCase();
  if (
    normalized === "meta" ||
    normalized === "control" ||
    normalized === "ctrl" ||
    normalized === "shift" ||
    normalized === "alt" ||
    normalized === "option"
  ) {
    return null;
  }
  if (normalized === " ") return "space";
  if (normalized === "escape") return "esc";
  if (normalized === "arrowup") return "arrowup";
  if (normalized === "arrowdown") return "arrowdown";
  if (normalized === "arrowleft") return "arrowleft";
  if (normalized === "arrowright") return "arrowright";
  if (normalized.length === 1) return normalized;
  if (/^f\d{1,2}$/.test(normalized)) return normalized;
  if (normalized === "enter" || normalized === "tab" || normalized === "backspace") {
    return normalized;
  }
  if (normalized === "delete" || normalized === "home" || normalized === "end") {
    return normalized;
  }
  if (normalized === "pageup" || normalized === "pagedown") return normalized;
  return null;
}

/** Keys recorded within a second of each other, vim's `timeoutlen`, make one sequence. */
const KEYBINDING_SEQUENCE_RECORD_MS = 1000;

/** The recorded binding after another key: the next step of a sequence, or a new binding. */
export function recordKeybindingStep(
  previous: { readonly keys: string; readonly at: number } | null,
  step: string,
  at: number,
): string {
  if (!previous || at - previous.at > KEYBINDING_SEQUENCE_RECORD_MS) return step;
  if (previous.keys.split(" ").length >= MAX_KEYBINDING_SEQUENCE_STEPS) return step;
  return `${previous.keys} ${step}`;
}

export function keybindingFromKeyboardEvent(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform: string,
  options?: {
    readonly layoutCharacter?: boolean;
  },
): string | null {
  const keyToken = normalizeShortcutKeyToken(
    options?.layoutCharacter ? recordedLayoutShortcutKey(event) : shortcutKeyFromEvent(event),
  );
  if (!keyToken) return null;

  const parts: string[] = [];
  if (isMacPlatform(platform)) {
    if (event.metaKey) parts.push("mod");
    if (event.ctrlKey) parts.push("ctrl");
  } else {
    if (event.ctrlKey) parts.push("mod");
    if (event.metaKey) parts.push("meta");
  }
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  parts.push(keyToken);
  return parts.join("+");
}
