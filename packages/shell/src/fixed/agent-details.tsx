// An agent's details beside your conversation with it, on the chat page: its face with its name
// beside it, which go to it on the team page, what it is for under them, read whole, and its own
// Close. Its ground and its frame are the side's it is shown in.
import { XIcon } from "lucide-react";
import { go } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { useCreatables } from "./data.ts";
import { Face } from "./face.tsx";
import { useAgents } from "./watch.tsx";

export function AgentDetails({ agent: id, onClose }: { agent: string; onClose(): void }) {
  const watched = useAgents().byId.get(id);
  const creatables = useCreatables();
  if (!watched) return null;
  const { entry, now } = watched;
  // What it is for: its own words, or else what it was made from says.
  const purpose =
    entry.purpose ??
    creatables?.find((c) => c.provider === entry.provider && c.id === entry.creatable)?.description;
  return (
    <section
      aria-label={`${entry.name}'s details`}
      className="no-bar h-full w-full min-w-0 overflow-y-auto p-3"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={`${entry.name} on the team page`}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left"
          onClick={() => go({ screen: "team", agent: id })}
        >
          <Face agent={{ id, name: entry.name, tone: now.tone }} size={48} plain />
          <span className="truncate text-[17px] font-semibold">{entry.name}</span>
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Close ${entry.name}'s details`}
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      {purpose && <p className="mt-3 text-[15px] text-muted-foreground">{purpose}</p>}
    </section>
  );
}
