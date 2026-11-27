import { z } from "zod";
import { SlotName } from "../base/names.js";

export const Slug = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .max(64);

/** A unit's id, unique within its provider. */
export const UnitId = Slug;
/** A field's id: the key of its value. */
export const FieldId = z
  .string()
  .regex(/^[a-z][A-Za-z0-9_]*$/)
  .max(64);
/** A field's value. */
export const FieldValue = z.union([
  z.string().max(4096),
  z.number(),
  z.boolean(),
  z.array(z.string().max(4096)).max(256),
]);
/** What was filled in, by field id. A field with no value isn't here. */
export const FieldValues = z.record(FieldId, FieldValue);

/** A capability's id, unique in its agent. */
export const CapabilityId = Slug;
/**
 * Something of a capability that can be watched or operated live, in a protocol the page knows:
 * what the capability has. Whether it can be opened now is a `LiveSurface`, which the capability
 * says of itself.
 */
export const Surface = z.strictObject({
  surface: Slug,
  /** The frames it speaks, such as `terminal@1`, `files@1` or `screencast@1`. */
  protocol: z.string().min(1).max(64),
});
/**
 * One row of a `facts` view: a label and a value. `path` is on a value that is a path, which a
 * host may draw as one; `caution` is on a value the person should heed, which a host draws apart;
 * `note` is a short line under the value that says what to make of it, which a host draws
 * quieter. A host that doesn't know `note` shows the value alone.
 */
export const FactRow = z.strictObject({
  label: z.string().min(1).max(64),
  value: z.string().max(1024),
  path: z.literal(true).optional(),
  caution: z.literal(true).optional(),
  note: z.string().min(1).max(256).optional(),
});
/**
 * What a `facts` view shows. An operation that feeds one answers this, as JSON text in its
 * `tools@1` output: the page reads it as this, and an agent that calls the operation reads the
 * same text. Nothing here checks it: the host that draws the view does.
 */
export const Facts = z.strictObject({ rows: z.array(FactRow).max(32) });
/**
 * One thing a piece of an agent's work did, as an `activity` view shows it: a call, with whether
 * it is running or how it ended, what it was given and what it gave back; words its worker wrote
 * and didn't send; or a line of its own, as for calls that never ran. A text longer than a view
 * shows is cut, and then ends "… (N more characters)", N being how many it had past the cut.
 */
export const WorkEntry = z.union([
  z.strictObject({
    id: z.string(),
    at: z.string(),
    call: z.strictObject({
      name: z.string(),
      state: z.enum(["running", "done", "refused"]),
      input: z.string(),
      output: z.string().optional(),
    }),
  }),
  z.strictObject({ id: z.string(), at: z.string(), words: z.string() }),
  z.strictObject({ id: z.string(), at: z.string(), line: z.string() }),
]);
/**
 * A model request that is being tried again after it failed for a passing reason, from before its
 * first wait until it writes, answers or ends: `attempt` is the number of the retry that begins at
 * `at` (an ISO 8601 time), from 1, the first try not being one, and `of` the most retries there
 * will be, though fewer may come. The first wait says 1 of `of`; while a retry runs, `at` is past.
 * Nothing says why: the words are the host's.
 */
export const Retrying = z.strictObject({
  attempt: z.number().int().min(1),
  of: z.number().int().min(1),
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/),
});
/**
 * One of the steps a piece of work keeps, in order: its words, `active` its words while it is in
 * progress when they differ, and whether it is still to come, in progress, or done. A piece of work
 * keeps at most eight, with at most one in progress.
 */
export const Step = z.strictObject({
  text: z.string(),
  active: z.string().optional(),
  state: z.enum(["pending", "in_progress", "completed"]),
});
/**
 * What an `activity` view shows, as its operation answers with no `work`, given `{ before? }`: an
 * agent's pieces of work, most recently active first, those last active before the piece of work
 * `before` when it is given, each with whether it is working, idle or stopped, when it was last
 * active, whether its last turn failed, its latest entries, oldest first, with `more` when older
 * ones remain, `retrying` while its model request is being tried again, and `steps`, the steps it
 * keeps, when it keeps any. Its own `more` says
 * whether pieces of work last active before those remain, and its own `retrying` is set while the
 * agent's main loop, which no piece of work is, has its model request tried again.
 */
export const Activity = z.strictObject({
  works: z.array(
    z.strictObject({
      id: z.string(),
      title: z.string(),
      state: z.enum(["working", "idle", "stopped"]),
      at: z.string().optional(),
      failed: z.literal(true).optional(),
      entries: z.array(WorkEntry),
      more: z.boolean(),
      retrying: Retrying.optional(),
      steps: z.array(Step).optional(),
    }),
  ),
  more: z.boolean().optional(),
  retrying: Retrying.optional(),
});
/**
 * One piece of work's entries, oldest first, as the operation of an `activity` view answers when
 * called with `{ work, before?, limit? }`: those before the entry `before`, `limit` at most, with
 * `more` when older ones remain.
 */
export const ActivityPage = z.strictObject({
  work: z.string(),
  entries: z.array(WorkEntry),
  more: z.boolean(),
});
/**
 * A view a capability gives the person's side, as data: the host draws it and the capability
 * paints nothing. `place` and `kind` name a place and a kind of view in the host's catalogue
 * (places `column` and `frame`; kinds `facts`, `status`, `meters`, `activity` and `presence`) and
 * are open: a host that doesn't know one doesn't show the view. Views are shown in the order they
 * are given.
 *
 * Its data is one of three:
 * - With `operation`: the answer of that tool of the connection the unit gives at `slot`, called
 *   with no arguments through the person's own binding to it. It is the tool an agent calls
 *   under that slot, so both read the same. For a `facts` view the answer is `Facts`; `rows`
 *   names the rows of it the view shows, by label, and it shows all of them when absent. For an
 *   `activity` view it is `Activity`, and called again with a piece of work, `ActivityPage`.
 * - With `surface`: that live surface of the capability. A `presence` view's speaks `presence@1`:
 *   who is acting on it now, and on what.
 * - With neither: rows fixed when the unit was applied, which `apply` gives.
 *
 * `when` shows it only while the agent is running, or only while the capability can be reached.
 */
export const View = z.strictObject({
  id: Slug,
  place: Slug,
  kind: Slug,
  when: z.enum(["running", "reachable"]).optional(),
  operation: z.string().min(1).max(128).optional(),
  /** The slot whose connection has `operation`: with it, always. */
  slot: SlotName.optional(),
  rows: z.array(z.string().min(1).max(64)).max(32).optional(),
  surface: Slug.optional(),
});
/** Something of an instance that can be watched or operated live, in a protocol the page knows. */
export const LiveSurface = z.object({
  surface: Slug,
  /** The frames it speaks, such as `terminal@1`, `files@1` or `screencast@1`. */
  protocol: z.string().min(1).max(64),
  /** Whether it can be operated, not only watched. */
  operate: z.boolean(),
  /** Why it can't be opened here, if it can't. */
  unavailable: z.string().max(2000).optional(),
});
export const LiveMode = z.enum(["watch", "operate"]);
/** A one-time ticket to open a surface: a socket address that is its own authority, briefly. */
export const LiveTicket = z.object({
  url: z.string().min(1).max(4096),
  protocol: z.string().min(1).max(64),
  expiresAt: z.string().max(64),
});
