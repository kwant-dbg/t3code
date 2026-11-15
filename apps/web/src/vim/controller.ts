import type { Slice } from "@tiptap/pm/model";

import { VimEngine, type VimMode } from "./engine";
import { ProseMirrorVimBuffer, type ProseMirrorVimHost } from "./proseMirrorBuffer";

export type VimControllerHost = Omit<ProseMirrorVimHost, "holdKeys">;

/**
 * Runs the engine against the editor: one transaction per command, the mode recorded for
 * the cursor decoration, and keys held while a paste waits for the clipboard.
 */
export class VimController {
  readonly #engine: VimEngine<Slice>;
  readonly #buffer: ProseMirrorVimBuffer;
  #held: string[] | null = null;
  #lastMode: VimMode = "insert";
  #lastPending = "";
  readonly #listeners = new Set<() => void>();

  constructor(host: VimControllerHost) {
    this.#buffer = new ProseMirrorVimBuffer({ ...host, holdKeys: (work) => this.#hold(work) });
    this.#engine = new VimEngine(this.#buffer);
  }

  get mode(): VimMode {
    return this.#engine.mode;
  }

  get pendingKeys(): string {
    return this.#engine.pendingKeys;
  }

  /** True while a paste is reading the clipboard; keys wait for it. */
  get holding(): boolean {
    return this.#held !== null;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  feed(key: string): void {
    if (this.#held) {
      this.#held.push(key);
      return;
    }
    this.#adoptSelection();
    this.#engine.feed(key);
    this.#sync();
  }

  escape(): void {
    this.#engine.escape();
    this.#sync();
  }

  enterInsert(): void {
    this.#engine.enterInsert();
    this.#sync();
  }

  /** A selection made with the pointer, or select all, becomes a visual selection. */
  #adoptSelection(): void {
    if (this.#engine.mode !== "normal") return;
    const range = this.#buffer.selectionRange();
    if (!range) return;
    this.#engine.selectVisual(range.anchor, range.head);
    this.#sync();
  }

  #sync(): void {
    const mode = this.#engine.mode;
    const pending = this.#engine.pendingKeys;
    const changed = mode !== this.#lastMode || pending !== this.#lastPending;
    if (changed) this.#buffer.setMode(mode, pending);
    this.#buffer.flush({ closeHistory: true });
    this.#lastMode = mode;
    this.#lastPending = pending;
    if (changed) for (const listener of this.#listeners) listener();
  }

  #hold(work: Promise<void>): void {
    this.#held = [];
    const release = () => {
      const keys = this.#held ?? [];
      this.#held = null;
      for (const key of keys) {
        if (this.#engine.mode !== "insert") this.feed(key);
        else if (key === "<Esc>") this.escape();
        else if (key.length === 1) this.#buffer.typeText(key);
      }
    };
    void work.then(release, release);
  }
}
