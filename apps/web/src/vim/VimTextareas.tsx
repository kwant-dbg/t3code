import { useEffect } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useClientSettings } from "~/hooks/useSettings";

const selectVimMode = (settings: { vimMode: boolean }) => settings.vimMode;
const loadTextareaVim = () => import("./textareaVim");

/** Turns on vim in multi-line text boxes while the setting is on, loading it only then. */
export function VimTextareas() {
  const enabled = useClientSettings(selectVimMode);
  const isMobileViewport = useMediaQuery("max-sm");
  const active = enabled && !isMobileViewport;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- installs document key listeners for the lifetime of the setting
  useEffect(() => {
    if (!active) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void loadTextareaVim().then(({ startTextareaVim }) => {
      if (!cancelled) stop = startTextareaVim();
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [active]);
  return null;
}
