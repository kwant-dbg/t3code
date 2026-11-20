import {
  type KeybindingRule,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  MAX_KEYBINDING_SEQUENCE_STEPS,
  MAX_KEYBINDINGS_COUNT,
  MAX_WHEN_EXPRESSION_DEPTH,
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
  type ResolvedKeybindingRule,
  type ResolvedKeybindingsConfig,
  THREAD_JUMP_KEYBINDING_COMMANDS,
} from "@t3tools/contracts";

export {
  EVENT_CODE_SHORTCUT_KEYS,
  isMacPlatform,
  matchesKeybindingShortcut,
  matchesKeybindingShortcutModifiers,
  normalizeEventKey,
  resolveEventKeys,
  shortcutKeyFromEvent,
  type ShortcutEventLike,
  type ShortcutModifierStateLike,
} from "./keybindingMatching.ts";

export const US_SHIFTED_TO_UNSHIFTED_KEYS: ReadonlyMap<string, string> = new Map([
  ["!", "1"],
  ["@", "2"],
  ["#", "3"],
  ["$", "4"],
  ["%", "5"],
  ["^", "6"],
  ["&", "7"],
  ["*", "8"],
  ["(", "9"],
  [")", "0"],
  ["~", "`"],
  ["_", "-"],
  ["+", "="],
  ["{", "["],
  ["}", "]"],
  ["|", "\\"],
  [":", ";"],
  ['"', "'"],
  ["<", ","],
  [">", "."],
  ["?", "/"],
]);

type WhenToken =
  | { type: "identifier"; value: string }
  | { type: "not" }
  | { type: "and" }
  | { type: "or" }
  | { type: "lparen" }
  | { type: "rparen" };

