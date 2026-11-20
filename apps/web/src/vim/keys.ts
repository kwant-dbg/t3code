import { isMacPlatform } from "~/lib/utils";
import { hasCommandForKeyDown } from "~/shortcuts/dispatcher";
import type { VimMode } from "./engine";

const NAMED_KEYS: Record<string, string> = {
  Escape: "<Esc>",
  Backspace: "<BS>",
  Delete: "<Del>",
  ArrowLeft: "<Left>",
  ArrowRight: "<Right>",
  ArrowUp: "<Up>",
  ArrowDown: "<Down>",
  Home: "<Home>",
  End: "<End>",
};

/** A keydown in vim notation: `x`, `<Esc>`, `<Left>`; null for keys vim does not use. */
export function vimKey(event: KeyboardEvent): string | null {
  const named = NAMED_KEYS[event.key];
  if (named) return named;
  return [...event.key].length === 1 ? event.key : null;
}

/** Ctrl keys vim uses in Normal mode, on every platform, unless an app shortcut claims them. */
const CTRL_KEYS: Record<string, string> = { r: "<C-r>", a: "<C-a>", x: "<C-x>" };

/** Esc, or ctrl+[ which terminals send as Esc. */
export function isEscapeKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.altKey || event.shiftKey) return false;
  return event.ctrlKey ? event.key === "[" || event.code === "BracketLeft" : event.key === "Escape";
}

/** Not mid-composition, so IME input is never interrupted. */
export const isComposing = (event: KeyboardEvent) => event.isComposing || event.keyCode === 229;

export type VimKeyRoute =
  | { readonly type: "feed"; readonly key: string }
  /** Enter outside a search, which the editor decides: send, save, or move down. */
  | { readonly type: "enter" }
  /** Left unprevented and out of the editor's keymaps, so an app shortcut or focus move runs. */
  | { readonly type: "app" }
  /** The editor's own meaning applies, such as copy, paste, or an arrow in Replace. */
  | { readonly type: "editor" }
  /** A modified key with no meaning here, kept from typing. */
  | { readonly type: "swallow" };

/** Where a keydown goes in Normal, Visual and Replace. App shortcuts keep working in all of them. */
export function routeVimKey(
  event: KeyboardEvent,
  mode: VimMode,
  commandLineOpen: boolean,
): VimKeyRoute {
  if (isEscapeKey(event)) {
    // Off macOS, ctrl+[ is the app's back shortcut by default.
    if (event.ctrlKey && hasCommandForKeyDown(event)) return { type: "app" };
    return { type: "feed", key: "<Esc>" };
  }
  if (event.key === "Enter") {
    return commandLineOpen ? { type: "feed", key: "<CR>" } : { type: "enter" };
  }
  const ctrlOnly = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  const ctrlKey = ctrlOnly ? CTRL_KEYS[event.key.toLowerCase()] : undefined;
  // Off macOS, an unclaimed ctrl+r would reload the page, so it is vim's in Visual too.
  if (ctrlKey && (mode === "normal" || ctrlKey === "<C-r>")) {
    return hasCommandForKeyDown(event) ? { type: "app" } : { type: "feed", key: ctrlKey };
  }
  // Cmd shortcuts (Ctrl off macOS) keep their editor and app meaning: copy, paste, undo.
  if (isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey) return { type: "editor" };
  if (event.ctrlKey || event.altKey || event.metaKey) {
    return hasCommandForKeyDown(event) ? { type: "app" } : { type: "swallow" };
  }
  // Tab leaves the editor, as it would from any control that is not typing.
  if (event.key === "Tab") return { type: "app" };
  const key = vimKey(event);
  if (key === null) return { type: "editor" };
  // Replace types over text; other keys, such as arrows, move the caret as in Insert.
  if (mode === "replace" && key !== "<BS>" && key !== "<Esc>" && [...key].length !== 1) {
    return { type: "editor" };
  }
  return { type: "feed", key };
}
