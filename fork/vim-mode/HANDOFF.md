# Vim mode for the composer — handoff

This is a personal fork of `pingdotgg/t3code`. Upstream does not accept outside feature PRs
(see `CONTRIBUTING.md`), so this feature lives only here and is never PR'd upstream.

This file is committed on purpose. The fork owner asked for the plan to live in the repo so another
agent can pick it up. That overrides the "do not commit plans" default in `AGENTS.md` for this one
folder (`fork/`). Everything else in `AGENTS.md` still applies, especially "The three ways to hurt
yourself" (never write to `~/.t3/userdata`, never kill processes by pattern).

## Goal

Vim-style modal editing inside the chat composer (the message box), built into the existing Tiptap
editor. It is not an "open the prompt in $EDITOR" handoff; the owner chose the built-in approach.

App-wide keyboard navigation (j/k in the sidebar, hint labels, leader keys) is a later phase. It is
summarised at the end and is out of scope for the first milestone.

## Decisions already made by the owner

| Topic | Decision |
|---|---|
| Approach | Vim built into the composer editor, not an external editor handoff |
| Enter in Normal mode | Sends the message, same as Enter in Insert (honours the `sendShortcut` setting) |
| `j` / `k` | Move by **screen line** (wrapped lines), like `gj`/`gk` in vim |
| `y` / `p` | Use the **system clipboard** (like `set clipboard=unnamedplus`) |
| Where | Branch `vim-mode` on this fork; `main` stays a clean mirror of upstream |

## Defaults chosen by the planner (owner may change)

- Off by default behind a setting. Settings → Chat → Composer → "Vim mode".
- The composer enters **Insert** whenever it gains focus (click, thread open, returning from
  another area) and after a message is sent. Chat is typing-first.
- A second `Esc` in Normal mode does nothing, as in vim. It does not leave the composer.
  Leaving the composer uses the app's existing area/thread shortcuts. The owner has `ctrl+h`/`ctrl+l`
  bound to `workspace.focusPrevious`/`Next` and `ctrl+j`/`ctrl+k` to `thread.next`/`previous`,
  so these must keep passing through in every vim mode.
- `0` / `$` / `^` work on the **logical** line (paragraph or list item), so `d$` behaves like vim.
  Only `j`/`k` are screen-line based.
- `jk` as an Esc alias is an optional setting, default off.

## Behaviour spec

### Modes

- **Insert.** Today's behaviour, unchanged. `Esc` switches to Normal *only if nothing else claims
  it* (see the Esc order below).
- **Normal.** Block cursor, a small `NORMAL` label in the composer footer. Unmodified printable
  keys never insert text. Unknown keys are swallowed (no typing leaks).
- **Visual** (`v`) and **Visual line** (`V`). The selection is the editor's real selection, so
  native highlight, copy and so on keep working.
- Japanese/Chinese-style keyboard input (IME) is never interrupted. Ignore keys while
  `event.isComposing || event.keyCode === 229`.

### Esc order of precedence (Insert mode)

1. IME composition in progress → leave it alone.
2. Dictation recording → its window capture listener in `apps/web/src/speech/useDictationShortcut.ts`
   already runs first and calls `stopImmediatePropagation`.
3. Composer `/` or `@` menu open → existing close behaviour (`composerCommandKey.ts`, `key === "Escape"`).
4. Prompt suggestion showing in an empty composer → existing dismiss behaviour (same place).
5. Otherwise → switch to Normal.

Practical hook: the editor forwards Escape to the composer handler at the end of `handleKeyDown`
(`const handled = handler(event.key, event)`). If that returns false for Escape, switch to Normal.

### Keys that must keep working in every mode

- Anything with `cmd` (macOS `mod`) → pass through to app keybindings (`hasCommandForKeyDown` in
  `apps/web/src/shortcuts/dispatcher.ts`).
- The owner's ctrl bindings: `ctrl+h/j/k/l` (area/thread navigation), `ctrl+c` (`thread.stop`),
  `ctrl+z` (`rightPanel.toggleMaximized`).
- Vim needs only these ctrl keys inside the composer: `ctrl+r` (redo) and `ctrl+[` (Esc alias).
  Neither is bound by default on macOS. Check `~/.t3/userdata/keybindings.json` read-only for clashes.

### Enter

