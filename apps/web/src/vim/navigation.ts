import { type CommandHandler, registerCommands, takeOverKeyboard } from "~/shortcuts/dispatcher";
import { moveWorkspaceFocus, requestWorkspaceFocus } from "~/lib/workspaceFocus";
import { toggleVimCheatSheet } from "./cheatSheetStore";

function activeElement(): HTMLElement | null {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element instanceof HTMLElement ? element : null;
}

/** Sends a key to the focused widget the way the user would press it; true if it was used. */
function press(target: Element, key: string): boolean {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function isShown(element: Element): boolean {
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  return Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
}

type Direction = "left" | "right" | "up" | "down";

/**
 * The layout as vim windows: the sidebar, the conversation over the composer, the details card
 * and right panel beside them, the terminal below. The first visible neighbour wins.
 */
const NEIGHBOURS: Record<string, Partial<Record<Direction, ReadonlyArray<string>>>> = {
  sidebar: { right: ["conversation", "composer", "home", "pull-requests", "panel"] },
  "settings-nav": { right: ["settings"] },
  settings: { left: ["settings-nav", "sidebar"] },
  conversation: {
    left: ["sidebar"],
    right: ["details", "panel"],
    down: ["composer", "terminal"],
  },
  composer: {
    left: ["sidebar"],
    right: ["panel", "details"],
    up: ["conversation"],
    down: ["terminal"],
  },
  details: { left: ["conversation", "composer"], down: ["panel", "composer"] },
  panel: { left: ["conversation", "composer"], up: ["details"], down: ["terminal"] },
  terminal: { left: ["sidebar"], up: ["composer", "conversation"], right: ["panel"] },
  home: { left: ["sidebar"], right: ["panel"] },
  "pull-requests": { left: ["sidebar"], right: ["panel"] },
};

/** The nearest visible area that way, as vim picks the next window. */
function areaToward(direction: Direction): HTMLElement | null {
  const areas = Array.from(document.querySelectorAll<HTMLElement>("[data-workspace-area]")).filter(
    isShown,
  );
  const from =
    activeElement()?.closest<HTMLElement>("[data-workspace-area]") ??
    areas.find((area) => area.dataset.workspaceArea === "conversation");
  if (!from) return null;
  const neighbours = NEIGHBOURS[from.dataset.workspaceArea ?? ""];
  if (neighbours) {
    for (const name of neighbours[direction] ?? []) {
      const area = areas.find((candidate) => candidate.dataset.workspaceArea === name);
      if (area) return area;
    }
    return null;
  }
  // An area the table does not know: the closest one that way on screen.
  const origin = from.getBoundingClientRect();
  let best: { area: HTMLElement; gap: number } | null = null;
  for (const area of areas) {
    if (area === from || area.contains(from) || from.contains(area)) continue;
    const rect = area.getBoundingClientRect();
    const gap = {
      left: origin.left - rect.right,
      right: rect.left - origin.right,
      up: origin.top - rect.bottom,
      down: rect.top - origin.bottom,
    }[direction];
    if (gap >= -8 && (!best || gap < best.gap)) best = { area, gap };
  }
  return best?.area ?? null;
}

function focusToward(direction: Direction): boolean {
  const area = areaToward(direction)?.dataset.workspaceArea;
  if (!area) return false;
  requestWorkspaceFocus({ area });
  return true;
}

const LIST_ROOT =
  '[role="listbox"], [role="menu"], [role="menubar"], [role="tree"], [role="grid"], [role="list"], [role="tablist"], [data-workspace-area]';
const LIST_ITEM =
  '[role="option"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="treeitem"], [role="row"], [role="listitem"], [role="tab"], [data-sidebar-row], [data-settings-section]';

/** Lists move with their own arrow keys; a list without them moves focus between its items. */
function moveInList(key: "ArrowDown" | "ArrowUp" | "Home" | "End", times = 1): boolean {
  const target = activeElement();
  if (!target) return false;
  for (let step = 0; step < times; step += 1) {
    if (press(target === document.activeElement ? target : activeElement()!, key)) continue;
    const root = target.closest(LIST_ROOT);
    const items = Array.from(root?.querySelectorAll<HTMLElement>(LIST_ITEM) ?? []).filter(isShown);
    const current = items.findIndex((item) => item.contains(activeElement()));
    const next =
      key === "Home"
        ? 0
        : key === "End"
          ? items.length - 1
          : current + (key === "ArrowDown" ? 1 : -1);
    const item = items[Math.max(0, Math.min(items.length - 1, next))];
    if (!item || item.contains(activeElement())) return true;
    if (item.tabIndex < 0 && !item.hasAttribute("tabindex")) item.tabIndex = -1;
    item.focus();
  }
  return true;
}

function halfPageOfItems(): number {
  const target = activeElement();
  const root = target?.closest<HTMLElement>(LIST_ROOT);
  const itemHeight = target?.getBoundingClientRect().height ?? 0;
  if (!root || itemHeight <= 0) return 5;
  return Math.max(1, Math.floor(root.clientHeight / itemHeight / 2));
}

function isScrollable(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement) || element.scrollHeight <= element.clientHeight + 1) {
    return false;
  }
  const { overflowY } = getComputedStyle(element);
  return overflowY === "auto" || overflowY === "scroll";
}

