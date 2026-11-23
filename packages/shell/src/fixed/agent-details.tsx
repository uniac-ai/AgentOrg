// An agent's details beside your conversation with it, on the chat page: its Close in a thin row
// at the top, its face with its name beside it, which go to it on the team page, and what it is
// for in a box under them, read whole. Its ground and its frame are the side's it is shown in.
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
      className="no-bar h-full w-full min-w-0 overflow-y-auto"
    >
      {/* A thin row for its Close alone, in the corner. */}
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Close ${entry.name}'s details`}
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      <div className="px-3 pb-3">
        <button
          type="button"
          aria-label={`${entry.name} on the team page`}
          className="flex w-full min-w-0 items-center gap-3 rounded-xl text-left"
          onClick={() => go({ screen: "team", agent: id })}
        >
          <Face agent={{ id, name: entry.name, tone: now.tone }} size={48} plain />
          <span className="truncate text-[17px] font-semibold">{entry.name}</span>
        </button>
        {/* In a box of its own, set off from whatever ground the side has by its line and its fill. */}
        {purpose && (
          <p className="mt-3 rounded-xl border bg-[var(--raised)] px-3 py-2.5 text-[15px] text-muted-foreground">
            {purpose}
          </p>
        )}
      </div>
    </section>
  );
}
