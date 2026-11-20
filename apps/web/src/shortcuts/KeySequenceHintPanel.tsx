import { useMessages } from "gt-react";

import { commandLabel } from "~/components/settings/KeybindingsSettings.logic";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import { formatShortcutLabel } from "~/keybindings";
import type { PendingKeySequence } from "./dispatcher";

export default function KeySequenceHintPanel({ pending }: { pending: PendingKeySequence }) {
  const m = useMessages();
  return (
    <div
      role="status"
      className="pointer-events-none fixed right-4 bottom-4 z-[200] flex max-w-sm flex-col gap-1.5 rounded-lg border bg-popover p-3 text-popover-foreground text-xs shadow-lg"
    >
      <KbdGroup>
        {pending.typed.map((step, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- a sequence may repeat a key
          <Kbd key={index} variant="outline">
            {formatShortcutLabel(step)}
          </Kbd>
        ))}
      </KbdGroup>
      <ul className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
        {pending.next.map(({ step, command }) => (
          <li key={`${command}:${formatShortcutLabel(step)}`} className="contents">
            <Kbd>{formatShortcutLabel(step)}</Kbd>
            <span className="truncate text-muted-foreground">{commandLabel(command, m)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
