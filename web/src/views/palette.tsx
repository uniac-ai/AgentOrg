// The jump palette: views, actors and pending calls in one filtered list, each told apart by its
// mark.

import { ActivityIcon, UserRoundIcon } from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import type { PaletteModel } from "../control/palette.tsx";
import { CallIcon, CallRoute, callTitle } from "./calls.tsx";
import { StateMark, StateName } from "./marks.tsx";

const VIEWS = [
  { to: "/", name: "You", Icon: UserRoundIcon },
  { to: "/activity", name: "Activity", Icon: ActivityIcon },
] as const;

export function PaletteView(model: PaletteModel) {
  return (
    <CommandDialog
      open={model.open}
      onOpenChange={model.onOpenChange}
      title="Jump to"
      description="An actor, a pending call or a view"
      className="sm:max-w-xl"
    >
      <Command>
        <CommandInput placeholder="Jump to…" />
        <CommandList>
          <CommandEmpty>No match</CommandEmpty>
          <CommandGroup>
            {VIEWS.map(({ to, name, Icon }) => (
              <CommandItem key={to} value={name} onSelect={() => model.onView(to)}>
                <Icon aria-hidden="true" />
                {name}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup>
            {model.actors.map((actor) => (
              <CommandItem
                key={actor.id}
                value={`${actor.name} ${actor.id}`}
                onSelect={() => model.onActor(actor)}
              >
                <StateMark actor={actor} />
                <span className="truncate">{actor.name}</span>
                <StateName actor={actor} />
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup>
            {model.calls.map((call) => (
              <CommandItem
                key={call.id}
                value={`${callTitle(call)} ${call.id}`}
                onSelect={() => model.onCall(call)}
              >
                <CallIcon call={call} />
                <span className="min-w-0 flex-1 truncate">{callTitle(call)}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  <CallRoute call={call} names={model.names} />
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