export const DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingRule> = [
  { key: "mod+b", command: "sidebar.toggle" },
  { key: "f6", command: "workspace.focusNext" },
  { key: "shift+f6", command: "workspace.focusPrevious" },
  // Some browsers keep plain F6 for their own toolbars; mod+F6 reaches the page in all of them.
  { key: "mod+f6", command: "workspace.focusNext" },
  { key: "mod+shift+f6", command: "workspace.focusPrevious" },
  { key: "mod+[", command: "navigation.back", when: "!terminalFocus" },
  { key: "mod+]", command: "navigation.forward", when: "!terminalFocus" },
  { key: "mod+j", command: "terminal.toggle" },
  { key: "mod+alt+b", command: "rightPanel.toggle" },
  { key: "mod+shift+b", command: "threadPanel.toggle", when: "!terminalFocus" },
  { key: "mod+t", command: "rightPanel.new", when: "rightPanelOpen && !terminalFocus" },
  { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
  { key: "mod+shift+d", command: "terminal.splitVertical", when: "terminalFocus" },
  { key: "mod+shift+d", command: "composer.dictation", when: "!terminalFocus" },
  { key: "mod+n", command: "terminal.new", when: "terminalFocus" },
  { key: "mod+w", command: "terminal.close", when: "terminalFocus" },
  { key: "mod+w", command: "rightPanel.close", when: "!terminalFocus" },
  { key: "mod+shift+t", command: "view.reopenClosed" },
  { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
  { key: "mod+shift+j", command: "preview.toggle" },
  { key: "mod+r", command: "preview.refresh", when: "previewFocus" },
  { key: "mod+l", command: "preview.focusUrl", when: "previewFocus" },
  { key: "mod+=", command: "preview.zoomIn", when: "previewFocus" },
  { key: "mod++", command: "preview.zoomIn", when: "previewFocus" },
  { key: "mod+-", command: "preview.zoomOut", when: "previewFocus" },
  { key: "mod+0", command: "preview.resetZoom", when: "previewFocus" },
  { key: "mod+f", command: "preview.find", when: "previewFocus" },
  { key: "mod+k", command: "commandPalette.toggle", when: "!terminalFocus" },
  { key: "mod+p", command: "filePicker.toggle", when: "!terminalFocus" },
  { key: "mod+shift+f", command: "projectSearch.toggle", when: "!terminalFocus" },
  { key: "mod+u", command: "usage.open", when: "!terminalFocus" },
  { key: "mod+alt+a", command: "theme.select", when: "!terminalFocus" },
  { key: "mod+alt+shift+a", command: "appearance.cycle", when: "!terminalFocus" },
  { key: "mod+alt+shift+t", command: "themeEditor.toggle" },
  { key: "mod+s", command: "composer.stash", when: "!terminalFocus" },
  { key: "mod+shift+enter", command: "thread.steerQueuedMessage", when: "!terminalFocus" },
  { key: "alt+arrowup", command: "thread.editQueuedMessage", when: "composerFocus" },
  { key: "mod+enter", command: "composer.sendAlternate", when: "composerFocus && turnRunning" },
  {
    key: "mod+enter",
    command: "composer.sendBackground",
    when: "composerFocus && draftThreadRoute",
  },
  {
    key: "mod+alt+enter",
    command: "composer.sendBackground",
    when: "composerFocus && draftThreadRoute",
  },
  {
    key: "mod+alt+enter",
    command: "composer.sendAndNewThread",
    when: "composerFocus && !draftThreadRoute",
  },
  { key: "mod+n", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+o", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+n", command: "chat.newLocal", when: "!terminalFocus" },
  { key: "mod+alt+n", command: "chat.newWithoutProject", when: "!terminalFocus" },
  { key: "mod+f", command: "chat.find", when: "!terminalFocus && !previewFocus" },
  { key: "mod+shift+m", command: "modelPicker.toggle", when: "!terminalFocus" },
  { key: "mod+shift+h", command: "composer.host", when: "!terminalFocus" },
  { key: "mod+shift+e", command: "composer.effort", when: "!terminalFocus" },
  { key: "mod+shift+a", command: "composer.mode", when: "!terminalFocus" },
  { key: "mod+shift+x", command: "composer.workspace", when: "!terminalFocus" },
  { key: "mod+shift+g", command: "composer.branch", when: "!terminalFocus" },
  { key: "mod+shift+l", command: "composer.previousWorktree", when: "!terminalFocus" },
  { key: "mod+shift+k", command: "pullRequest.copyNumber", when: "!terminalFocus" },
  { key: "mod+shift+arrowup", command: "modelPicker.previousProvider", when: "modelPickerOpen" },
  { key: "mod+shift+arrowdown", command: "modelPicker.nextProvider", when: "modelPickerOpen" },
  { key: "mod+o", command: "editor.openFavorite" },
  { key: "mod+shift+[", command: "thread.previous" },
  { key: "mod+shift+]", command: "thread.next" },
  { key: "mod+shift+c", command: "thread.copyReference", when: "!terminalFocus" },
  { key: "mod+shift+s", command: "thread.settle", when: "!terminalFocus" },
  { key: "mod+shift+p", command: "thread.pin", when: "!terminalFocus" },
  { key: "mod+z", command: "thread.undo", when: "!terminalFocus && !editableFocus" },
  ...THREAD_JUMP_KEYBINDING_COMMANDS.map((command, index) => ({
    key: `mod+${index + 1}`,
    command,
    when: "!modelPickerOpen && isDesktop",
  })),
  ...MODEL_PICKER_JUMP_KEYBINDING_COMMANDS.map((command, index) => ({
    key: `mod+${index + 1}`,
    command,
    when: "modelPickerOpen && isDesktop",
  })),
  { key: "c", command: "usage.cost", when: "usagePageOpen" },
  { key: "t", command: "usage.tokens", when: "usagePageOpen" },
  { key: "l", command: "usage.limits", when: "usagePageOpen" },
  { key: "mod+shift+1", command: "usage.period.day", when: "usagePageOpen" },
  { key: "mod+shift+2", command: "usage.period.week", when: "usagePageOpen" },
  { key: "mod+shift+3", command: "usage.period.month", when: "usagePageOpen" },
  { key: "mod+shift+4", command: "usage.period.quarter", when: "usagePageOpen" },
];

const VIM_LEADER_BINDINGS = [
  ["t", "terminal.toggle"],
  ["d", "diff.toggle"],
  ["p", "preview.toggle"],
  ["b", "sidebar.toggle"],
  ["m", "modelPicker.toggle"],
  ["e", "composer.effort"],
  ["n", "chat.new"],
] as const;

/** App Normal mode: vim is on and no text box has focus. `area` narrows it to one place. */
const vimApp = (area?: string) =>
  area ? `vimNormal && !editableFocus && ${area}` : "vimNormal && !editableFocus";

/**
 * Vim mode's app keys. Clients add them under the user's rules only while vim mode is on, and
 * they are never written to keybindings.json: that file and the wire keep the 256-rule cap
 * for the user's own rules. A user's own rules for a command replace these for it.
 */
export const VIM_DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingRule> = [
  // Also from a text box in Normal mode, as vim's window moves are.
  { key: "ctrl+w h", command: "workspace.focusLeft", when: "vimNormal" },
  { key: "ctrl+w j", command: "workspace.focusDown", when: "vimNormal" },
  { key: "ctrl+w k", command: "workspace.focusUp", when: "vimNormal" },
  { key: "ctrl+w l", command: "workspace.focusRight", when: "vimNormal" },
  {
    key: "ctrl+\\ ctrl+n",
    command: "workspace.leaveTerminal",
    when: "vimMode && (terminalFocus || previewFocus)",
  },
  { key: "i", command: "composer.focus", when: vimApp() },
  { key: "a", command: "composer.focus", when: vimApp() },
  { key: "shift+;", command: "commandPalette.toggle", when: vimApp() },
  { key: "shift+/", command: "keybindings.cheatSheet", when: vimApp() },
  { key: "f", command: "hints.click", when: vimApp() },
  { key: "shift+f", command: "hints.focus", when: vimApp() },
  { key: "ctrl+o", command: "navigation.back", when: vimApp() },
  { key: "ctrl+i", command: "navigation.forward", when: vimApp() },
  { key: "g t", command: "rightPanel.nextTab", when: vimApp() },
  { key: "g shift+t", command: "rightPanel.previousTab", when: vimApp() },
  ...VIM_LEADER_BINDINGS.map(([key, command]) => ({
    key: `space ${key}`,
    command,
    when: vimApp(),
  })),
  { key: "ctrl+e", command: "scroll.lineDown", when: vimApp("!listFocus") },
  { key: "ctrl+y", command: "scroll.lineUp", when: vimApp("!listFocus") },
  { key: "ctrl+d", command: "scroll.halfPageDown", when: vimApp("!listFocus") },
  { key: "ctrl+u", command: "scroll.halfPageUp", when: vimApp("!listFocus") },
  // The diff and file views in the right panel.
  { key: "j", command: "scroll.lineDown", when: vimApp("rightPanelFocus && !listFocus") },
  { key: "k", command: "scroll.lineUp", when: vimApp("rightPanelFocus && !listFocus") },
  { key: "g g", command: "scroll.top", when: vimApp("rightPanelFocus && !listFocus") },
  { key: "shift+g", command: "scroll.bottom", when: vimApp("rightPanelFocus && !listFocus") },
  { key: "] c", command: "diff.nextHunk", when: vimApp("rightPanelFocus") },
  { key: "[ c", command: "diff.previousHunk", when: vimApp("rightPanelFocus") },
  { key: "] f", command: "diff.nextFile", when: vimApp("rightPanelFocus") },
  { key: "[ f", command: "diff.previousFile", when: vimApp("rightPanelFocus") },
  { key: "z a", command: "diff.toggleFile", when: vimApp("rightPanelFocus") },
  { key: "q", command: "rightPanel.close", when: vimApp("rightPanelFocus") },
  // A cursor that moves between messages.
  { key: "j", command: "conversation.next", when: vimApp("conversationFocus") },
  { key: "k", command: "conversation.previous", when: vimApp("conversationFocus") },
  { key: "] ]", command: "conversation.nextPrompt", when: vimApp("conversationFocus") },
  { key: "[ [", command: "conversation.previousPrompt", when: vimApp("conversationFocus") },
  { key: "g g", command: "conversation.first", when: vimApp("conversationFocus") },
  { key: "shift+g", command: "conversation.last", when: vimApp("conversationFocus") },
  { key: "enter", command: "conversation.toggle", when: vimApp("conversationFocus") },
  { key: "z a", command: "conversation.toggle", when: vimApp("conversationFocus") },
  { key: "y y", command: "conversation.copy", when: vimApp("conversationFocus") },
  { key: "/", command: "chat.find", when: vimApp("conversationFocus") },
  { key: "n", command: "chat.findNext", when: vimApp("conversationFocus") },
  { key: "shift+n", command: "chat.findPrevious", when: vimApp("conversationFocus") },
  // Lists: sidebar threads, Settings sections, menus, the pull request list.
  { key: "j", command: "list.next", when: vimApp("listFocus") },
  { key: "k", command: "list.previous", when: vimApp("listFocus") },
  { key: "g g", command: "list.first", when: vimApp("listFocus") },
  { key: "shift+g", command: "list.last", when: vimApp("listFocus") },
  { key: "ctrl+d", command: "list.pageDown", when: vimApp("listFocus") },
  { key: "ctrl+u", command: "list.pageUp", when: vimApp("listFocus") },
  { key: "l", command: "list.open", when: vimApp("listFocus") },
  { key: "h", command: "list.close", when: vimApp("listFocus") },
  { key: "r", command: "sidebar.renameThread", when: vimApp("sidebarFocus") },
  { key: "d d", command: "sidebar.archiveThread", when: vimApp("sidebarFocus") },
  { key: "y y", command: "sidebar.copyThreadReference", when: vimApp("sidebarFocus") },
  { key: "/", command: "sidebar.search", when: vimApp("sidebarFocus") },
  // Pickers keep focus in their search box, so these work while typing in it.
  { key: "ctrl+n", command: "list.next", when: "vimMode && popupOpen" },
  { key: "ctrl+p", command: "list.previous", when: "vimMode && popupOpen" },
];

function rulesByCommand(rules: ResolvedKeybindingsConfig): Map<string, string> {
  const byCommand = new Map<string, string[]>();
  for (const rule of rules) {
    const entry = JSON.stringify([rule.sequence ?? rule.shortcut, rule.whenAst ?? null]);
    byCommand.set(rule.command, [...(byCommand.get(rule.command) ?? []), entry]);
  }
  return new Map([...byCommand].map(([command, entries]) => [command, entries.sort().join("\n")]));
}

/**
 * Vim's rules under the given ones, so those win a shared key. A command whose rules differ
 * from the app's defaults is the user's own, and vim's rules for it are left out.
 */
export function mergeVimKeybindings(
  vimDefaults: ResolvedKeybindingsConfig,
  keybindings: ResolvedKeybindingsConfig,
  appDefaults: ResolvedKeybindingsConfig = DEFAULT_RESOLVED_KEYBINDINGS,
): ResolvedKeybindingsConfig {
  const current = rulesByCommand(keybindings);
  const defaults = rulesByCommand(appDefaults);
  const customized = (command: string) =>
    current.has(command) && current.get(command) !== defaults.get(command);
  return [...vimDefaults.filter((binding) => !customized(binding.command)), ...keybindings];
}

function normalizeKeyToken(token: string): string {
  if (token === "space") return " ";
  if (token === "esc") return "escape";
  return token;
}

export function parseKeybindingShortcut(value: string): KeybindingShortcut | null {
  const rawTokens = value
    .toLowerCase()
    .split("+")
    .map((token) => token.trim());
  const tokens = [...rawTokens];
  let trailingEmptyCount = 0;
  while (tokens[tokens.length - 1] === "") {
    trailingEmptyCount += 1;
    tokens.pop();
  }
  if (trailingEmptyCount > 0) {
    tokens.push("+");
  }
  if (tokens.some((token) => token.length === 0)) {
    return null;
  }
  if (tokens.length === 0) return null;

  let key: string | null = null;
  let metaKey = false;
  let ctrlKey = false;
  let shiftKey = false;
  let altKey = false;
  let modKey = false;

  for (const token of tokens) {
    switch (token) {
      case "cmd":
      case "meta":
        metaKey = true;
        break;
      case "ctrl":
      case "control":
        ctrlKey = true;
        break;
      case "shift":
        shiftKey = true;
        break;
      case "alt":
      case "option":
        altKey = true;
        break;
      case "mod":
        modKey = true;
        break;
      default: {
        if (key !== null) return null;
        key = normalizeKeyToken(token);
      }
    }
  }

  if (key === null) return null;
  return {
    key,
    metaKey,
    ctrlKey,
    shiftKey,
    altKey,
    modKey,
  };
}

/**
 * A binding's keys: one shortcut, or a sequence whose steps are separated by spaces, such as
 * `g g`, `space t` or `ctrl+w h`. Spaces around `+` stay inside a step: `mod + k` is one key.
 */
export function parseKeybindingSequence(value: string): KeybindingShortcut[] | null {
  const steps = value
    .trim()
    .replace(/\s*\+\s*/g, "+")
    .split(/\s+/);
  if (steps.length > MAX_KEYBINDING_SEQUENCE_STEPS) return null;
  const shortcuts: KeybindingShortcut[] = [];
  for (const step of steps) {
    const shortcut = parseKeybindingShortcut(step);
    if (!shortcut) return null;
    shortcuts.push(shortcut);
  }
  return shortcuts;
}

function tokenizeWhenExpression(expression: string): WhenToken[] | null {
  const tokens: WhenToken[] = [];
  let index = 0;

  while (index < expression.length) {
    const current = expression[index];
    if (!current) break;

    if (/\s/.test(current)) {
      index += 1;
      continue;
    }
    if (expression.startsWith("&&", index)) {
      tokens.push({ type: "and" });
      index += 2;
      continue;
    }
    if (expression.startsWith("||", index)) {
      tokens.push({ type: "or" });
      index += 2;
      continue;
    }
    if (current === "!") {
      tokens.push({ type: "not" });
      index += 1;
      continue;
    }
    if (current === "(") {
      tokens.push({ type: "lparen" });
      index += 1;
      continue;
    }
    if (current === ")") {
      tokens.push({ type: "rparen" });
      index += 1;
      continue;
    }

    const identifier = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(expression.slice(index));
    if (!identifier) {
      return null;
    }
    tokens.push({ type: "identifier", value: identifier[0] });
    index += identifier[0].length;
  }

  return tokens;
}

export function parseKeybindingWhenExpression(expression: string): KeybindingWhenNode | null {
  const tokens = tokenizeWhenExpression(expression);
  if (!tokens || tokens.length === 0) return null;
  let index = 0;

  const parsePrimary = (depth: number): KeybindingWhenNode | null => {
    if (depth > MAX_WHEN_EXPRESSION_DEPTH) {
      return null;
    }
    const token = tokens[index];
    if (!token) return null;

    if (token.type === "identifier") {
      index += 1;
      return { type: "identifier", name: token.value };
    }

    if (token.type === "lparen") {
      index += 1;
      const expressionNode = parseOr(depth + 1);
      const closeToken = tokens[index];
      if (!expressionNode || !closeToken || closeToken.type !== "rparen") {
        return null;
      }
      index += 1;
      return expressionNode;
    }

    return null;
  };

  const parseUnary = (depth: number): KeybindingWhenNode | null => {
    let notCount = 0;
    while (tokens[index]?.type === "not") {
      index += 1;
      notCount += 1;
      if (notCount > MAX_WHEN_EXPRESSION_DEPTH) {
        return null;
      }
    }

    let node = parsePrimary(depth);
    if (!node) return null;

    while (notCount > 0) {
      node = { type: "not", node };
      notCount -= 1;
    }

    return node;
  };

  const parseAnd = (depth: number): KeybindingWhenNode | null => {
    let left = parseUnary(depth);
    if (!left) return null;

    while (tokens[index]?.type === "and") {
      index += 1;
      const right = parseUnary(depth);
      if (!right) return null;
      left = { type: "and", left, right };
    }

    return left;
  };

  const parseOr = (depth: number): KeybindingWhenNode | null => {
    let left = parseAnd(depth);
    if (!left) return null;

    while (tokens[index]?.type === "or") {
      index += 1;
      const right = parseAnd(depth);
      if (!right) return null;
      left = { type: "or", left, right };
    }

    return left;
  };

  const ast = parseOr(0);
  if (!ast || index !== tokens.length) return null;
  return ast;
}

export function compileResolvedKeybindingRule(rule: KeybindingRule): ResolvedKeybindingRule | null {
  const steps = parseKeybindingSequence(rule.key);
  if (!steps) return null;
  const [first] = steps;
  if (!first) return null;
  const keys =
    steps.length === 1
      ? { shortcut: first }
      : {
          // Spaces never appear in a key a keypress produces, so this shortcut matches nothing.
          shortcut: {
            key: rule.key
              .trim()
              .toLowerCase()
              .replace(/\s*\+\s*/g, "+")
              .replace(/\s+/g, " "),
            metaKey: false,
            ctrlKey: false,
            shiftKey: false,
            altKey: false,
            modKey: false,
          },
          sequence: steps,
        };

  if (rule.when !== undefined) {
    const whenAst = parseKeybindingWhenExpression(rule.when);
    if (!whenAst) return null;
    return { command: rule.command, ...keys, whenAst };
  }

  return { command: rule.command, ...keys };
}

export function compileResolvedKeybindingsConfig(
  config: ReadonlyArray<KeybindingRule>,
): ResolvedKeybindingsConfig {
  const compiled: ResolvedKeybindingRule[] = [];
  for (const rule of config) {
    const result = compileResolvedKeybindingRule(rule);
    if (result) {
      compiled.push(result);
    }
  }
  return compiled.slice(-MAX_KEYBINDINGS_COUNT);
}

export const DEFAULT_RESOLVED_KEYBINDINGS = compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS);

export function mergeWithDefaultKeybindings(
  custom: ResolvedKeybindingsConfig,
): ResolvedKeybindingsConfig {
  if (custom.length === 0) {
    return [...DEFAULT_RESOLVED_KEYBINDINGS];
  }

  const overriddenCommands = new Set(custom.map((binding) => binding.command));
  const retainedDefaults = DEFAULT_RESOLVED_KEYBINDINGS.filter(
    (binding) => !overriddenCommands.has(binding.command),
  );
  const merged = [...retainedDefaults, ...custom];

  if (merged.length <= MAX_KEYBINDINGS_COUNT) {
    return merged;
  }

  return merged.slice(-MAX_KEYBINDINGS_COUNT);
}
