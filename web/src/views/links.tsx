// Links that depend on whose view they sit in.

import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import type { ActorRecord, CallRecord } from "../../../src/human/types.ts";

/** A call, linked to its thread beside the entity it is on; a null entity is the user. */
export function CallLink({
  call,
  entity,
  open,
  children,
  className,
}: {
  call: CallRecord;
  entity: ActorRecord | null;
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
      to="/calls/$callId"
      params={{ callId: call.id }}
      aria-current={current}
      className={style}
    >
      {children}
    </Link>
  ) : (
    <Link
      data-row
      to="/people/$actorId/calls/$callId"
      params={{ actorId: entity.id, callId: call.id }}
      aria-current={current}
      className={style}
    >
      {children}
    </Link>
  );
}