- Normal: sends, through the same path as Insert. Prefer reusing the composer handler for `"Enter"`
  over re-implementing send.
- Visual: leave Visual first, then behave as Normal.

## Keymap — version 1

| Group | Keys |
|---|---|
| Enter Insert | `i a I A o O s S C cc` (and `c{motion}`) |
| Motions | `h l` (char), `j k` (screen line), `w b e W B E`, `0 ^ $`, `gg G`, `f F t T ; ,`, `%`, `{ }` |
| Operators | `d c y`, `>` / `<` (list indent/outdent), `~`, `gu`, `gU` |
| Text objects | `iw aw iW aW`, `i" a" i' a' i\` a\``, `i( a( i) a) i[ a[ i{ a{ i< a<`, `ip ap` |
| Edits | `x X r{c} D Y p P J dd yy` |
| Undo | `u`, `ctrl+r` |
| Counts | Everywhere vim allows, e.g. `3w`, `2dd`, `d3w` |
| Repeat | `.` repeats the last change, including text typed in the Insert session it opened |
| Visual | `v`, `V`, `o` (swap end), then `d c y > < ~ u U p` |
| History | `k` on the first screen line / `j` on the last → previous / next prompt (same as ArrowUp/Down today) |

Later (not v1): named registers (`"a`), `/` and `?` search in the prompt, `R` replace mode,
`ctrl+a` / `ctrl+x`, `ctrl+v` block visual, marks, macros, `:` commands.

## Content rules

- **Chips** (file mentions, skills, models, citations, context references) are atom nodes in the
  editor. Treat each chip as one character that is its own WORD. `x`, `dw` and `ciw` on a chip remove
  or replace the whole chip. Never split one.
- **Lines** for linewise ops (`dd yy V o O J >> <<`) are textblocks: a paragraph or a list/task item.
  Inside a code block, each `\n`-separated line is a line, and `o`/`O` insert a line inside the block.
