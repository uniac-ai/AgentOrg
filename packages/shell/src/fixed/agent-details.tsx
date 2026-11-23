// An agent's details beside your conversation with it, on the chat page: its Close in a thin row
// at the top, and under it one card with its face, its name and what it is for, stacked and
// centred at the creation window's sizes. Its face and name go to it on the team page. The
// column's ground and frame are the side's it is shown in.
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
      {/* Set off from whatever ground the side has by its line and its fill. */}
      <div className="mt-3 flex flex-col items-center rounded-2xl border bg-[var(--raised)] px-6 py-6 text-center">
        <button
          type="button"
          aria-label={`${entry.name} on the team page`}
          className="flex max-w-full flex-col items-center rounded-xl"
          onClick={() => go({ screen: "team", agent: id })}
        >
          <Face agent={{ id, name: entry.name, tone: now.tone }} size={80} plain />
          <span className="mt-4 max-w-full text-[22px] leading-8 font-semibold tracking-tight">
            {entry.name}
          </span>
        </button>
        {purpose && <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{purpose}</p>}
      </div>
    </section>
  );
}
