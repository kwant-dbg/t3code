import type {
  KeybindingCommand,
  KeybindingShortcut,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";

import {
  resolveShortcutCommand,
  resolveShortcutSequence,
  type ShortcutEventLike,
  type ShortcutMatchContext,
} from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryServerKeybindingsAtom } from "../state/server";
import { isTypingTarget, readVimContext, withVimKeybindings } from "../vim/vimKeybindings";

/** Return `false` to let the next scope handle the event. */
export type CommandHandler = (event: KeyboardEvent) => boolean | void;

export type CommandHandlers = Partial<Record<KeybindingCommand, CommandHandler>>;

export interface CommandScopeOptions {
  /** Read at event time; a scope whose guard fails is skipped. */
  readonly when?: (event: KeyboardEvent) => boolean;
  /** When-clause context the dispatcher cannot know (terminalOpen, previewOpen), read at event time. */
  readonly context?: () => Partial<ShortcutMatchContext>;
  readonly keybindings?: () => ResolvedKeybindingsConfig;
  /** For shortcuts that are not keybinding commands (Escape, "/"); runs before command lookup. */
  readonly onKeyDown?: CommandHandler;
  /**
   * Run in the capture phase, ahead of focused widgets that consume the key
   * themselves (the terminal encodes Ctrl+Shift+T and stops propagation).
   */
  readonly capture?: boolean;
  /**
   * Hear every bubbling keydown after the scopes ran, with whether one of them
   * (or the page) consumed it. Observers never consume. For listeners that react to keys other
   * scopes may also handle, such as scroll keys.
   */
  readonly observe?: (event: KeyboardEvent, consumed: boolean) => void;
}

interface CommandScope {
  readonly commands: CommandHandlers;
  readonly options: CommandScopeOptions;
}

// Within each list the newest scope wins.
const globalScopes: CommandScope[] = [];
const captureScopes: CommandScope[] = [];
const observerScopes: CommandScope[] = [];

// Every scope reads the same focus for one keydown.
const focusContexts = new WeakMap<KeyboardEvent, Partial<ShortcutMatchContext>>();

function readFocusContext(event: KeyboardEvent): Partial<ShortcutMatchContext> {
  const cached = focusContexts.get(event);
  if (cached) return cached;
  const focus = {
    terminalFocus: isTerminalFocused(),
    previewFocus: isPreviewFocused(),
    editableFocus: isEditableFocused(event.target),
    modelPickerOpen: isModelPickerOpen(),
  };
  const context = { ...focus, ...readVimContext(focus) };
  focusContexts.set(event, context);
  return context;
}

function scopeKeybindings(scope: CommandScope): ResolvedKeybindingsConfig {
  return withVimKeybindings(
    scope.options.keybindings?.() ?? appAtomRegistry.get(primaryServerKeybindingsAtom),
  );
}

function isInsideConfirmation(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[role="alertdialog"]') !== null;
}

function scopeCommandHandler(scope: CommandScope, event: KeyboardEvent) {
  const { commands, options } = scope;
  const command = resolveShortcutCommand(event, scopeKeybindings(scope), {
    context: { ...readFocusContext(event), ...options.context?.() },
  });
  return command === null ? undefined : commands[command];
}

function runScope(scope: CommandScope, event: KeyboardEvent): boolean {
  const { options } = scope;
  if (options.when && !options.when(event)) return false;
  if (options.onKeyDown && options.onKeyDown(event) !== false) return true;
  const handler = scopeCommandHandler(scope, event);
  if (handler === undefined) return false;
  if (isInsideConfirmation(event.target)) {
    event.preventDefault();
    return true;
  }
  return handler(event) !== false;
}

/**
 * Whether a bubble-phase command is bound to this keydown, for widgets that would otherwise
 * consume it. Capture scopes have already run (and declined) by the time a widget sees it.
 */
export function hasCommandForKeyDown(event: KeyboardEvent): boolean {
  return hasSingleKeyCommand(globalScopes, event) || matchSequence([event], event) !== null;
}

function hasSingleKeyCommand(scopes: readonly CommandScope[], event: KeyboardEvent): boolean {
  return scopes.some(
    (scope) =>
      (!scope.options.when || scope.options.when(event)) &&
      scopeCommandHandler(scope, event) !== undefined,
  );
}

// Multi-key bindings such as `g g`, `space t` and `ctrl+w h`. The keys typed so far wait up
// to a second for the next one, as vim's `timeoutlen` does.
const SEQUENCE_TIMEOUT_MS = 1000;
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"]);

