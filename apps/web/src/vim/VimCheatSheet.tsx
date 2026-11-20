import { useAtomValue } from "@effect/atom-react";
import { useGT, useMessages } from "gt-react";

import { commandLabel } from "~/components/settings/KeybindingsSettings.logic";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Kbd } from "~/components/ui/kbd";
import { formatBindingLabel } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { closeVimCheatSheet } from "./cheatSheetStore";
import { type CheatSheetGroup, vimCheatSheetRows } from "./cheatSheet";
import { withVimKeybindings } from "./vimKeybindings";

const GROUPS: ReadonlyArray<CheatSheetGroup> = [
  "anywhere",
  "lists",
  "sidebar",
  "conversation",
  "rightPanel",
];

/** `?` in app Normal mode: the vim keys as they are bound now, rebinds included. */
export default function VimCheatSheet() {
  const gt = useGT();
  const m = useMessages();
  const rows = vimCheatSheetRows(withVimKeybindings(useAtomValue(primaryServerKeybindingsAtom)));
  const titles: Record<CheatSheetGroup, string> = {
    anywhere: gt("Anywhere"),
    lists: gt("Lists and pickers"),
    sidebar: gt("Sidebar"),
    conversation: gt("Conversation"),
    rightPanel: gt("Right panel"),
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeVimCheatSheet();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{gt("Vim keys")}</DialogTitle>
          <DialogDescription>
            {gt("Keys for moving around the app. Change them in Settings → Keybindings.")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4 sm:grid-cols-2">
            {GROUPS.map((group) => {
              const groupRows = rows.filter((row) => row.group === group);
              if (groupRows.length === 0) return null;
              return (
                <section key={group} className="flex flex-col gap-1.5">
                  <h3 className="font-medium text-sm">{titles[group]}</h3>
                  <ul className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-xs">
                    {groupRows.map((row) => {
                      const keys = formatBindingLabel(row.binding);
                      return (
                        <li key={`${row.command}:${keys}`} className="contents">
                          <Kbd>{keys}</Kbd>
                          <span className="text-muted-foreground">
                            {commandLabel(row.command, m)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
