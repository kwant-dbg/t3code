import type { VimMode } from "./engine";
import type { VimStatus } from "./vimState";

// Vim's own mode names, which stay English like key names.
const LABELS: Record<VimMode, string | null> = {
  insert: null,
  replace: "REPLACE",
  normal: "NORMAL",
  visual: "VISUAL",
  "visual-line": "VISUAL LINE",
};

/** The mode and any keys typed toward a command, such as `NORMAL d2` or `NORMAL /foo`. */
export function vimStatusLabel(status: VimStatus): string {
  return [LABELS[status.mode], status.pending].filter(Boolean).join(" ");
}
