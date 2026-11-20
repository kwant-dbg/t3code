# Keyboard focus

The command palette keeps focus while open. Closing it returns focus to the composer in chat,
or to the previous control on other pages. Choosing a workspace focus command moves to that
area instead. Opening Pull Requests moves focus into that page.
While the palette or model picker is open, number shortcuts select its entries instead of
switching threads. Model shortcuts work in Settings as well as the composer.
See [Keybindings](./keybindings.md) to customize these shortcuts.

If you return to typing while a terminal is starting, the composer keeps focus when the terminal
becomes ready. Opening or switching to a terminal explicitly still focuses it.

## Move between workspace areas

On web and desktop, press `F6` or `Shift+F6` to move between the Threads sidebar,
conversation, message input, and visible panels. Navigation wraps around and restores
the last focused control in each area. Pull Requests has a page content area. In Settings,
`F6` moves between the section list and the open section. Hidden areas are skipped. Other
dialogs and form popups retain focus; a thread context menu closes when an area command
moves focus away.

In a browser, plain `F6` may move to the browser's own toolbar. Use `mod+F6` and
`mod+Shift+F6` instead (`mod` is Command on macOS and Ctrl elsewhere). **Focus Next
Workspace Area** and **Focus Previous Workspace Area** are also in the command palette and
can be remapped in Settings > Keybindings.

## Browse threads

Tab moves through each thread and its buttons. Up and Down also move between threads
without opening them; Enter opens the focused thread or toggles a group. Right and Left
expand and collapse groups. `F2` renames the focused thread.

Press `Shift+F10` or the Context Menu key to open the focused thread's menu. Use the arrow
keys to move through it, Enter to choose, and Escape to close it.

The Settings section list works the same way: Tab moves through each section, Up and Down
also move between sections without opening them, and Enter opens one.

## Move around with vim keys

With **Settings → Chat → Vim mode** on, keys pressed outside a text box are
vim commands instead of typing into the composer. `i` or `a` returns to the
composer in Insert mode.

- **Areas:** `Ctrl+W` then `h`, `j`, `k` or `l` moves to the area to the left,
  below, above or right, as between vim windows. It works from a text box in
  Normal mode too. The terminal keeps every key; `Ctrl+\` `Ctrl+N` leaves
  it. A browser page also keeps every key; leave it with `Shift+Escape`.
- **Lists** (threads, Settings sections, menus, pickers): `j` and `k` move, `gg`
  and `G` go to the ends, `Ctrl+D` and `Ctrl+U` move half a page, `l` opens or
  expands and `h` collapses. In the sidebar, `r` renames, `dd` archives (asking
  first if **Settings → General → Archive confirmation** is on), `yy` copies the thread's link and
  `/` searches. In a picker's search box, `Ctrl+N` and `Ctrl+P` move the
  highlight.
- **Conversation:** `j` and `k` move a cursor between messages, `[[` and `]]`
  between your prompts, `gg` and `G` to the first and last. `Enter` or `za`
  expands the work under the cursor and `yy` copies the message. `Ctrl+E`,
  `Ctrl+Y`, `Ctrl+D` and `Ctrl+U` scroll. `/` finds in the thread; `n` and `N`
  move between matches.
- **Right panel:** in a diff or file, `j`, `k`, `gg` and `G` scroll, `]f` and
  `[f` move between files, `]c` and `[c` between changes, and `za` folds a file.
  `gt` and `gT` switch tabs and `q` closes one.
- **Anywhere:** `:` opens the command palette, `Ctrl+O` and `Ctrl+I` go back and
  forward, and `?` lists every vim key as you have it bound. `f` labels each
  visible control; type a label to click it, or use `F` to focus it instead.
  `space` starts a shortcut: `space t` terminal, `space d` diff, `space p`
  preview, `space b` sidebar, `space m` model, `space e` effort, `space n` new
  thread.

All of these are keybindings you can change in **Settings → Keybindings**; see
[Vim keys](./keybindings.md#vim-keys).
