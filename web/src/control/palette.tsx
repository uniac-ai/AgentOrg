// ⌘K (or Ctrl+K), control: jump to a view, an actor or a pending call. A call opens where it
// waits: in the user's own view when it waits on the user, else in its callee's view.

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useKeys } from "@/lib/keys";
import type { ActorRecord, CallRecord } from "../../../src/human/types.ts";
import { organizationQuery } from "../data/queries.ts";
import { flatten, tree } from "../model/organization.ts";
import type { Names } from "../views/calls.tsx";
import { PaletteView } from "../views/palette.tsx";
import { namesOf } from "./entity.tsx";

export type Destination = "/" | "/activity";

export interface PaletteModel {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actors: ActorRecord[];
  /** Every call waiting on someone, oldest first. */
  calls: CallRecord[];
  names: Names;
  onView: (to: Destination) => void;
  onActor: (actor: ActorRecord) => void;
  onCall: (call: CallRecord) => void;
}

export function PaletteControl() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const organization = useQuery(organizationQuery);
  useKeys((event) => {
    if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return false;
    setOpen((current) => !current);
    return true;
  });
  const go = (to: () => Promise<void>) => {
    setOpen(false);
    void to();
  };
  const org = organization.data;
  const model: PaletteModel = {
    open,
    onOpenChange: setOpen,
    actors: org ? flatten(tree(org)) : [],
    calls: org
      ? Object.values(org.views)
          .flatMap((view) => view.pending)
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
      : [],
    names: org ? namesOf(org) : new Map(),
    onView: (to) => go(() => navigate({ to })),
    onActor: (actor) =>
      go(() => navigate({ to: "/people/$actorId", params: { actorId: actor.id } })),
    onCall: (call) =>
      go(() =>
        call.to === org?.root
          ? navigate({ to: "/calls/$callId", params: { callId: call.id } })
          : navigate({
              to: "/people/$actorId/calls/$callId",
              params: { actorId: call.to, callId: call.id },
            }),
      ),
  };
  return <PaletteView {...model} />;
}
