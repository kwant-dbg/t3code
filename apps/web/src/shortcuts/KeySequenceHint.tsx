import { lazy, Suspense, useSyncExternalStore } from "react";

import { getPendingKeySequence, subscribePendingKeySequence } from "./dispatcher";

const KeySequenceHintPanel = lazy(() => import("./KeySequenceHintPanel"));

/** Lists what can follow the keys of an unfinished sequence, such as `space` or `g`. */
export function KeySequenceHint() {
  const pending = useSyncExternalStore(
    subscribePendingKeySequence,
    getPendingKeySequence,
    getPendingKeySequence,
  );
  if (!pending) return null;
  return (
    <Suspense fallback={null}>
      <KeySequenceHintPanel pending={pending} />
    </Suspense>
  );
}