/** The scrolling view around focus, or the tallest one in its area. */
function scrollerForFocus(): HTMLElement | null {
  const target = activeElement();
  for (let element = target; element; element = element.parentElement) {
    if (isScrollable(element) && element.clientHeight > 80) return element;
    if (element.hasAttribute("data-workspace-area")) break;
  }
  const area =
    target?.closest("[data-workspace-area]") ??
    document.querySelector('[data-workspace-area="conversation"]');
  const candidates = Array.from(
    area?.querySelectorAll('[class*="overflow-"], [data-workspace-focus-default]') ?? [],
  ).filter(isScrollable);
  return candidates.toSorted((left, right) => right.clientHeight - left.clientHeight)[0] ?? null;
}

const SCROLL_KEYS = {
  lineDown: "ArrowDown",
  lineUp: "ArrowUp",
  halfPageDown: "PageDown",
  halfPageUp: "PageUp",
  top: "Home",
  bottom: "End",
} as const;

/**
 * Scrolls like the matching key. The key is sent first, so views that follow new output, such
 * as a running turn's timeline, treat it as the reader moving and stop following.
 */
function scroll(kind: keyof typeof SCROLL_KEYS, scroller = scrollerForFocus()): boolean {
  if (!scroller) return false;
  press(scroller, SCROLL_KEYS[kind]);
  const half = scroller.clientHeight / 2;
  const top = {
    lineDown: scroller.scrollTop + 40,
    lineUp: scroller.scrollTop - 40,
    halfPageDown: scroller.scrollTop + half,
    halfPageUp: scroller.scrollTop - half,
    top: 0,
    bottom: scroller.scrollHeight,
  }[kind];
  scroller.scrollTo({ top, behavior: "instant" });
  return true;
}

const ROW = "[data-timeline-row-id]";

function timeline(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-workspace-area="conversation"] .messages-timeline-scroll',
  );
}

function renderedRows(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(ROW)).filter(isShown);
}

function currentRow(root: HTMLElement): HTMLElement | null {
  const focused = activeElement()?.closest<HTMLElement>(ROW);
  if (focused && root.contains(focused)) return focused;
  // Without a cursor yet, start from the first message in view.
  const box = root.getBoundingClientRect();
  return renderedRows(root).find((row) => row.getBoundingClientRect().bottom > box.top + 8) ?? null;
}

/** The message cursor is focus on a row, so it shows with the focus ring and survives scrolling. */
function putCursor(row: HTMLElement, root: HTMLElement): void {
  press(root, "ArrowDown");
  if (!row.hasAttribute("tabindex")) row.tabIndex = -1;
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: "nearest" });
}

function moveCursor(step: 1 | -1, matches: (row: HTMLElement) => boolean = () => true): boolean {
  const root = timeline();
  if (!root) return false;
  const rows = renderedRows(root);
  const current = currentRow(root);
  const start = current ? rows.indexOf(current) : -1;
  if (!activeElement()?.closest(ROW) && current && matches(current)) {
    putCursor(current, root);
    return true;
  }
  for (let index = start + step; index >= 0 && index < rows.length; index += step) {
    if (matches(rows[index]!)) {
      putCursor(rows[index]!, root);
      return true;
    }
  }
  // Rows past the rendered ones load as the list scrolls; try once more after a page.
  scroll(step === 1 ? "halfPageDown" : "halfPageUp", root);
  requestAnimationFrame(() => {
    const later = renderedRows(root);
    const from = current ? later.indexOf(current) : -1;
    for (let index = from + step; index >= 0 && index < later.length; index += step) {
      if (matches(later[index]!)) return putCursor(later[index]!, root);
    }
  });
  return true;
}

function cursorToEnd(end: "top" | "bottom"): boolean {
  const root = timeline();
  if (!root) return false;
  scroll(end, root);
  requestAnimationFrame(() => {
    const rows = renderedRows(root);
    const row = end === "top" ? rows[0] : rows.at(-1);
    if (row) putCursor(row, root);
  });
  return true;
}

