import { readTextFromClipboard, writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { hasCommandForKeyDown } from "~/shortcuts/dispatcher";
import { VimController } from "./controller";
import { isComposing, isEscapeKey, routeVimKey, vimKey } from "./keys";
import { vimStatusLabel } from "./status";
import { TextareaVimBuffer } from "./textareaBuffer";

/**
 * Text boxes that are not for writing opt out with `data-vim="off"`; the terminal's input
 * is a hidden textarea and keeps every key.
 */
function isVimTextarea(target: EventTarget | null): target is HTMLTextAreaElement {
  return (
    target instanceof HTMLTextAreaElement &&
    !target.readOnly &&
    !target.disabled &&
    target.closest('.xterm, [data-vim="off"]') === null
  );
}

const isPlainKey = (event: KeyboardEvent) =>
  !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;

/** One line of status at the text box's corner: the mode and any keys typed toward a command. */
class StatusBadge {
  #element: HTMLElement | null = null;
  #target: HTMLTextAreaElement | null = null;
  readonly #place = () => {
    const element = this.#element;
    const target = this.#target;
    if (!element || !target) return;
    const rect = target.getBoundingClientRect();
    element.style.left = `${rect.right - 6}px`;
    element.style.top = `${rect.bottom - 4}px`;
  };

  show(target: HTMLTextAreaElement, text: string): void {
    if (!this.#element) {
      this.#element = document.createElement("div");
      this.#element.className = "vim-textarea-status";
      this.#element.setAttribute("aria-hidden", "true");
      document.body.append(this.#element);
      window.addEventListener("scroll", this.#place, { capture: true, passive: true });
      window.addEventListener("resize", this.#place, { passive: true });
    }
    this.#target = target;
    this.#element.textContent = text;
    this.#place();
  }

  hide(): void {
    this.#element?.remove();
    this.#element = null;
    this.#target = null;
    window.removeEventListener("scroll", this.#place, { capture: true });
    window.removeEventListener("resize", this.#place);
  }
}

function createSession(textarea: HTMLTextAreaElement, badge: StatusBadge) {
  const controller = new VimController(
    (holdKeys) =>
      new TextareaVimBuffer(textarea, {
        holdKeys,
        writeClipboard: (yank) => {
          void writeTextToClipboard(yank.text).catch(() => false);
        },
        readClipboardText: () => readTextFromClipboard().catch(() => null),
      }),
  );
  controller.subscribe(() => {
    if (document.activeElement !== textarea) return;
    const text = vimStatusLabel({ mode: controller.mode, pending: controller.pendingKeys });
    if (text) badge.show(textarea, text);
    else badge.hide();
  });
  return controller;
}

/**
 * Vim in every multi-line text box outside the composer. Listens on the document only while
 * the setting is on; each textarea gets its own modes and undo history, and shares registers.
 */
export function startTextareaVim(): () => void {
  const badge = new StatusBadge();
  const sessions = new WeakMap<HTMLTextAreaElement, ReturnType<typeof createSession>>();
  const sessionFor = (textarea: HTMLTextAreaElement) => {
    let session = sessions.get(textarea);
    if (!session) {
      session = createSession(textarea, badge);
      sessions.set(textarea, session);
      session.enterInsert();
    }
    return session;
  };
  /** Enter in Normal that the text box itself did not use. */
  const unclaimedEnter = new WeakSet<KeyboardEvent>();

  const onKeyDown = (event: KeyboardEvent) => {
    const textarea = event.target;
    if (!isVimTextarea(textarea) || isComposing(event)) return;
    const vim = sessionFor(textarea);
    const consume = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (vim.mode === "insert") {
      if (!isEscapeKey(event) || (event.ctrlKey && hasCommandForKeyDown(event))) return;
      // An open completion list closes first.
      if (textarea.getAttribute("aria-expanded") === "true") return;
      vim.escape();
      consume();
      return;
    }
    if (vim.holding) {
      const key = vimKey(event);
      if (key) vim.feed(key);
      consume();
      return;
    }
    const route = routeVimKey(event, vim.mode, vim.commandLineOpen);
    switch (route.type) {
      case "feed":
        // Includes a second Esc in Normal, which does nothing, so a habitual Esc never
        // closes the dialog around a draft. Tab leaves the text box.
        vim.feed(route.key);
        consume();
        return;
      case "enter":
        // The text box's own Enter (save, send) runs; unclaimed, it moves down a line.
        if (vim.mode !== "normal") vim.feed("<Esc>");
        unclaimedEnter.add(event);
        return;
      case "swallow":
        consume();
        return;
      case "app":
      case "editor":
        return;
    }
  };

  const onEnterAfterHandlers = (event: KeyboardEvent) => {
    if (!unclaimedEnter.has(event) || event.defaultPrevented) return;
    const textarea = event.target;
    if (!isVimTextarea(textarea)) return;
    event.preventDefault();
    if (isPlainKey(event)) sessionFor(textarea).feed("<CR>");
  };

  // Writing starts in Insert, as in the composer.
  const onFocusIn = (event: FocusEvent) => {
    if (isVimTextarea(event.target)) sessionFor(event.target).enterInsert();
  };
  const onFocusOut = () => badge.hide();

  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("keydown", onEnterAfterHandlers);
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  return () => {
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("keydown", onEnterAfterHandlers);
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
    badge.hide();
    for (const textarea of document.querySelectorAll<HTMLTextAreaElement>(
      "textarea[data-vim-mode]",
    )) {
      delete textarea.dataset.vimMode;
      delete textarea.dataset.vimPending;
    }
  };
}
