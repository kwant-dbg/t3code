let open = false;
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

export function toggleVimCheatSheet(): void {
  open = !open;
  notify();
}

export function closeVimCheatSheet(): void {
  if (!open) return;
  open = false;
  notify();
}

export const isVimCheatSheetOpen = () => open;

export function subscribeVimCheatSheet(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
