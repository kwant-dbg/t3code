import { type EditorState, PluginKey } from "@tiptap/pm/state";

import type { VimMode } from "./engine";

export interface VimVisual {
  readonly anchor: number;
  readonly head: number;
  readonly linewise: boolean;
}

/** What the mode label shows: the mode, and keys typed toward a command, such as `d2` or `/foo`. */
export interface VimStatus {
  readonly mode: VimMode;
  readonly pending: string;
}

export interface VimPluginState {
  readonly mode: VimMode;
  readonly visual: VimVisual | null;
  readonly pending: string;
}

/** The composer's vim plugin, registered only while vim mode is on; the rest loads lazily. */
export const vimPluginKey = new PluginKey<VimPluginState>("composer-vim");

/** Normal, Visual and Replace edit rendered text, so the composer shows no Markdown source there. */
export function isVimCommandMode(state: EditorState): boolean {
  const mode = vimPluginKey.getState(state)?.mode;
  return mode !== undefined && mode !== "insert";
}
