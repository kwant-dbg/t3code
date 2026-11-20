import { lazy, Suspense, useEffect, useSyncExternalStore } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useClientSettings } from "~/hooks/useSettings";
import { closeVimCheatSheet, isVimCheatSheetOpen, subscribeVimCheatSheet } from "./cheatSheetStore";
import { setVimModeOn } from "./vimKeybindings";

const selectVimMode = (settings: { vimMode: boolean }) => settings.vimMode;
const loadVimRuntime = () => import("./vimRuntime");
const VimCheatSheet = lazy(() => import("./VimCheatSheet"));

/**
 * Vim mode for the app: text boxes and app Normal mode. It loads only while the setting is on,
 * so the off state adds no listeners.
 */
export function VimMode() {
  const enabled = useClientSettings(selectVimMode);
  const isMobileViewport = useMediaQuery("max-sm");
  const active = enabled && !isMobileViewport;
  const cheatSheetOpen = useSyncExternalStore(
    subscribeVimCheatSheet,
    isVimCheatSheetOpen,
    isVimCheatSheetOpen,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- installs vim's key listeners and bindings for the lifetime of the setting
  useEffect(() => {
    if (!active) return;
    setVimModeOn(true);
    let stop: (() => void) | null = null;
    let cancelled = false;
    void loadVimRuntime().then(({ startVim }) => {
      if (!cancelled) stop = startVim();
    });
    return () => {
      cancelled = true;
      stop?.();
      setVimModeOn(false);
      closeVimCheatSheet();
    };
  }, [active]);
  if (!active || !cheatSheetOpen) return null;
  return (
    <Suspense fallback={null}>
      <VimCheatSheet />
    </Suspense>
  );
}
