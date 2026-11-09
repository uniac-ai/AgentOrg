// A stack being built, worked out from the form descriptions alone: which fields show, what a unit
// will give, what's still to fill in, and what goes to management. Nothing here calls a unit.
import type { agents } from "@agentorg/interfaces";
import type { z } from "zod";

type Out<M extends { output: z.ZodType }> = z.output<M["output"]>;
type Units = Out<typeof agents.methods.units>;

export type CatalogUnit = Units["units"][number];
export type CatalogBase = Units["bases"][number];
export type Template = Out<typeof agents.methods.templates>["templates"][number];
export type StackProblem = Out<typeof agents.methods.check>["problems"][number];
export type Field = CatalogUnit["form"][number];
type Gives = NonNullable<Field["adds"]>;
type Value = NonNullable<Field["default"]>;
export type Values = Record<string, Value>;
export type Secrets = Record<string, string>;

export interface Catalog {
  bases: CatalogBase[];
  units: CatalogUnit[];
  templates: Template[];
}

export interface DraftUnit {
  key: number;
  /** None when no connected provider offers it now: it can only be removed. */
  unit?: CatalogUnit;
  id: string;
  values: Values;
  secrets: Secrets;
}

export interface Draft {
  mode: "agent" | "template";
  from?: Pick<Template, "id" | "title">;
  name: string;
  purpose: string;
  base?: CatalogBase;
  answers: Record<string, string>;
  units: DraftUnit[];
  problems: StackProblem[];
}

const blank = (value: Value | undefined) =>
  value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

/** What a field holds now: what was filled in, or its default. */
export const fieldValue = (field: Field, values: Values): Value | undefined =>
  values[field.id] ?? field.default;

/** A field that isn't shown has no value. `depth` stops a form whose conditions go in a circle. */
export function isShown(field: Field, form: readonly Field[], values: Values, depth = 0): boolean {
  if (!field.visible) return true;
  const { field: id, in: wanted } = field.visible;
  const other = form.find((f) => f.id === id);
  if (!other || depth > form.length || !isShown(other, form, values, depth + 1)) return false;
  const value = fieldValue(other, values);
  const held = Array.isArray(value) ? value : [value];
  return held.some((v) => wanted.includes(v as Value));
}

/** What the unit will give with these values: what it always gives, and what its answers add. */
export function givesOf(unit: CatalogUnit, values: Values) {
  const slots = new Set<string>();
  const skills = new Set<string>();
  const named = (item: { name: string } | { field: string }) => {
    if ("name" in item) return item.name;
    const field = unit.form.find((f) => f.id === item.field);
    const value =
      field && isShown(field, unit.form, values) ? fieldValue(field, values) : undefined;
    return typeof value === "string" && value ? value : undefined;
  };
  const add = (gives: Gives) => {
    for (const slot of gives.slots) {
      const name = named(slot);
      if (name) slots.add(name);
    }
    for (const skill of gives.skills) {
      const name = named(skill);
      if (name) skills.add(name);
    }
  };
  add(unit.gives);
  for (const field of unit.form) {
    if (!isShown(field, unit.form, values)) continue;
    const value = fieldValue(field, values);
    if (field.adds && value === true) add(field.adds);
    const chosen = Array.isArray(value) ? value : [value];
    for (const option of field.options ?? [])
      if (option.adds && chosen.includes(option.value)) add(option.adds);
  }
  return { slots: [...slots], skills: [...skills] };
}

/** A required field that's shown and still empty. */
export function isUnfilled(field: Field, unit: DraftUnit): boolean {
  if (!field.required || !unit.unit || !isShown(field, unit.unit.form, unit.values)) return false;
  if (field.value === "secret") return !unit.secrets[field.id];
  return blank(fieldValue(field, unit.values));
}

/** The kinds this unit needs that nothing above it gives. */
export const missingNeeds = (unit: DraftUnit, above: readonly DraftUnit[]) =>
  (unit.unit?.needs ?? []).filter(
    (kind) => !above.some((u) => u.unit?.gives.results.includes(kind)),
  );

/** A template or an agent can be finished: a name always, and for an agent everything required. */
export function isReady(draft: Draft): boolean {
  if (!draft.name.trim()) return false;
  if (draft.mode === "template") return !!draft.base;
  if (!draft.base || draft.units.some((u) => !u.unit)) return false;
  const answered = draft.base.asks.every((a) => a.optional || draft.answers[a.id]?.trim());
  return (
    answered &&
    draft.units.every(
      (u, i) =>
        !u.unit?.form.some((f) => isUnfilled(f, u)) &&
        missingNeeds(u, draft.units.slice(0, i)).length === 0,
    )
  );
}

/** Only what's shown and filled in goes; secrets go apart. */
function filled(unit: DraftUnit) {
  const form = unit.unit?.form ?? [];
  const values: Values = {};
  const secrets: Secrets = {};
  for (const field of form) {
    if (!isShown(field, form, unit.values)) continue;
    if (field.value === "secret") {
      const secret = unit.secrets[field.id];
      if (secret) secrets[field.id] = secret;
    } else {
      const value = unit.values[field.id];
      if (value !== undefined && !blank(value)) values[field.id] = value;
    }
  }
  return { values, secrets };
}

const given = (answers: Record<string, string>) =>
  Object.fromEntries(Object.entries(answers).filter(([, value]) => value.trim()));

/** The stack as management takes it. */
export function toStack(draft: Draft) {
  const base = draft.base as CatalogBase;
  const answers = given(draft.answers);
  return {
    base: {
      provider: base.provider,
      creatable: base.id,
      ...(Object.keys(answers).length > 0 ? { answers } : {}),
    },
    units: draft.units.map((u) => {
      const { values, secrets } = filled(u);
      return {
        provider: (u.unit as CatalogUnit).provider,
        unit: u.id,
        values,
        ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
      };
    }),
    ...(draft.from ? { template: draft.from.id } : {}),
  };
}

/** A stack from nothing, or a copy of a template's prefills: all of it can change. */
export function draftFrom(
  template: Template | undefined,
  catalog: Catalog,
  mode: Draft["mode"],
  nextKey: () => number,
): Draft {
  const base = template
    ? catalog.bases.find(
        (b) => b.providerName === template.base.provider && b.id === template.base.creatable,
      )
    : catalog.bases[0];
  return {
    mode,
    ...(template ? { from: { id: template.id, title: template.title } } : {}),
    name: "",
    purpose: mode === "template" ? (template?.description ?? "") : "",
    ...(base ? { base } : {}),
    answers: { ...template?.base.answers },
    units: (template?.units ?? []).map((u) => {
      const unit = catalog.units.find((c) => c.providerName === u.provider && c.id === u.unit);
      return {
        key: nextKey(),
        ...(unit ? { unit } : {}),
        id: u.unit,
        values: { ...u.values },
        secrets: {},
      };
    }),
    problems: [],
  };
}
