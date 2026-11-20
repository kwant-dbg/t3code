import { startVimNavigation } from "./navigation";
import { startTextareaVim } from "./textareaVim";

/** Everything vim mode runs outside the composer, which loads its own part with the editor. */
export function startVim(): () => void {
  const stops = [startTextareaVim(), startVimNavigation()];
  return () => {
    for (const stop of stops) stop();
  };
}
