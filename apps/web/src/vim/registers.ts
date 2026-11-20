import type { VimPutSource, VimYank } from "./engine";

const REGISTER_NAME = /^[a-zA-Z0"+*_]$/;

export const isVimRegisterName = (name: string) => REGISTER_NAME.test(name);

const withNewline = (text: string) => (text.endsWith("\n") ? text : `${text}\n`);

function append(previous: VimYank | undefined, next: VimYank): VimYank {
  if (!previous) return next;
  if (!previous.linewise && !next.linewise) {
    return { ...previous, text: previous.text + next.text };
  }
  return { ...previous, text: withNewline(previous.text) + withNewline(next.text), linewise: true };
}

/**
 * Registers shared by every vim editor, as vim shares them across buffers. The unnamed
 * register is the system clipboard (`clipboard=unnamedplus`), so a plain yank reaches other apps.
 */
export class VimRegisters {
  readonly #named = new Map<string, VimYank>();
  #lastYank: VimYank | null = null;
  /** The last clipboard write, which knows its linewise flag and flavors. */
  #clipboard: VimYank | null = null;
  lastSearch: { readonly pattern: string; readonly backward: boolean } | null = null;

  /** Stores a yank or delete; true when it must also reach the system clipboard. */
  write(name: string | undefined, yank: VimYank, kind: "yank" | "delete"): boolean {
    if (name === "_") return false;
    if (name === undefined || name === '"' || name === "+" || name === "*") {
      if (kind === "yank") this.#lastYank = yank;
      this.#clipboard = yank;
      return true;
    }
    if (name === "0") this.#lastYank = yank;
    else if (/^[A-Z]$/.test(name)) {
      const lower = name.toLowerCase();
      this.#named.set(lower, append(this.#named.get(lower), yank));
    } else this.#named.set(name, yank);
    return false;
  }

  /** What `p` puts from a register, or null when the register is empty. */
  read(name: string | undefined): VimPutSource | null {
    if (name === undefined || name === '"' || name === "+" || name === "*") {
      return { type: "clipboard", resolve: (text) => this.#resolveClipboard(text) };
    }
    if (name === "_") return null;
    const yank = name === "0" ? this.#lastYank : this.#named.get(name.toLowerCase());
    return yank ? { type: "register", yank } : null;
  }

  #resolveClipboard(text: string | null): VimYank | null {
    const last = this.#clipboard;
    // A failed read falls back to the last yank; text it wrote keeps its flag and flavors.
    if (text === null) return last;
    const normalized = text.replace(/\r\n?/g, "\n");
    if (normalized.length === 0) return null;
    if (last && normalized === last.text) return last;
    return { text: normalized, linewise: normalized.endsWith("\n") };
  }
}

/** One set for the whole app, so `"ayy` in one text box puts with `"ap` in another. */
export const sharedVimRegisters = new VimRegisters();
