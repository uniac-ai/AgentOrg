// One field of a unit's form, drawn from its description. A type this host doesn't know gets the
// plain control for the kind of value it holds.
import { FolderOpenIcon, InfoIcon } from "lucide-react";
import { useState } from "react";
import { useLoad } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { Checkbox } from "../ui/checkbox.tsx";
import { Field as FieldBox, FieldDescription, FieldError, FieldLabel } from "../ui/field.tsx";
import { Input } from "../ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import { Switch } from "../ui/switch.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { Tip } from "./controls.tsx";
import { type ConnectionEntry, listConnections } from "./data.ts";
import { FolderPicker } from "./folder-picker.tsx";
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
  description?: string;
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
            <span className="flex flex-col">
              <span>{o.title}</span>
              {o.description && (
                <span className="max-w-72 text-xs text-muted-foreground">{o.description}</span>
              )}
            </span>
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
  const [browsing, setBrowsing] = useState(false);
  const value = fieldValue(field, values);
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const list = Array.isArray(value) ? value : [];
  // What the chosen answer means is always there; what the field is, on asking.
  const says = field.options?.find((o) => o.value === value)?.description;
  const about = field.description && (
    <Tip label={field.description}>
      <button
        type="button"
        aria-label={`About ${field.title}`}
        className="text-muted-foreground hover:text-foreground"
      >
        <InfoIcon className="size-3" />
      </button>
    </Tip>
  );
  const notes = (
    <>
      {says && <FieldDescription className="text-xs">{says}</FieldDescription>}
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
          {about}
          <span className="flex-1" />
          <Switch id={id} checked={value === true} onCheckedChange={onChange} />
        </div>
        {notes}
      </FieldBox>
    );
  return (
    <FieldBox className="gap-1.5">
      <div className="flex items-center gap-1.5">
        <FieldLabel htmlFor={id} className="w-fit text-xs">
          {field.title}
        </FieldLabel>
        {about}
      </div>
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
      {control === "number" && (
        <div className="flex items-center gap-2">
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
          {field.unit && <span className="text-xs text-muted-foreground">{field.unit}</span>}
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
        <div className="flex items-center gap-1">
          <Input
            id={id}
            spellCheck={false}
            placeholder={hint}
            className={control === "directory" ? "font-mono text-xs" : ""}
            value={text}
            onChange={(e) => onChange(e.target.value)}
          />
          {control === "directory" && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Browse for ${field.title}`}
              onClick={() => setBrowsing(true)}
            >
              <FolderOpenIcon />
            </Button>
          )}
        </div>
      )}
      {browsing && (
        <FolderPicker
          title={field.title}
          {...(text.startsWith("/") ? { start: text } : {})}
          onClose={() => setBrowsing(false)}
          onPick={(path) => {
            onChange(path);
            setBrowsing(false);
          }}
        />
      )}
      {notes}
    </FieldBox>
  );
}
