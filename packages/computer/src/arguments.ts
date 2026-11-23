// A unit's form as a capability's arguments: the JSON Schema of an object, which a page draws and an
// agent reads in the same words, with the token marked `secret`. And what a unit's answers give an
// agent of its skills, as management works it out of the unit for an applied one.
import type { ArgumentsSchema, Unit } from "@agentorg/interfaces";
import type { z } from "zod";
import { skillFiles } from "./unit.js";

type TheUnit = z.input<typeof Unit>;
type Field = TheUnit["form"][number];

/** Whether a field is asked, given the answers: one shown only after another's answer, then. */
const shown = (field: Field, values: Record<string, unknown>) =>
  !field.visible || field.visible.in.includes(String(values[field.visible.field]));

/**
 * The unit's form as the JSON Schema of the capability's arguments, said as management says a
 * unit's form to an agent: each choice's options, those that can't be chosen now and why, and when
 * a field is asked, in its description. A secret field is marked `secret`.
 */
export function argumentsOf(unit: TheUnit): z.output<typeof ArgumentsSchema> {
  const properties: Record<string, z.core.util.JSONType> = {};
  const required: string[] = [];
  for (const field of unit.form) {
    const secret = field.value === "secret";
    const type = {
      string: "string",
      secret: "string",
      number: "number",
      boolean: "boolean",
      strings: "array",
    }[field.value];
    const notes = [
      field.description,
      ...(field.options ?? []).map((option) =>
        option.description ? `${option.value}: ${option.description}` : undefined,
      ),
      ...(field.options ?? []).map((option) =>
        option.unavailable
          ? `${option.value} can't be chosen now: ${option.unavailable}`
          : undefined,
      ),
      field.visible
        ? `Only when ${field.visible.field} is ${field.visible.in.join(" or ")}.`
        : undefined,
    ].filter(Boolean);
    const allowed = field.options?.map((option) => option.value);
    properties[field.id] = {
      type,
      title: field.title,
      ...(notes.length ? { description: notes.join(" ") } : {}),
      ...(field.value === "strings"
        ? { items: { type: "string", ...(allowed ? { enum: allowed } : {}) } }
        : allowed
          ? { enum: allowed }
          : {}),
      ...(field.default === undefined ? {} : { default: field.default }),
      ...(secret ? { secret: true } : {}),
    } as z.core.util.JSONType;
    if (field.required && !field.visible && field.default === undefined) required.push(field.id);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

/** Whether a value is of the kind a field takes. */
const fits = (field: Field, value: unknown) =>
  field.value === "boolean"
    ? typeof value === "boolean"
    : field.value === "number"
      ? typeof value === "number"
      : field.value === "strings"
        ? Array.isArray(value) && value.every((one) => typeof one === "string")
        : typeof value === "string";

/**
 * The answers as management settles a unit's before it is applied, and what is wrong with them,
 * in management's words: each field asked, given or at its default, and no other; a secret as a
 * secret; each answer of its kind, and one of its options that can be chosen now.
 */
export function settle(
  unit: TheUnit,
  given: Record<string, unknown>,
): {
  values: Record<string, unknown>;
  secrets: Record<string, string>;
  problems: { field?: string; message: string }[];
} {
  const values: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  const problems: { field?: string; message: string }[] = [];
  for (const name of Object.keys(given))
    if (!unit.form.some((field) => field.id === name))
      problems.push({ message: `${name} isn't an argument of ${unit.title}.` });
  // In the form's order, so a field shown by an earlier one's answer sees that answer settled.
  for (const field of unit.form) {
    if (!shown(field, values)) continue;
    const value = given[field.id] ?? field.default;
    if (field.value === "secret") {
      if (typeof value === "string" && value.length > 0) secrets[field.id] = value;
      else if (field.required)
        problems.push({ field: field.id, message: `${field.title} must be given.` });
      continue;
    }
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
      else
        for (const option of field.options)
          if (option.unavailable && [value].flat().some((one) => String(one) === option.value))
            problems.push({ field: field.id, message: `${field.title}: ${option.unavailable}` });
    }
    values[field.id] = value;
  }
  return { values, secrets, problems };
}

/**
 * What a unit's answers give, as management works it out for an applied unit: what it always
 * gives, then what each answer adds, of the fields asked, in the form's order.
 */
const addsOf = (unit: TheUnit, values: Record<string, unknown>) => [
  unit.gives,
  ...unit.form
    .filter((field) => shown(field, values))
    .flatMap((field) => {
      const value = values[field.id];
      if (value === undefined) return [];
      return [
        ...(value === true && field.adds ? [field.adds] : []),
        ...(field.options ?? []).flatMap((option) =>
          option.adds && [value].flat().map(String).includes(option.value) ? [option.adds] : [],
        ),
      ];
    }),
];

/** One of each by its id: what is given first stands. */
const once = <T>(all: T[], id: (one: T) => string) =>
  all.filter((one, at) => all.findIndex((other) => id(other) === id(one)) === at);

/** The skills a unit's answers give an agent, each once and with its files. */
export function skillsOf(unit: TheUnit, values: Record<string, unknown>) {
  const names = addsOf(unit, values)
    .flatMap((add) => add.skills ?? [])
    .flatMap((skill) => ("name" in skill ? [skill.name] : []));
  return [...new Set(names)].map((name) => ({ name, files: skillFiles(name) }));
}

/** The live surfaces and the views a unit's answers give the person's capability. */
export function viewsOf(unit: TheUnit, values: Record<string, unknown>) {
  const adds = addsOf(unit, values);
  return {
    surfaces: once(
      adds.flatMap((add) => add.surfaces ?? []),
      (one) => one.surface,
    ),
    views: once(
      adds.flatMap((add) => add.views ?? []),
      (one) => one.id,
    ),
  };
}
