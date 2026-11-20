import { vimStatusLabel } from "./status";
import type { VimStatus } from "./vimState";

/** Insert is the composer's usual state, so it shows only typed keys, if any. */
export function ComposerVimModeLabel({ status }: { status: VimStatus | null }) {
  const label = status ? vimStatusLabel(status) : "";
  if (!label) return null;
  return (
    <span
      data-testid="vim-mode"
      className="me-2 min-w-0 shrink truncate font-mono text-3xs font-medium tracking-wide text-muted-foreground"
    >
      {label}
    </span>
  );
}
