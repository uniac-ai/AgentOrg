// ⌘K (or Ctrl+K), control: jump to a view, an actor or an open question. A question opens where
// the user answers it: on the user's page when it waits on the user, else on its asker's page.

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useKeys } from "@/lib/keys";
import type { QuestionRecord } from "../../../src/clients/web/types.ts";
import { organizationQuery } from "../data/queries.ts";
import { flatten, type Member, openQuestions } from "../model/organization.ts";
import type { Names } from "../views/messages.tsx";
import { PaletteView } from "../views/palette.tsx";
import { namesOf } from "./cards.ts";

export type Destination = "/" | "/activity";

export interface PaletteModel {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  members: Member[];
  /** Every open question, oldest first. */
  questions: QuestionRecord[];
  names: Names;
  onView: (to: Destination) => void;
  onActor: (member: Member) => void;
  onQuestion: (question: QuestionRecord) => void;
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
  const root = org?.root.id;
  const model: PaletteModel = {
    open,
    onOpenChange: setOpen,
    members: org ? flatten(org.root.reports) : [],
    questions: org ? openQuestions(org) : [],
    names: org ? namesOf(org) : new Map(),
    onView: (to) => go(() => navigate({ to })),
    onActor: (member) =>
      go(() => navigate({ to: "/people/$actorId", params: { actorId: member.id } })),
    onQuestion: (question) =>
      go(() =>
        question.to === root || question.answerer === root
          ? navigate({ to: "/" })
          : navigate({ to: "/people/$actorId", params: { actorId: question.from } }),
      ),
  };
  return <PaletteView {...model} />;
}
