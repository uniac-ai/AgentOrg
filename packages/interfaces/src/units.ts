import { defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";
import { SKILL_FILE_MAX, SkillName, SkillPath } from "./agent-settings.js";
import { ConnectionSecrets, ConnectionStatus, ConnectionTarget } from "./connection.js";
import { Id, SlotName } from "./hub.js";

const Slug = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .max(64);
const Title = z.string().min(1).max(128);
const Description = z.string().max(2000);

/** A unit's id, unique within its provider. */
export const UnitId = Slug;
/** A field's id: the key of its value. */
export const FieldId = z
  .string()
  .regex(/^[a-z][A-Za-z0-9_]*$/)
  .max(64);
/** What a result is, such as `computer`. Only a unit of the same provider can take one for now. */
export const ResultKind = Slug;
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
 * host may draw as one; `caution` is on a value the person should heed, which a host draws apart.
 */
export const FactRow = z.strictObject({
  label: z.string().min(1).max(64),
  value: z.string().max(1024),
  path: z.literal(true).optional(),
  caution: z.literal(true).optional(),
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
 * and didn't send; or a line of its own, as for calls that never ran.
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
 * What an `activity` view shows, as its operation answers with no `work`, given `{ before? }`: an
 * agent's pieces of work, most recently active first, those last active before the piece of work
 * `before` when it is given, each with whether it is working, idle or stopped, when it was last
 * active, whether its last turn failed, and its latest entries, oldest first, with `more` when
 * older ones remain. Its own `more` says whether pieces of work last active before those remain.
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
    }),
  ),
  more: z.boolean().optional(),
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
 * (places `column` and `frame`; kinds `facts`, `status`, `meters` and `activity`) and are open: a host that
 * doesn't know one doesn't show the view. Views are shown in the order they are given.
 *
 * Its data is one of three:
 * - With `operation`: the answer of that tool of the connection the unit gives at `slot`, called
 *   with no arguments through the person's own binding to it. It is the tool an agent calls
 *   under that slot, so both read the same. For a `facts` view the answer is `Facts`; `rows`
 *   names the rows of it the view shows, by label, and it shows all of them when absent. For an
 *   `activity` view it is `Activity`, and called again with a piece of work, `ActivityPage`.
 * - With `surface`: that live surface of the capability.
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
/**
 * Slots and skills, for the agent's side, and surfaces and views, for the person's. A slot's or
 * a skill's name is fixed, or, with `field`, that field's value.
 */
const Gives = z.object({
  slots: z
    .array(z.union([z.strictObject({ name: SlotName }), z.strictObject({ field: FieldId })]))
    .max(32),
  skills: z
    .array(
      z.union([
        z.strictObject({ name: SkillName, files: z.array(SkillPath).min(1).max(256) }),
        z.strictObject({ field: FieldId }),
      ]),
    )
    .max(64),
  surfaces: z.array(Surface).max(16).optional(),
  views: z.array(View).max(32).optional(),
});

/**
 * One field of a unit's form, as data. `type` names a control in the host's catalogue (`text`,
 * `number`, `toggle`, `choice`, `choices`, `directory`, `secret`, `connection`) and is open: a host
 * that doesn't know a type draws the plain control for `value`, the kind of value it holds.
 *
 * `value: "secret"` is what makes a field secret, whatever its type: it has no `default`, is read
 * apart, is never saved in a template and is never read back; management refuses a value for one
 * anywhere but a stack's `secrets`.
 *
 * `visible` shows it only when another field has one of the given values, or, for a field holding
 * a list, includes one. A field that isn't shown has no value. `description` is written once, for a
 * person and an agent alike.
 *
 * `caution`, on a choice's option, says its `description` warns of what choosing it risks: a
 * host draws it as a caution while that option is the answer. A host that doesn't know it draws
 * it as any description.
 *
 * `adds`, on a choice's option or on a toggle (when on), is what that adds to what the unit gives.
 * What a unit will give is worked out from this and the values, with no call to its logic. Field ids are unique in a form, and management refuses a form that isn't
 * well made: a default of the wrong kind, a `visible` naming no field.
 */
export const Field = z.object({
  id: FieldId,
  type: Slug,
  value: z.enum(["string", "number", "boolean", "strings", "secret"]),
  title: Title,
  description: Description.optional(),
  required: z.literal(true).optional(),
  default: FieldValue.optional(),
  /**
   * What an agent may do with this field, by what it says. `setting`: how the unit works, within
   * bounds. `holds`: something the person already has. `contacts`: an address to reach. `instructs`:
   * text that will steer an agent. `runs`: a program to start with someone's rights, which an
   * agent may never set. With none, no agent may set it.
   */
  authority: z.enum(["setting", "holds", "contacts", "instructs", "runs"]).optional(),
  /** Greyed text of an empty field, saying what leaving it empty does. `{name}` is the agent's name. */
  placeholder: z.string().max(256).optional(),
  visible: z.object({ field: FieldId, in: z.array(FieldValue).min(1).max(64) }).optional(),
  options: z
    .array(
      z.object({
        value: z.string().max(256),
        title: Title,
        description: Description.optional(),
        caution: z.literal(true).optional(),
        adds: Gives.optional(),
      }),
    )
    .max(256)
    .optional(),
  adds: Gives.optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  unit: z.string().max(32).optional(),
});
export const Form = z.array(Field).max(64);

/**
 * A unit of an agent's stack: its form, what it needs from units above it, and what it gives
 * whatever is filled in; a field's `adds` says what its answer gives on top.
 */
