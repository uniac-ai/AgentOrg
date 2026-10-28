// The jump palette: views, actors and open questions in one filtered list, each told apart by its
// mark.

import { ActivityIcon, MessageCircleQuestionIcon, UserRoundIcon } from "lucide-react";
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
import { SR, StateMark, StateName } from "./marks.tsx";
import { firstLine, nameOf } from "./messages.tsx";

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
      description="An actor, an open question or a view"
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
            {model.members.map((member) => (
              <CommandItem
                key={member.id}
                value={`${member.name} ${member.id}`}
                onSelect={() => model.onActor(member)}
              >
                <StateMark member={member} />
                <span className="truncate">{member.name}</span>
                <StateName member={member} />
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup>
            {model.questions.map((question) => (
              <CommandItem
                key={question.id}
                value={`${firstLine(question.text)} ${question.id}`}
                onSelect={() => model.onQuestion(question)}
              >
                <MessageCircleQuestionIcon aria-hidden="true" className="text-state-waiting" />
                <span className="min-w-0 flex-1 truncate">{firstLine(question.text)}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {nameOf(question.from, model.names)}
                  <span aria-hidden="true"> → </span>
                  <SR> to </SR>
                  {nameOf(question.to, model.names)}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