function cursorRow(): HTMLElement | null {
  const root = timeline();
  return root ? currentRow(root) : null;
}

const isUserPrompt = (row: HTMLElement) =>
  row.querySelector('[data-message-role="user"]') !== null ||
  row.getAttribute("data-message-role") === "user";

/**
 * Scrolls the next hunk below the top of the view up to it. The diff renders only the files in
 * view, so this moves within them; `]f` (in the diff panel) moves between files.
 */
function jumpToHunk(step: 1 | -1): boolean {
  const scroller = scrollerForFocus();
  const panel = activeElement()?.closest("[data-workspace-area]");
  if (!scroller || !panel) return false;
  const top = scroller.getBoundingClientRect().top;
  const offsets = Array.from(panel.querySelectorAll("diffs-container"))
    .flatMap((host) =>
      Array.from(host.shadowRoot?.querySelectorAll("[data-separator], [data-diffs-header]") ?? []),
    )
    .map((anchor) => anchor.getBoundingClientRect().top - top)
    .toSorted((left, right) => left - right);
  const target =
    step === 1 ? offsets.find((offset) => offset > 40) : offsets.findLast((offset) => offset < -4);
  if (target === undefined) return true;
  press(scroller, step === 1 ? "PageDown" : "PageUp");
  scroller.scrollTo({ top: scroller.scrollTop + target, behavior: "instant" });
  return true;
}

const CLICKABLE = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "textarea:not(:disabled)",
  "select:not(:disabled)",
  "summary",
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="treeitem"]',
].join(",");
// Home row first; letters that start other vim keys come last.
const HINT_ALPHABET = "asdfjklhqweruiopvbnmtxc";

function hintLabels(count: number): string[] {
  const letters = [...HINT_ALPHABET];
  if (count <= letters.length) return letters.slice(0, count);
  return letters.flatMap((first) => letters.map((second) => first + second)).slice(0, count);
}

/** Visible controls a click would reach, not ones under a dialog or off screen. */
function hintTargets(): HTMLElement[] {
  const width = window.innerWidth;
  const height = window.innerHeight;
  return Array.from(document.querySelectorAll<HTMLElement>(CLICKABLE)).filter((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > height || rect.left > width) return false;
    const x = Math.min(width - 1, Math.max(0, rect.left + rect.width / 2));
    const y = Math.min(height - 1, Math.max(0, rect.top + rect.height / 2));
    const hit = document.elementFromPoint(x, y);
    return hit !== null && (element.contains(hit) || hit.contains(element));
  });
}

let stopHints: (() => void) | null = null;

/** Labels every visible control; typing a label clicks it, or focuses it with `F`. */
function showHints(action: "click" | "focus"): boolean {
  stopHints?.();
  const targets = hintTargets();
  if (targets.length === 0) return false;
  const labels = hintLabels(targets.length);
  const layer = document.createElement("div");
  layer.className = "vim-hints";
  layer.setAttribute("aria-hidden", "true");
  const marks = targets.map((target, index) => {
    const rect = target.getBoundingClientRect();
    const mark = document.createElement("span");
    mark.className = "vim-hint";
    mark.textContent = labels[index]!;
    mark.style.left = `${Math.max(0, rect.left)}px`;
    mark.style.top = `${Math.max(0, rect.top)}px`;
    layer.append(mark);
    return { target, label: labels[index]!, mark };
  });
  document.body.append(layer);
  let typed = "";
  const stop = () => {
    release();
    layer.remove();
    window.removeEventListener("scroll", stop, true);
    window.removeEventListener("resize", stop);
    window.removeEventListener("pointerdown", stop, true);
    if (stopHints === stop) stopHints = null;
  };
  const release = takeOverKeyboard((event) => {
    if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Backspace") typed = typed.slice(0, -1);
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      typed += event.key.toLowerCase();
    } else return stop();
    const matching = marks.filter(({ label }) => label.startsWith(typed));
    if (matching.length === 0) return stop();
    for (const { label, mark } of marks) mark.hidden = !label.startsWith(typed);
    const hit = matching.find(({ label }) => label === typed);
    if (!hit) return;
    stop();
    if (action === "focus") hit.target.focus();
    else hit.target.click();
  });
  // Labels sit where the controls were; any movement makes them wrong, so they go.
  window.addEventListener("scroll", stop, { capture: true, passive: true });
  window.addEventListener("resize", stop, { passive: true });
  window.addEventListener("pointerdown", stop, true);
  stopHints = stop;
  return true;
}

