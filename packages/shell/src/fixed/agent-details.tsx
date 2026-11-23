// An agent's details beside your conversation with it, on the chat page: its page, laid out for the
// side's width, with its own Close. What frames it is the side it is shown in.
import { XIcon } from "lucide-react";
import { Button } from "../ui/button.tsx";
import { AgentPage } from "./agent-page.tsx";

export function AgentDetails({
  agent,
  onClose,
}: {
  agent: { id: string; name: string };
  onClose(): void;
}) {
  return (
    <section
      aria-label={`${agent.name}'s details`}
      className="@container/main relative h-full w-full overflow-hidden rounded-[10px] bg-[var(--canvas)]"
    >
      <AgentPage key={agent.id} agent={agent.id} beside />
      {/* Over its corner, on its ground, so what scrolls under it is cut cleanly. */}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Close ${agent.name}'s details`}
        className="absolute top-2 right-2 bg-[var(--canvas)]"
        onClick={onClose}
      >
        <XIcon />
      </Button>
    </section>
  );
}
