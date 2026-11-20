import { type VimBuffer, VimEngine, type VimMode } from "./engine";
import { sharedVimRegisters, type VimRegisters } from "./registers";
import type { VimPos } from "./text";

/** What the controller needs from an editor adapter beyond the engine's buffer. */
export interface ControlledVimBuffer<Insertion> extends VimBuffer<Insertion> {
  /** Records the mode for the editor's cursor and label. */
  setMode(mode: VimMode, pending: string): void;
  /** Applies the command's edits as one update and one undo step. */
  flush(options?: { closeHistory?: boolean }): void;
  /** Keys typed in Insert while a paste was still reading the clipboard. */
  typeText(text: string): void;
  /** A non-empty selection as vim's inclusive anchor and head characters. */
  selectionRange(): { anchor: VimPos; head: VimPos } | null;
}

/**
 * Runs the engine against an editor: one update per command, the mode recorded for the
 * cursor and label, and keys held while a paste waits for the clipboard.
 */
export class VimController<Insertion> {
  readonly #engine: VimEngine<Insertion>;
  readonly #buffer: ControlledVimBuffer<Insertion>;
  #held: string[] | null = null;
  #lastMode: VimMode = "insert";
  #lastPending = "";
  readonly #listeners = new Set<() => void>();

  /** `createBuffer` gets the hook a buffer calls when a paste must wait for the clipboard. */
  constructor(
    createBuffer: (holdKeys: (work: Promise<void>) => void) => ControlledVimBuffer<Insertion>,
    registers: VimRegisters = sharedVimRegisters,
  ) {
    this.#buffer = createBuffer((work) => this.#hold(work));
    this.#engine = new VimEngine(this.#buffer, registers);
  }

  get mode(): VimMode {
    return this.#engine.mode;
  }

  get pendingKeys(): string {
    return this.#engine.pendingKeys;
  }

  get commandLineOpen(): boolean {
    return this.#engine.commandLineOpen;
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