- **Rich text trap.** In rich mode the editor reveals Markdown delimiters (`**`, `*`, `` ` ``)
  around the caret using the `markdownSource` mark (`MARKDOWN_SOURCE_MARK` in
  `apps/web/src/composer-rich-text.ts`). Edits that split or join blocks must collapse shown source
  first, the way the Enter path does (`collapseShownMarkdownSource` in `ComposerPromptEditorTiptap.tsx`).
  Decide whether motions see shown delimiters as text; whichever you pick, test it.
- **Plain-text mode** (`composerRichTextEnabled: false`) uses the same editor with fewer extensions.
  Vim must work in both.
- **Clipboard.**
  - Yank: write text with `navigator.clipboard.writeText`, serialised the same way the editor's copy
    does, so chips survive a round trip.
  - Paste: go through the existing paste importer (`importPastedComposerText` in
    `apps/web/src/components/composerInlineTokenPaste.ts`) so chips come back as chips.
  - Keep the last yank and its linewise/charwise flag in memory. If the clipboard text still equals
    it, paste with that flag (vim-like `p` after `yy`).
- **Undo granularity.** One Insert session is one undo step, and each Normal command is one undo step.
  The editor already has custom grouping (`ComposerUndoGroupingExtension`,
  `apps/web/src/composer-undo-grouping.ts`, `COMPOSER_UNDO_GROUP_DELAY`). Integrate with it rather
  than fighting it (for example, `closeHistory` from `@tiptap/pm/history` at mode switches).
- **Scope.** v1 targets the main chat composer (`ChatComposer.tsx` → `ComposerPromptEditorTiptap`).
  Skip it when `literalText` is set, on mobile, and when the software keyboard is open.

## Code map

| What | Where |
|---|---|
| Composer editor (Tiptap): extensions list, `editorProps.handleKeyDown`, `handleDOMEvents.keydown`, chip nodes, Enter/Tab handling | `apps/web/src/components/ComposerPromptEditorTiptap.tsx` (`createComposerExtensions`, `handleKeyDown`) |
| Composer key policy: Esc for menus and suggestions, arrows for menu and prompt history, send, list edits | `apps/web/src/components/chat/composerCommandKey.ts` (`composerCommandKeyHandler`, `navigatePromptHistory`) |
| Wiring of that handler and settings into the editor | `apps/web/src/components/chat/ChatComposer.tsx` (`onComposerCommandKey`) |
| "Caret on first/last visual line" helper (reuse for `j`/`k` → history) | `isCaretOnVisualEdge` on `ComposerPromptEditorHandle` in `ComposerPromptEditorTiptap.tsx` |
| Screen-line caret moves already done with `Selection.modify` | Top of `handleKeyDown` in `ComposerPromptEditorTiptap.tsx` (`lineboundary` / `documentboundary`) |
| Prompt string model where each chip is 1 char ("collapsed cursor") | `apps/web/src/composer-logic.ts` (`expandCollapsedComposerCursor`, `collapseExpandedComposerCursor`) |
| Undo grouping | `apps/web/src/composer-undo-grouping.ts` |
| Rich-text Markdown source mark | `apps/web/src/composer-rich-text.ts` |
| Paste import (chips round-trip) | `apps/web/src/components/composerInlineTokenPaste.ts` |
| Dictation Esc | `apps/web/src/speech/useDictationShortcut.ts` |
| App keybinding dispatch | `apps/web/src/shortcuts/dispatcher.ts`, `apps/web/src/keybindings.ts`, `packages/shared/src/keybindingMatching.ts` |
| Client setting schema (add `composerVimMode` next to `composerRichTextEnabled` and `sendShortcut`) | `packages/contracts/src/settings.ts` |
| Settings UI row (next to the `composer-rich-text` row, "Composer" section) | `apps/web/src/components/settings/SettingsPanels.tsx` |
| Existing composer tests to extend | `apps/web/src/components/ComposerPromptEditorTiptap.input.browser.test.tsx` and others beside the composer files |
| User docs to update when shipped | `docs/user/composer.md`, `docs/user/keybindings.md` |

**ProseMirror ordering note.** Props passed directly to the view (Tiptap `editorProps`) run before
plugin props. A vim plugin's `handleKeyDown` would therefore run *after* the composer's own
`editorProps.handleKeyDown`, which already handles Enter, Tab and so on. Hook vim at the top of
`editorProps.handleKeyDown`, or in `handleDOMEvents.keydown`, so it sees keys first in Normal and
Visual. In Insert it should only watch for Esc (and the optional `jk`).

## Suggested architecture

1. **Pure engine** in `apps/web/src/vim/` with no DOM and no Tiptap.
   - Key parser: counts, operator-pending state, `g`/`z`/`f`/`t`/`r` prefixes, text objects.
   - Motions and text objects over a small "line model": an array of lines, each a list of units
     where a chip is one unit.
   - Output: a list of edits (delete range, insert text, set selection, set mode, history action).
   - The record for `.` repeat lives here.
   - Table-driven unit tests, for example `{ before: "foo b|ar", keys: "diw", after: "foo |" }`.
2. **Tiptap adapter** (an extension plus a few helpers).
   - Builds the line model from `view.state` and maps unit offsets ↔ ProseMirror positions.
   - Applies edits as one transaction per command.
   - Draws the block cursor as a decoration. CSS `caret-shape: block` may work in Electron 44's
     Chromium — check before relying on it.
   - Owns the mode state and exposes it for the footer label.
   - Uses `Selection.modify("move", dir, "line")` for screen-line `j`/`k`, and `isCaretOnVisualEdge`
     to fall through to prompt history.
3. **Hook points.** A few lines each in `ComposerPromptEditorTiptap.tsx` (`handleKeyDown`) and
   `ChatComposer.tsx` (footer label, setting). Keep the diff in upstream files small; that is what
   keeps weekly rebases cheap.

## Milestones and acceptance

1. **Setup.** Install the toolchain and get `vp run dev:desktop` running from this checkout with its
   own `.t3` (see Dev setup below).
2. **Engine core.** Modes, counts, `h l w b e W B E 0 ^ $ gg G f F t T ; ,`, `x X r D`, `d c y`
   with motions, `dd cc yy`, `u`/`ctrl+r` as history actions. Unit tests green
   (`vp test run apps/web/src/vim`).
3. **Adapter.**
   - Works in rich and plain mode.
   - The Esc order of precedence is respected; IME is never broken.
   - Enter sends from Normal.
   - Chips behave as single units.
   - One undo step per Insert session and per Normal command.
   - Block cursor and `NORMAL` / `VISUAL` label are shown.
4. **The rest of v1.** Text objects, `v`/`V`, `p`/`P` with system clipboard and the linewise flag,
   `.` repeat, `>`/`<` on list items, `J`, `%`, `{ }`, screen-line `j`/`k` with history fall-through.
5. **Setting and docs.**
   - The setting is in `packages/contracts/src/settings.ts` plus a Settings row.
   - Off means byte-for-byte today's behaviour.
   - Short sections in `docs/user/composer.md` and `docs/user/keybindings.md`.
   - Run `vp run check:changed`.
6. **Ship to the owner.** Build the macOS app (see below) and give the owner the install steps.

## Testing

Follow `AGENTS.md` → Verifying.

- Most coverage belongs in engine unit tests (milliseconds each). One table covers motions,
  operators and text objects.
- Browser tests only for what needs a real browser: focus, the Esc order with the `/` menu open,
  IME guard, screen-line `j`/`k` on wrapped text, and clipboard. Use
  `apps/web/test/render.tsx` patterns (`await using screen = await render(...)`).
- Do not run repo-wide checks. Use `vp test run <files>` while iterating and
  `vp run check:changed` before pushing.
- One manual pass in the real desktop client (the `test-t3-app` skill in `.agents/skills/` shows how),
  using the free `Replay (dev)` provider so no real agent turns are spent.

## Dev setup on this machine

The repo uses Vite+ (`vp`), which pins its own Node (26.13.1). Neither `vp` nor `pnpm` is installed
yet; the system Node is 26.13.0. From `docs/operations/development.md`:

```sh
curl -fsSL https://vite.plus | bash   # installs vp; ask the owner before running installers
cd ~/dev/t3code
vp i
vp run dev:desktop                    # Electron client; state goes to this checkout's .t3
```

- The installed T3 Code Nightly is running and uses `~/.t3/userdata`. Never point a dev server at it.
  The dev runner seeds this checkout's own `.t3` from a read-only copy (see `AGENTS.md` → Test data).
- Read the real ports from the `[dev-runner]` line. Stop only processes you started, by PID.

## Fork workflow

- `origin` = `github.com/kwant-dbg/t3code` (this fork). `upstream` = `github.com/pingdotgg/t3code`.
- `main` mirrors upstream; never commit to it. Feature work happens on `vim-mode`.
- Sync: `git fetch upstream && git checkout main && git merge --ff-only upstream/main && git push origin main`,
  then `git checkout vim-mode && git rebase main`. Upstream moves fast (several nightlies a day), so
  sync often and keep upstream-file diffs small.
- Desktop build: `vp run dist:desktop:dmg:arm64` (see `docs/operations/development.md` → Desktop
  artifacts). The result is unsigned, so macOS asks for approval on first open.
- Before installing, check the built app's name and data directory. Do not run the fork build and the
  Nightly app against the same `~/.t3` at the same time.

## Later phase: app-wide keyboard navigation (not v1)

Summary of the agreed direction, for after composer vim ships:

- **Normal mode for the whole app** when focus is outside text fields.
  - `j`/`k` in the sidebar thread list (reuse its existing arrow-key roving), the Settings section
    list, and the conversation (message cursor).
  - `gg`/`G`, `ctrl+d`/`ctrl+u`.
- **Hint mode** `f`: labels on every clickable element; type the label to click.
- **Space leader**: `␣t` terminal, `␣d` diff, `␣p` preview, `␣b` sidebar, `␣m` model, `␣e` effort,
  `␣n` new thread.
- **Keybinding engine changes**: multi-key sequences (`"g g"`, `"space t"`) in
  `packages/shared/src/keybindings.ts` and `dispatcher.ts`; new `when` keys (`vimNormal`,
  `sidebarFocus`, `conversationFocus`, `popupOpen`); new commands (`composer.focus`, `list.*`,
  `scroll.*`).
- **Pop-ups**: `ctrl+n`/`ctrl+p` move the highlight in the command palette and model picker.
- The terminal and browser preview keep all keys; `ctrl+\` leaves them.

## Open questions to verify while building

- Does `caret-shape: block` work in Electron 44, or is a decoration needed?
- Does `navigator.clipboard.readText()` work in the desktop renderer without a prompt? If not, use
  the desktop bridge.
- Should shown Markdown delimiters count as characters for motions in rich mode?
- Is there an app keybinding on any ctrl key vim uses inside the composer, in the owner's
  `~/.t3/userdata/keybindings.json` (read-only)?