export interface PendingKeySequence {
  readonly typed: ReadonlyArray<KeybindingShortcut>;
  readonly next: ReadonlyArray<{
    readonly step: KeybindingShortcut;
    readonly command: KeybindingCommand;
  }>;
}

type SequenceMatch =
  | {
      readonly type: "complete";
      readonly handler: CommandHandler;
      readonly command: KeybindingCommand;
    }
  | ({ readonly type: "partial" } & PendingKeySequence);

let pendingSequence: {
  readonly events: ShortcutEventLike[];
  readonly state: PendingKeySequence;
  readonly timer: ReturnType<typeof setTimeout>;
} | null = null;
const sequenceListeners = new Set<() => void>();

/** The keys of an unfinished sequence and what may follow, for the hint that lists them. */
export function getPendingKeySequence(): PendingKeySequence | null {
  return pendingSequence?.state ?? null;
}

export function subscribePendingKeySequence(listener: () => void): () => void {
  sequenceListeners.add(listener);
  return () => sequenceListeners.delete(listener);
}

function setPendingSequence(events: ShortcutEventLike[] | null, state?: PendingKeySequence) {
  if (pendingSequence) clearTimeout(pendingSequence.timer);
  pendingSequence =
    events && state
      ? { events, state, timer: setTimeout(() => setPendingSequence(null), SEQUENCE_TIMEOUT_MS) }
      : null;
  for (const listener of sequenceListeners) listener();
}

function keyOf(event: KeyboardEvent): ShortcutEventLike {
  return {
    type: "keydown",
    key: event.key,
    code: event.code,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    target: event.target,
  };
}

/**
 * Runs commands that a component handles with its own key listener rather than a scope, so a
 * sequence can reach them too. `has` says whether it would run the command right now.
 */
export interface CommandRunner {
  readonly has: (command: KeybindingCommand) => boolean;
  readonly run: (command: KeybindingCommand, event: KeyboardEvent) => boolean;
}

const commandRunners: CommandRunner[] = [];

export function registerCommandRunner(runner: CommandRunner): () => void {
  commandRunners.push(runner);
  return () => {
    const index = commandRunners.lastIndexOf(runner);
    if (index !== -1) commandRunners.splice(index, 1);
  };
}

function sequenceHandler(
  scope: CommandScope,
  command: KeybindingCommand,
): CommandHandler | undefined {
  return (
    scope.commands[command] ??
    (commandRunners.some((runner) => runner.has(command))
      ? (event) => commandRunners.findLast((runner) => runner.has(command))?.run(command, event)
      : undefined)
  );
}

/** Sequences over every scope; a command counts only where something would run it. */
function matchSequence(
  keys: ReadonlyArray<ShortcutEventLike>,
  event: KeyboardEvent,
): SequenceMatch | null {
  let typed: ReadonlyArray<KeybindingShortcut> | null = null;
  const next: Array<PendingKeySequence["next"][number]> = [];
  for (const scopes of [captureScopes, globalScopes]) {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const scope = scopes[index]!;
      if (scope.options.when && !scope.options.when(event)) continue;
      const keybindings = scopeKeybindings(scope);
      const match = resolveShortcutSequence(keys, keybindings, {
        context: { ...readFocusContext(event), ...scope.options.context?.() },
      });
      if (match === null) continue;
      if (match.type === "complete") {
        const handler = sequenceHandler(scope, match.command);
        if (handler) return { type: "complete", handler, command: match.command };
        continue;
      }
      for (const candidate of match.next) {
        if (!sequenceHandler(scope, candidate.command)) continue;
        if (next.some((entry) => entry.command === candidate.command)) continue;
        next.push(candidate);
        typed ??=
          keybindings
            .find((binding) => binding.command === candidate.command && binding.sequence)
            ?.sequence?.slice(0, keys.length) ?? null;
      }
    }
  }
  return next.length > 0 && typed ? { type: "partial", typed, next } : null;
}

