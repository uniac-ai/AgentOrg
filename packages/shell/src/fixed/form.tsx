// One field of a unit's form, drawn from its description. A type this host doesn't know gets the
// plain control for the kind of value it holds.
import { useLoad } from "../data.ts";
import { Checkbox } from "../ui/checkbox.tsx";
import { Field as FieldBox, FieldDescription, FieldError, FieldLabel } from "../ui/field.tsx";
import { Input } from "../ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import { Switch } from "../ui/switch.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { type ConnectionEntry, listConnections } from "./data.ts";
import { Jump } from "./parts.tsx";
import type { Field, Values } from "./stack.ts";
import { fieldValue, placeholderOf } from "./stack.ts";

type Value = Values[string];
const PLAIN: Record<string, string> = {
  string: "text",
  number: "number",
  boolean: "toggle",
  strings: "lines",
  secret: "secret",
};
const KNOWN = new Set(["text", "number", "toggle", "choice", "choices", "directory", "connection"]);

function controlOf(field: Field): string {
  if (field.value === "secret") return "secret";
  if ((field.type === "choice" || field.type === "choices") && !field.options?.length)
    return PLAIN[field.value] as string;
  return KNOWN.has(field.type) ? field.type : (PLAIN[field.value] as string);
}

interface Option {
  value: string;
  title: string;
}

function OneOf({
  id,
  hint,
  field,
  options,
  value,
  onChange,
}: {
  id: string;
  hint?: string | undefined;
  field: Field;
  options: Option[];
  value: string;
  onChange(value: string): void;
}) {
  const chosen = options.find((o) => o.value === value);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} aria-label={field.title} className="w-full">
        <SelectValue placeholder={hint ?? "Choose"}>{chosen?.title}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SomeOf({
  id,
  field,
  options,
  value,
  onChange,
}: {
  id: string;
  field: Field;
  options: Option[];
  value: readonly string[];
  onChange(value: string[]): void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of checkboxes with one name.
    <div role="group" aria-label={field.title} className="flex flex-col gap-1.5">
      {options.map((o) => (
        <label
          key={o.value}
          htmlFor={`${id}-${o.value}`}
          className="flex items-center gap-2 text-sm"
        >
          <Checkbox
            id={`${id}-${o.value}`}
            checked={value.includes(o.value)}
            onCheckedChange={(on) =>
              onChange(on ? [...value, o.value] : value.filter((v) => v !== o.value))
            }
          />
          {o.title}
        </label>
      ))}
    </div>
  );
}

/** A connection the person made can be chosen; one made for an agent goes with that agent. */
function ConnectionField({
  id,
  field,
  value,
  onChange,
}: {
  id: string;
  field: Field;
  value: Value | undefined;
  onChange(value: Value): void;
}) {
  const list = useLoad<ConnectionEntry[]>(listConnections, ["actors"]);
  const options = (list.value ?? [])
    .filter((c) => !c.origin?.madeFor)
    .map((c) => ({ value: c.connection, title: c.name }));
  if (list.loaded && options.length === 0)
    return (
      <FieldDescription>
        <Jump to={{ screen: "mcps", adding: true }}>Connect an MCP first</Jump>
      </FieldDescription>
    );
  return field.value === "strings" ? (
    <SomeOf
      id={id}
      field={field}
      options={options}
      value={Array.isArray(value) ? value : []}
      onChange={onChange}
    />
  ) : (
    <OneOf
      id={id}
      field={field}
      options={options}
      value={typeof value === "string" ? value : ""}
      onChange={onChange}
    />
  );
}

export function FormField({
  id,
  agentName,
  field,
  values,
  secret,
  problem,
  onChange,
  onSecret,
}: {
  id: string;
  /** What `{name}` in a field's greyed text stands for. */
  agentName?: string | undefined;
  field: Field;
  values: Values;
  secret: string;
  problem?: string;
  onChange(value: Value): void;
  onSecret(value: string): void;
}) {
  const control = controlOf(field);
  const hint = placeholderOf(field, agentName);
  const value = fieldValue(field, values);
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const list = Array.isArray(value) ? value : [];
  // What the chosen answer means stays under it: as a caution where its unit marks it as one.
  const chosen = field.options?.find((o) => o.value === value);
  const notes = (
    <>
      {chosen?.description && (
        <p className={`text-xs ${chosen.caution ? "text-[var(--warn)]" : "text-muted-foreground"}`}>
          {chosen.description}
        </p>
      )}
      {problem && <FieldError className="text-xs">{problem}</FieldError>}
    </>
  );
  if (control === "toggle")
    return (
      <FieldBox className="gap-1.5">
        <div className="flex items-center gap-1.5">
          <FieldLabel htmlFor={id} className="w-fit text-xs">
            {field.title}
          </FieldLabel>
          <span className="flex-1" />
          <Switch id={id} checked={value === true} onCheckedChange={onChange} />
        </div>
        {notes}
      </FieldBox>
    );
  const number = (
    <Input
      id={id}
      type="number"
      placeholder={hint}
      min={field.min}
      max={field.max}
      step={field.step}
      value={text}
      onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
    />
  );
  return (
    <FieldBox className="gap-1.5">
      <FieldLabel htmlFor={id} className="text-xs">
        {field.title}
      </FieldLabel>
      {control === "choice" && (
        <OneOf
          id={id}
          hint={hint}
          field={field}
          options={field.options ?? []}
          value={text}
          onChange={onChange}
        />
      )}
      {control === "choices" && (
        <SomeOf
          id={id}
          field={field}
          options={field.options ?? []}
          value={list}
          onChange={onChange}
        />
      )}
      {control === "connection" && (
        <ConnectionField id={id} field={field} value={value} onChange={onChange} />
      )}
      {control === "lines" && (
        <Textarea
          id={id}
          placeholder={hint}
          value={list.join("\n")}
          onChange={(e) => onChange(e.target.value.split("\n"))}
        />
      )}
      {control === "number" && !field.unit && number}
      {control === "number" && field.unit && (
        <div className="flex items-center gap-2">
          {number}
          <span className="text-xs text-muted-foreground">{field.unit}</span>
        </div>
      )}
      {control === "secret" && (
        <Input
          id={id}
          type="password"
          placeholder={hint}
          autoComplete="off"
          value={secret}
          onChange={(e) => onSecret(e.target.value)}
        />
      )}
      {(control === "text" || control === "directory") && (
        <Input
          id={id}
          spellCheck={false}
          placeholder={hint}
          className={control === "directory" ? "font-mono text-xs" : ""}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {notes}
    </FieldBox>
  );
}
