// Links that depend on whose view they sit in.

import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import type { AgentRecord, AskRecord } from "../../../src/page/types.ts";

/** An ask, linked to its thread beside the entity it is on. */
export function AskLink({
  ask,
  entity,
  open,
  children,
  className,
}: {
  ask: AskRecord;
  entity: AgentRecord | null;
  open?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const style = cn(
    "flex items-start gap-2.5 rounded-md outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
    open && "bg-muted",
    className,
  );
  const current = open ? "true" : undefined;
  return entity === null ? (
    <Link
      data-row
      to="/asks/$askId"
      params={{ askId: ask.id }}
      aria-current={current}
      className={style}
    >
      {children}
    </Link>
  ) : (
    <Link
      data-row
      to="/people/$agentId/asks/$askId"
      params={{ agentId: entity.id, askId: ask.id }}
      aria-current={current}
      className={style}
    >
      {children}
    </Link>
  );
}
