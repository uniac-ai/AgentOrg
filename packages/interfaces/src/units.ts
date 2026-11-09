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

/** Slots and skills. A slot's or a skill's name is fixed, or, with `field`, that field's value. */
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
  visible: z.object({ field: FieldId, in: z.array(FieldValue).min(1).max(64) }).optional(),
  options: z
    .array(
      z.object({
        value: z.string().max(256),
        title: Title,
        description: Description.optional(),
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
  form: Form,
  needs: z.array(ResultKind).max(16),
  gives: Gives.extend({ results: z.array(ResultKind).max(16) }),
});

/** A result of an applied unit, for units below it: an opaque handle. */
export const UnitResult = z.object({ kind: ResultKind, handle: z.string().min(1).max(4096) });
/** A problem with what was filled in: on one field, or, with no `field`, on the whole. */
export const Problem = z.object({ field: FieldId.optional(), message: z.string().max(2000) });

const OnInstance = z.object({ instance: Id });

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
    /** A file of a skill a unit comes with. Refused `unknown` when there is no such file. */
    skill: method({
      input: z.object({ unit: UnitId, name: SkillName, path: SkillPath }),
      output: z.object({ text: z.string().max(SKILL_FILE_MAX) }),
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
      }),
      output: z.object({
        instance: Id,
        connections: z
          .array(z.object({ slot: SlotName, connection: Id, target: ConnectionTarget }))
          .max(32),
        results: z.array(UnitResult).max(16),
      }),
    }),
    /** How the instance stands now, with each of its connections' own. */
    status: method({
      input: OnInstance,
      output: z.object({
        state: ConnectionStatus.shape.state,
        detail: z.string().max(2000).optional(),
        connections: z.array(ConnectionStatus.extend({ connection: Id })).max(32),
      }),
    }),
    /** Final: it undoes what this instance made, and nothing the person pointed it at. */
    remove: method({ input: OnInstance, output: z.object({}) }),
  },
});
