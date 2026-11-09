/** One field of a unit's form, as far as the reader needs it. */
interface FormField {
  id: string;
  value: "string" | "number" | "boolean" | "strings" | "secret";
}
type Value = string | number | boolean | string[];

/**
 * What a unit's logic reads of what was filled in, by field id, one method per value kind. It has
 * already been settled: checked against the form, defaults applied, a field not shown absent. The
 * logic can't tell who filled it. Asking for a field the form doesn't have, or as the wrong kind,
 * throws at once: that is a mistake in the unit, not in what was filled.
 */
export function filled(
  form: readonly FormField[],
  values: Readonly<Record<string, Value>>,
  secrets: Readonly<Record<string, string>> = {},
) {
  const read = <T extends Value>(id: string, kind: FormField["value"]) => {
    const field = form.find((one) => one.id === id);
    if (!field) throw new TypeError(`This unit's form has no field ${id}.`);
    if (field.value !== kind) throw new TypeError(`${id} holds a ${field.value}, not a ${kind}.`);
    return (kind === "secret" ? secrets[id] : values[id]) as T | undefined;
  };
  return {
    string: (id: string) => read<string>(id, "string"),
    number: (id: string) => read<number>(id, "number"),
    boolean: (id: string) => read<boolean>(id, "boolean"),
    strings: (id: string) => read<string[]>(id, "strings"),
    /** Read the same way, and kept apart: only `apply` has them. */
    secret: (id: string) => read<string>(id, "secret"),
  };
}