function consume(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

/**
 * The next key of a started sequence, in the capture phase so a focused editor never takes it.
 * A key that continues no sequence drops the ones before it and goes on as usual.
 */
function continueSequence(event: KeyboardEvent): boolean {
  if (!pendingSequence || MODIFIER_KEYS.has(event.key) || event.isComposing) return false;
  if (event.key === "Escape") {
    setPendingSequence(null);
    consume(event);
    return true;
  }
  const keys = [...pendingSequence.events, keyOf(event)];
  const match = matchSequence(keys, event);
  if (match === null) {
    setPendingSequence(null);
    return false;
  }
  consume(event);
  if (match.type === "complete") {
    setPendingSequence(null);
    match.handler(event);
    return true;
  }
  setPendingSequence(keys, match);
  return true;
}

/**
 * The first key of a sequence, in the capture phase, ahead of an editor or the terminal. A key
 * that already runs a command never starts one, so existing shortcuts win, and a plain key
 * never starts one while you type in a text box.
 */
function startSequence(event: KeyboardEvent): boolean {
  if (MODIFIER_KEYS.has(event.key) || event.isComposing || event.repeat) return false;
  const modified = event.ctrlKey || event.metaKey || event.altKey;
  if (!modified && isTypingTarget(event.target)) return false;
  if (
    hasSingleKeyCommand(captureScopes, event) ||
    hasSingleKeyCommand(globalScopes, event) ||
    // Components that handle their own shortcuts count too: off macOS, Ctrl+W closes a panel.
    resolveShortcutCommand(
      event,
      withVimKeybindings(appAtomRegistry.get(primaryServerKeybindingsAtom)),
      { context: readFocusContext(event) },
    ) !== null
  ) {
    return false;
  }
  const keys = [keyOf(event)];
  const match = matchSequence(keys, event);
  if (match?.type !== "partial") return false;
  consume(event);
  setPendingSequence(keys, match);
  return true;
}

function runScopes(scopes: readonly CommandScope[], event: KeyboardEvent): boolean {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    if (event.defaultPrevented) return true;
    const scope = scopes[index];
    if (scope && runScope(scope, event)) return true;
  }
  return false;
}

let keyboardTakeover: ((event: KeyboardEvent) => void) | null = null;

/**
 * Hands every keydown to one handler, ahead of all bindings, until released: for modes that
 * read typed keys themselves, such as vim's hint labels.
 */
export function takeOverKeyboard(handler: (event: KeyboardEvent) => void): () => void {
  setPendingSequence(null);
  keyboardTakeover = handler;
  ensureKeydownListener();
  return () => {
    if (keyboardTakeover === handler) keyboardTakeover = null;
  };
}

function dispatchCaptureKeyDown(event: KeyboardEvent): void {
  if (keyboardTakeover) {
    keyboardTakeover(event);
    return;
  }
  if (continueSequence(event) || startSequence(event)) return;
  runScopes(captureScopes, event);
}

function dispatchKeyDown(event: KeyboardEvent): void {
  const consumed = runScopes(globalScopes, event) || event.defaultPrevented;
  for (const scope of observerScopes.slice()) scope.options.observe?.(event, consumed);
}

let keydownInstalled = false;
function ensureKeydownListener() {
  if (keydownInstalled || typeof window === "undefined") return;
  keydownInstalled = true;
  window.addEventListener("keydown", dispatchCaptureKeyDown, true);
  window.addEventListener("keydown", dispatchKeyDown);
}

function pushScope(list: CommandScope[], scope: CommandScope): () => void {
  ensureKeydownListener();
  list.push(scope);
  return () => {
    const index = list.lastIndexOf(scope);
    if (index !== -1) list.splice(index, 1);
  };
}

/** App-global commands, registered once at module level or bootstrap. */
export function registerCommands(
  commands: CommandHandlers,
  options: CommandScopeOptions = {},
): () => void {
  const scopes = options.observe ? observerScopes : options.capture ? captureScopes : globalScopes;
  return pushScope(scopes, { commands, options });
}

type MenuActionHandler = () => void;
const menuActionHandlers = new Map<string, MenuActionHandler[]>();
let menuActionInstalled = false;

export function dispatchMenuAction(action: string): void {
  const handlers = menuActionHandlers.get(action);
  handlers?.at(-1)?.();
}

function ensureMenuActionListener() {
  if (menuActionInstalled || typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  if (typeof bridge?.onMenuAction !== "function") return;
  menuActionInstalled = true;
  bridge.onMenuAction(dispatchMenuAction);
}

/** Desktop menu actions; the newest handler for an action wins. */
export function registerMenuAction(action: string, handler: MenuActionHandler): () => void {
  ensureMenuActionListener();
  const handlers = menuActionHandlers.get(action) ?? [];
  handlers.push(handler);
  menuActionHandlers.set(action, handlers);
  return () => {
    const index = handlers.lastIndexOf(handler);
    if (index !== -1) handlers.splice(index, 1);
  };
}
