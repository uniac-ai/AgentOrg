// Activity, control: every write and every routed call on the record, newest first, with the
// actors and calls each names resolved for display. The list starts at a page and grows on request.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { AuditRecord, CallRecord } from "../../../src/human/types.ts";
import { activityQuery, organizationQuery } from "../data/queries.ts";
import { calls } from "../model/organization.ts";
import { ActivityView } from "../views/activity.tsx";
import type { Names } from "../views/calls.tsx";
import { PaneSkeleton } from "../views/states.tsx";
import { namesOf } from "./entity.tsx";

const PAGE = 100;
const MAX = 1000;

export interface ActivityModel {
  entries: AuditRecord[];
  names: Names;
  /** The root's id: entries by it are the user's own. */
  root: string | undefined;
  calls: ReadonlyMap<string, CallRecord>;
  /** Whether older entries may exist beyond those shown. */
  more: boolean;
  onShowMore: () => void;
}

export function ActivityControl() {
  const [limit, setLimit] = useState(PAGE);
  const activity = useQuery(activityQuery(limit));
  const organization = useQuery(organizationQuery);
  if (!activity.data) return <PaneSkeleton />;
  const org = organization.data;
  const model: ActivityModel = {
    entries: activity.data.entries,
    names: org ? namesOf(org) : new Map(),
    root: org?.root,
    calls: org ? calls(org) : new Map(),
    more: activity.data.entries.length === limit && limit < MAX,
    onShowMore: () => setLimit((current) => Math.min(MAX, current + PAGE * 3)),
  };
  return <ActivityView {...model} />;
}
