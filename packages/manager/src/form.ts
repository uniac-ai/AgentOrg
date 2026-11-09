/**
 * The one place a unit's form is read: what its fields come to once filled in, what the unit will
 * then give, and the JSON Schema an agent fills. A form is data; nothing here calls the unit.
 */
import type { Field, FieldValues, Form, Problem, Unit } from "@agentorg/interfaces";
import type { z } from "zod";

type TheField = z.infer<typeof Field>;
type TheForm = z.infer<typeof Form>;
type Values = z.infer<typeof FieldValues>;
type TheProblem = z.infer<typeof Problem>;
type TheUnit = z.infer<typeof Unit>;
type Value = Values[string];

const fits = (field: TheField, value: Value) =>
  field.value === "strings"
    ? Array.isArray(value)
    : typeof value === (field.value === "secret" ? "string" : field.value);

/** What is wrong with a form as written: a unit that has one is refused, whatever is filled in. */
export function formProblems(form: TheForm): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const field of form) {
    if (ids.has(field.id)) problems.push(`${field.id} is in the form twice.`);
    ids.add(field.id);
    if (field.value === "secret" && field.default !== undefined)
      problems.push(`${field.id} is a secret, which has no default.`);
    else if (field.default !== undefined && !fits(field, field.default))
      problems.push(`${field.id}'s default isn't a ${field.value}.`);
    if (field.min !== undefined && field.max !== undefined && field.min > field.max)
      problems.push(`${field.id}'s min is above its max.`);
  }
  for (const field of form)
    if (field.visible && !ids.has(field.visible.field))
      problems.push(`${field.id} depends on ${field.visible.field}, which isn't in the form.`);
  return problems;
}

/** Which fields are shown, given what was filled in and the defaults. */
function shownFields(form: TheForm, values: Values): Set<string> {
  const byId = new Map(form.map((field) => [field.id, field]));
  const seen = new Map<string, boolean>();
  const shown = (id: string): boolean => {
    const known = seen.get(id);
    if (known !== undefined) return known;
    seen.set(id, false); // A field that depends on itself, however far round, isn't shown.
    const field = byId.get(id) as TheField;
    const { visible } = field;
    let answer = true;
    if (visible) {
      const other = byId.get(visible.field);
      const value = other && shown(other.id) ? (values[other.id] ?? other.default) : undefined;
      answer =
        value !== undefined &&
        (Array.isArray(value)
          ? value.some((one) => visible.in.includes(one))
          : visible.in.some((one) => one === value));
    }
    seen.set(id, answer);
    return answer;
  };
  return new Set(form.filter((field) => shown(field.id)).map((field) => field.id));
}

/**
 * What the unit's logic will read: `values` checked against the form, defaults applied, and a
 * field that isn't shown dropped. Problems name the field. A value for a secret field is one.
 */
export function settle(
  form: TheForm,
  values: Values,
  secrets: string[],
): { values: Values; secrets: string[]; problems: TheProblem[] } {
  const problems: TheProblem[] = [];
  // An empty answer is no answer: a default applies, and a required field isn't filled in.
  values = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ""));
  const shown = shownFields(form, values);
  const settled: Values = {};
  const kept: string[] = [];
  for (const id of Object.keys(values))
    if (!form.some((field) => field.id === id))
      problems.push({ field: id, message: `This unit has no field ${id}.` });
  for (const name of secrets)
    if (!form.some((field) => field.id === name && field.value === "secret"))
      problems.push({ message: `${name} isn't a secret of this unit.` });
  for (const field of form) {
    if (field.value === "secret") {
      if (values[field.id] !== undefined)
        problems.push({
          field: field.id,
          message: `${field.title} is a secret: it isn't a value.`,
        });
      if (!shown.has(field.id)) continue;
      if (secrets.includes(field.id)) kept.push(field.id);
      else if (field.required)
        problems.push({ field: field.id, message: `${field.title} must be given.` });
      continue;
    }
    if (!shown.has(field.id)) continue;
    const value = values[field.id] ?? field.default;
    if (value === undefined) {
      if (field.required)
        problems.push({ field: field.id, message: `${field.title} must be filled in.` });
      continue;
    }
    if (!fits(field, value)) {
      problems.push({ field: field.id, message: `${field.title} must be a ${field.value}.` });
      continue;
    }
    if (field.options) {
      const offered = new Set(field.options.map((option) => option.value));
      if (![value].flat().every((one) => offered.has(String(one))))
        problems.push({ field: field.id, message: `${field.title} isn't one of its options.` });
    }
    if (
      typeof value === "number" &&
      ((field.min !== undefined && value < field.min) ||
        (field.max !== undefined && value > field.max))
    )
      problems.push({ field: field.id, message: `${field.title} is out of range.` });
    settled[field.id] = value;
  }
  return { values: settled, secrets: kept, problems };
}

type Gives = TheUnit["gives"];
export interface Worked {
  slots: string[];
  /** Each with its files, or none for a skill the unit names by a field. */
  skills: { name: string; files?: string[] }[];
}

/** What a unit gives for these settled values: what it always gives, and what its answers add. */
export function workedOut(unit: TheUnit, values: Values): Worked {
  const adds: Pick<Gives, "slots" | "skills">[] = [unit.gives];
  for (const field of unit.form) {
    const value = values[field.id];
    if (value === undefined) continue;
    if (value === true && field.adds) adds.push(field.adds);
    for (const option of field.options ?? [])
      if (option.adds && [value].flat().map(String).includes(option.value)) adds.push(option.adds);
  }
  const nameOf = (from: { field: string }) => {
    const value = values[from.field];
    return typeof value === "string" ? value : undefined;
  };
  const slots = new Set<string>();
  const skills = new Map<string, Worked["skills"][number]>();
  for (const add of adds) {
    for (const slot of add.slots) {
      const name = "name" in slot ? slot.name : nameOf(slot);
      if (name) slots.add(name);
    }
    for (const skill of add.skills) {
      if ("name" in skill) skills.set(skill.name, skill);
      else {
        const name = nameOf(skill);
        if (name) skills.set(name, { name });
      }
    }
  }
  return { slots: [...slots], skills: [...skills.values()] };
}

/**
 * The JSON Schema of a form, for an agent to fill: flat strings, numbers, booleans and enums, as
 * MCP's elicitation allows. A secret is left out: an agent can never supply one. A field that shows
 * only after a choice is optional and says so.
 */
export function schemaOf(form: TheForm): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const field of form) {
    if (field.value === "secret") continue;
    const type = { string: "string", number: "number", boolean: "boolean", strings: "array" }[
      field.value
    ];
    const notes = [
      field.title,
      field.description,
      ...(field.options ?? []).map((option) =>
        option.description ? `${option.value}: ${option.description}` : undefined,
      ),
      field.visible
        ? `Only when ${field.visible.field} is ${field.visible.in.join(" or ")}.`
        : undefined,
    ].filter(Boolean);
    const allowed = field.options?.map((option) => option.value);
    properties[field.id] = {
      type,
      description: notes.join(" "),
      ...(field.value === "strings"
        ? { items: { type: "string", ...(allowed ? { enum: allowed } : {}) } }
        : allowed
          ? { enum: allowed }
          : {}),
      ...(field.min === undefined ? {} : { minimum: field.min }),
      ...(field.max === undefined ? {} : { maximum: field.max }),
      ...(field.default === undefined ? {} : { default: field.default }),
    };
    if (field.required && !field.visible && field.default === undefined) required.push(field.id);
  }
  return { type: "object", properties, required };
}
