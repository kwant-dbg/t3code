import { closeHistory, isHistoryTransaction } from "@tiptap/pm/history";
import type { Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";

// Whole-draft rewrites make all edits adjacent; explicit boundaries keep change kinds separate.
export const COMPOSER_UNDO_GROUP_DELAY = 1000;

export type ComposerChangeKind = "insert" | "delete" | "other";

const CLIPBOARD_EDIT_META = "composerClipboardEdit";
const UNDO_SESSION_META = "composerUndoSession";

/**
 * Tag custom paste/cut dispatches; ProseMirror only tags its built-in paths.
 * Not `uiEvent`: Tiptap's paste rules would style the already parsed paste a second time.
 */
export function markAsClipboardEdit(tr: Transaction, event: "paste" | "cut"): Transaction {
  return tr.setMeta(CLIPBOARD_EDIT_META, event);
}

/** Edits made between `begin` and `end` undo as one step, like vim's Insert session. */
export interface ComposerUndoSession {
  readonly startedAt: number;
  /** The session's first edit starts its step, so it never joins the edit before. */
  opened: boolean;
}

export interface ComposerUndoGroupingStorage {
  previous: ComposerChangeKind | null;
  session: ComposerUndoSession | null;
}

declare module "@tiptap/core" {
  interface Storage {
    "composer-undo-grouping": ComposerUndoGroupingStorage;
  }
}

/** Stamps an edit made during a session with the session's start time. */
export function markUndoSession(tr: Transaction, session: ComposerUndoSession): Transaction {
  if (!tr.docChanged) return tr;
  if (!session.opened) closeHistory(tr);
  session.opened = true;
  return tr.setMeta(UNDO_SESSION_META, true).setTime(session.startedAt);
}

function changeKindOf(tr: Transaction): ComposerChangeKind | null {
  if (!tr.docChanged) return null;
  const uiEvent = tr.getMeta("uiEvent");
  if (uiEvent === "paste" || uiEvent === "drop" || uiEvent === "cut") return "other";
  if (tr.getMeta(CLIPBOARD_EDIT_META) != null) return "other";
  // IME input replaces its own range on each keystroke; it is still typing.
  if (tr.getMeta("composition") != null) return "insert";
  let kind: ComposerChangeKind | null = null;
  for (const step of tr.steps) {
    if (!(step instanceof ReplaceStep)) return "other";
    const inserts = step.slice.size > 0;
    const deletes = step.to > step.from;
    const stepKind = inserts && !deletes ? "insert" : deletes && !inserts ? "delete" : "other";
    if (kind !== null && kind !== stepKind) return "other";
    kind = stepKind;
  }
  return kind;
}

/** Must run before the transaction is applied. */
export function groupUndoByChangeKind(
  tr: Transaction,
  previous: ComposerChangeKind | null,
): ComposerChangeKind | null {
  if (isHistoryTransaction(tr)) return "other";
  const kind = changeKindOf(tr);
  if (kind === null) return previous;
  if (tr.getMeta(UNDO_SESSION_META)) return "other";
  if (previous !== null && (kind !== previous || kind === "other")) closeHistory(tr);
  return kind;
}