const handled =
  (run: () => boolean): CommandHandler =>
  (event) => {
    if (!run()) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

function clickInCursorRow(selector: string): boolean {
  const button = cursorRow()?.querySelector<HTMLElement>(selector);
  if (!button) return false;
  button.click();
  return true;
}

function clickThreadFind(which: "next" | "previous"): boolean {
  const button = document.querySelector<HTMLElement>(`[data-thread-find="${which}"]`);
  if (!button || (button as HTMLButtonElement).disabled) return false;
  button.click();
  return true;
}

function cycleRightPanelTab(step: 1 | -1): boolean {
  const tabs = Array.from(
    document.querySelectorAll<HTMLElement>("[data-right-panel-tab-list] [data-active-tab]"),
  ).filter(isShown);
  if (tabs.length === 0) return false;
  const current = tabs.findIndex((tab) => tab.dataset.activeTab === "true");
  tabs[(current + step + tabs.length) % tabs.length]?.click();
  return true;
}

/** App Normal mode's commands, in the capture phase so they come before type-to-focus. */
export function startVimNavigation(): () => void {
  const stop = registerCommands(
    {
      "workspace.focusLeft": handled(() => focusToward("left")),
      "workspace.focusRight": handled(() => focusToward("right")),
      "workspace.focusUp": handled(() => focusToward("up")),
      "workspace.focusDown": handled(() => focusToward("down")),
      "workspace.leaveTerminal": handled(() => {
        if (document.querySelector('[data-workspace-area="conversation"]')) {
          requestWorkspaceFocus({ area: "conversation" });
          return true;
        }
        return moveWorkspaceFocus(-1);
      }),
      "composer.focus": handled(() => {
        if (!document.querySelector('[data-workspace-area="composer"]')) return false;
        requestWorkspaceFocus({ area: "composer" });
        return true;
      }),
      "list.next": handled(() => moveInList("ArrowDown")),
      "list.previous": handled(() => moveInList("ArrowUp")),
      "list.first": handled(() => moveInList("Home")),
      "list.last": handled(() => moveInList("End")),
      "list.pageDown": handled(() => moveInList("ArrowDown", halfPageOfItems())),
      "list.pageUp": handled(() => moveInList("ArrowUp", halfPageOfItems())),
      "list.open": handled(() => {
        const target = activeElement();
        if (!target) return false;
        // Only groups and submenus expand. The sidebar claims ArrowRight on a thread row too
        // (it moves to the row's children), so a row without aria-expanded opens instead.
        if (!target.hasAttribute("aria-expanded") || !press(target, "ArrowRight")) target.click();
        return true;
      }),
      "list.close": handled(() => {
        const target = activeElement();
        if (!target) return false;
        press(target, "ArrowLeft");
        return true;
      }),
      "scroll.lineDown": handled(() => scroll("lineDown")),
      "scroll.lineUp": handled(() => scroll("lineUp")),
      "scroll.halfPageDown": handled(() => scroll("halfPageDown")),
      "scroll.halfPageUp": handled(() => scroll("halfPageUp")),
      "scroll.top": handled(() => scroll("top")),
      "scroll.bottom": handled(() => scroll("bottom")),
      "conversation.next": handled(() => moveCursor(1)),
      "conversation.previous": handled(() => moveCursor(-1)),
      "conversation.nextPrompt": handled(() => moveCursor(1, isUserPrompt)),
      "conversation.previousPrompt": handled(() => moveCursor(-1, isUserPrompt)),
      "conversation.first": handled(() => cursorToEnd("top")),
      "conversation.last": handled(() => cursorToEnd("bottom")),
      // An expander, not a menu button, which also carries aria-expanded.
      "conversation.toggle": handled(() =>
        clickInCursorRow('[aria-expanded]:not([aria-haspopup]):is([role="button"], button)'),
      ),
      "conversation.copy": handled(() => clickInCursorRow("[data-message-copy]")),
      "chat.findNext": handled(() => clickThreadFind("next")),
      "chat.findPrevious": handled(() => clickThreadFind("previous")),
      "diff.nextHunk": handled(() => jumpToHunk(1)),
      "diff.previousHunk": handled(() => jumpToHunk(-1)),
      "rightPanel.nextTab": handled(() => cycleRightPanelTab(1)),
      "rightPanel.previousTab": handled(() => cycleRightPanelTab(-1)),
      "hints.click": handled(() => showHints("click")),
      "hints.focus": handled(() => showHints("focus")),
      "keybindings.cheatSheet": handled(() => {
        toggleVimCheatSheet();
        return true;
      }),
    },
    { capture: true },
  );
  return () => {
    stop();
    stopHints?.();
  };
}
