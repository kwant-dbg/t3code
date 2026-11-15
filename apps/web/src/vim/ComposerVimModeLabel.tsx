import type { VimMode } from "./engine";

const LABELS: Record<VimMode, string | null> = {
  insert: null,
  normal: "NORMAL",
  visual: "VISUAL",
  "visual-line": "VISUAL LINE",
};

/** Insert is the composer's usual state, so only the other modes show a label. */
export function ComposerVimModeLabel({ mode }: { mode: VimMode | null }) {
  const label = mode ? LABELS[mode] : null;
  if (!label) return null;
  return (
    <span
      data-testid="composer-vim-mode"
      className="me-2 shrink-0 font-mono text-3xs font-medium tracking-wide text-muted-foreground"
    >
      {label}
    </span>
  );
}
