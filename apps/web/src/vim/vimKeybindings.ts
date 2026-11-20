import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  compileResolvedKeybindingsConfig,
  mergeVimKeybindings,
  VIM_DEFAULT_KEYBINDINGS,
} from "@t3tools/shared/keybindings";

import { isEditableFocused } from "~/lib/editableFocus";
import { isBrowserSurfaceFocused } from "~/lib/previewFocus";

// Set by `VimMode` from the setting, so key matching never reads settings itself.
let vimModeOn = false;

export function setVimModeOn(on: boolean): void {
  vimModeOn = on;
}

export function isVimModeOn(): boolean {
  return vimModeOn;
}

let vimDefaults: ResolvedKeybindingsConfig | null = null;
const merged = new WeakMap<ResolvedKeybindingsConfig, ResolvedKeybindingsConfig>();

/** The vim layer under the user's rules while vim mode is on; the rules unchanged otherwise. */
export function withVimKeybindings(
  keybindings: ResolvedKeybindingsConfig,
): ResolvedKeybindingsConfig {
  if (!isVimModeOn()) return keybindings;
  vimDefaults ??= compileResolvedKeybindingsConfig(VIM_DEFAULT_KEYBINDINGS);
  let result = merged.get(keybindings);
  if (!result) {
    result = mergeVimKeybindings(vimDefaults, keybindings);
    merged.set(keybindings, result);
  }
  return result;
}

function deepActiveElement(): Element | null {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}

function closestAcrossShadow(element: Element | null, selector: string): HTMLElement | null {
  for (let current = element; current;) {
    const match = current.closest<HTMLElement>(selector);
    if (match) return match;
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

/** A vim text box in Normal or Visual mode takes keys as commands, not as typing. */
function isVimCommandTarget(target: EventTarget | null): boolean {
  const mode =
    target instanceof Element
      ? target.closest<HTMLElement>("[data-vim-mode]")?.dataset.vimMode
      : undefined;
  return mode !== undefined && mode !== "insert" && mode !== "replace";
}

/** Typing in a text box, where a plain key is text and never starts a key sequence. */
export function isTypingTarget(target: EventTarget | null): boolean {
  return isEditableFocused(target) && !isVimCommandTarget(target);
}

const LIST_SELECTOR = [
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="tree"]',
  '[role="grid"]',
  '[role="list"]',
  '[role="tablist"]',
  "[data-sidebar-row]",
  "[data-settings-section]",
].join(",");
const POPUP_SELECTOR =
  '[role="dialog"], [role="menu"], [role="listbox"], [data-slot$="-popup"]:not([data-slot="tooltip-popup"])';

/**
 * When-clause keys set while vim mode is on: `vimMode`, `vimNormal` (not typing: no text box
 * focused, or the focused one is in Normal mode), and where focus is: `sidebarFocus`,
 * `conversationFocus`, `rightPanelFocus`, `listFocus`, `popupOpen`. Empty while it is off.
 */
export function readVimContext(focus: {
  readonly terminalFocus?: boolean | undefined;
}): Record<string, boolean> {
  if (!vimModeOn || typeof document === "undefined") return {};
  const active = deepActiveElement();
  const area = closestAcrossShadow(active, "[data-workspace-area]")?.dataset.workspaceArea;
  const nothingFocused = active === null || active === document.body;
  const popupOpen =
    closestAcrossShadow(active, POPUP_SELECTOR) !== null ||
    (active?.getAttribute("role") === "combobox" &&
      active.getAttribute("aria-expanded") === "true");
  return {
    vimMode: true,
    // The right panel's diff and files take vim keys; only a browser page keeps them all.
    vimNormal: !focus.terminalFocus && !isBrowserSurfaceFocused() && !isTypingTarget(active),
    sidebarFocus: area === "sidebar",
    conversationFocus:
      area === "conversation" ||
      (nothingFocused && document.querySelector('[data-workspace-area="conversation"]') !== null),
    rightPanelFocus: area === "panel" || area === "details",
    listFocus: closestAcrossShadow(active, LIST_SELECTOR) !== null,
    popupOpen,
  };
}