export const Unit = z.object({
  id: UnitId,
  title: Title,
  description: Description,
  /**
   * The capability applying it builds into the agent, which the agent then holds: the unit's
   * connections, surfaces and views are its. `title` names it to a person; `id` is unique in
   * an agent, so an agent holds one of it. A unit with none gives slots and skills only.
   *
   * With `gives` and the form, this is what a host reads to say what an agent built from the
   * unit will hold, with no call to the unit's logic. Once the unit is applied, the agent is
   * asked, through what it holds, and the unit is not.
   */
  capability: z.strictObject({ id: CapabilityId, title: Title }).optional(),
  /**
   * An agent's stack holds this unit at most once: management refuses a second, and a host
   * leaves it out of what can be added to a stack that has it. A host that doesn't know it
   * offers the unit again, and the second is refused. Without it a unit may be there more than
   * once, as far as what each one gives allows. A unit that builds a `capability` is held once
   * by that, and needn't say so.
   */
  once: z.literal(true).optional(),
  form: Form,
  needs: z.array(ResultKind).max(16),
  gives: Gives.extend({ results: z.array(ResultKind).max(16) }),
});

/** A result of an applied unit, for units below it: an opaque handle. */
export const UnitResult = z.object({ kind: ResultKind, handle: z.string().min(1).max(4096) });
/** A problem with what was filled in: on one field, or, with no `field`, on the whole. */
export const Problem = z.object({ field: FieldId.optional(), message: z.string().max(2000) });

const OnInstance = z.object({ instance: Id });

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

/**
 * `unit.provider@1`: a program that offers units. Running one yields connections and the skills
 * it declared; management exposes them and records the instance, and removes instances last first.
 *
 * Management checks `values` against the form before `check` or `apply` see them: defaults are
 * applied and a field that isn't shown has no value. `secrets` reach `apply` only, once, and are
 * never saved or read back. `status` and `remove` are refused `unknown` for an instance this
 * provider doesn't hold. A unit removes only what it created.
 */
export const unitProvider = defineInterface({
  name: "unit.provider",
  major: 1,
  kind: "rpc",
  methods: {
    units: method({ input: z.object({}), output: z.object({ units: z.array(Unit) }) }),
    /**
     * A file of a skill a unit comes with, and `shipped`, the sha256 of each text it had in
     * earlier versions the provider shipped, so a copy of one of those can be told from an edit.
     * Refused `unknown` when there is no such file.
     */
    skill: method({
      input: z.object({ unit: UnitId, name: SkillName, path: SkillPath }),
      output: z.object({
        text: z.string().max(SKILL_FILE_MAX),
        shipped: z
          .array(z.string().regex(/^[0-9a-f]{64}$/))
          .max(256)
          .optional(),
      }),
    }),
    /**
     * The unit's own validation of what was filled in. It changes nothing. `secrets` names the
     * secret fields filled in, never their values.
     */
    check: method({
      input: z.object({ unit: UnitId, values: FieldValues, secrets: z.array(FieldId).max(64) }),
      output: z.object({ problems: z.array(Problem).max(64) }),
    }),
    /**
     * Run a unit for an agent. `needs` holds the handle of each result it needs, by kind. `name` is
     * for what it makes to show: an Actor's name. Each connection is an Actor exporting `tools@1`
     * as `tools`, for management to expose under `slot`. The slots must be those the description
     * and the values work out to, or management undoes the creation. `agent` is `person` for a
     * connection the person makes for no agent yet.
     */
    apply: method({
      input: z.object({
        unit: UnitId,
        values: FieldValues,
        secrets: ConnectionSecrets,
        needs: z.record(ResultKind, z.string().min(1).max(4096)),
        agent: Id,
        name: Title,
        /** The name the person gave the agent. None for an agent an agent made, or for no agent. */
        agentName: Title.optional(),
      }),
      output: z.object({
        instance: Id,
        connections: z
          .array(z.object({ slot: SlotName, connection: Id, target: ConnectionTarget }))
          .max(32),
        results: z.array(UnitResult).max(16),
        /**
         * For a unit that builds a capability: the Actor made for it, which exports
         * `capability@1` as `capability`, and, by view id, the rows of each view whose rows
         * are fixed now: exactly those views, or management undoes the creation. The Actor is
         * the instance's, like its connections, and not one of them: `remove` closes it with
         * them. Management connects the person to it and to the connections.
         */
        capability: z
          .strictObject({
            actor: Id,
            rows: z.record(Slug, z.array(FactRow).max(32)).optional(),
          })
          .optional(),
      }),
    }),
    /** How the instance stands now, with each of its connections' own. */
    status: method({
      input: OnInstance,
      output: z.object({
        state: ConnectionStatus.shape.state,
        detail: z.string().max(2000).optional(),
        connections: z.array(ConnectionStatus.extend({ connection: Id })).max(32),
        /** What of it can be opened live now. */
        surfaces: z.array(LiveSurface).max(16).optional(),
      }),
    }),
    /**
     * A one-time ticket to open one of its surfaces live. Only the person's gateway asks for one,
     * and it dials the url itself: no ticket reaches a page. Refused `unknown` for a surface the
     * instance doesn't have.
     */
    live: method({
      input: OnInstance.extend({ surface: Slug, mode: LiveMode }),
      output: LiveTicket,
    }),
    /** Final: it undoes what this instance made, and nothing the person pointed it at. */
    remove: method({ input: OnInstance, output: z.object({}) }),
  },
});
