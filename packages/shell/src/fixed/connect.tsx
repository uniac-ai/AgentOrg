// The form for a new connection: each kind's fields come from its own JSON Schemas.
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { api, useLoad } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog.tsx";
import { Field, FieldGroup, FieldLabel } from "../ui/field.tsx";
import { Input } from "../ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { listMcpProviders, type McpProvider, useAct } from "./data.ts";
import { Nothing } from "./parts.tsx";

type Kind = McpProvider["kinds"][number];
interface Property {
  type?: string;
  title?: string;
  items?: { type?: string };
}
interface Schema {
  properties?: Record<string, Property>;
  required?: string[];
  additionalProperties?: unknown;
}

/** A schema's name for a field: its title, or its key as people write it. */
const labelOf = (key: string, property: Property) =>
  property.title ??
  (key.length <= 3 ? key.toUpperCase() : `${key.charAt(0).toUpperCase()}${key.slice(1)}`);
const isList = (property: Property) => property.type === "array";

export function ConnectDialog({
  open,
  onClose,
  onConnected,
}: {
  open: boolean;
  onClose(): void;
  onConnected(): void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="window flex h-[min(460px,88vh)] flex-col ring-0 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect an MCP</DialogTitle>
        </DialogHeader>
        {/* Mounted only while open: what was typed, a secret above all, goes with it. */}
        {open && <Form onConnected={onConnected} />}
      </DialogContent>
    </Dialog>
  );
}

function Form({ onConnected }: { onConnected(): void }) {
  const providers = useLoad(listMcpProviders, ["actors"]);
  const kinds = (providers.value ?? []).flatMap((provider) =>
    provider.kinds.map((kind) => ({ provider: provider.provider, kind })),
  );
  const [picked, setPicked] = useState<string>();
  const choice = kinds.find((k) => key(k) === picked) ?? kinds[0];
  if (!choice)
    return providers.loaded ? (
      <Nothing>{providers.error ? "This can't be read right now." : "No MCP providers."}</Nothing>
    ) : null;
  return (
    <KindForm
      key={key(choice)}
      provider={choice.provider}
      kind={choice.kind}
      choices={kinds}
      picked={key(choice)}
      onPick={setPicked}
      onConnected={onConnected}
    />
  );
}

const key = (k: { provider: string; kind: Kind }) => `${k.provider}/${k.kind.kind}`;

function KindForm({
  provider,
  kind,
  choices,
  picked,
  onPick,
  onConnected,
}: {
  provider: string;
  kind: Kind;
  choices: { provider: string; kind: Kind }[];
  picked: string;
  onPick(key: string): void;
  onConnected(): void;
}) {
  const params = kind.params as Schema;
  const secrets = kind.secrets as Schema;
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [hidden, setHidden] = useState<Record<string, string>>({});
  /** Secrets a server takes by a name the person gives, when its kind leaves the names open. */
  const [named, setNamed] = useState<{ name: string; value: string }[]>([]);
  const act = useAct();

  const fields = Object.entries(params.properties ?? {});
  const secretFields = Object.entries(secrets.properties ?? {});
  const openSecrets = !secrets.properties && secrets.additionalProperties !== undefined;
  const ready =
    name.trim() !== "" &&
    (params.required ?? []).every((field) => values[field]?.trim()) &&
    named.every((one) => one.name.trim() && one.value);

  const submit = () => {
    if (!ready) return;
    const given = Object.fromEntries(
      fields.flatMap(([field, property]) => {
        const value = values[field]?.trim();
        if (!value) return [];
        return [
          [
            field,
            isList(property)
              ? value
                  .split("\n")
                  .map((v) => v.trim())
                  .filter(Boolean)
              : value,
          ],
        ];
      }),
    );
    const secret = {
      ...Object.fromEntries(Object.entries(hidden).filter(([, value]) => value)),
      ...Object.fromEntries(named.map((one) => [one.name.trim(), one.value])),
    };
    act.run(
      () =>
        api.call("connections", "create", {
          provider,
          kind: kind.kind,
          params: given,
          name: name.trim(),
          ...(Object.keys(secret).length > 0 ? { secrets: secret } : {}),
        }),
      onConnected,
    );
  };

  return (
    <form
      className="flex min-h-0 flex-1 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {/* Room around the fields, inside what scrolls, for the ring of the one that has the keyboard. */}
      <div className="no-bar -m-1 min-h-0 flex-1 overflow-y-auto p-1">
        <FieldGroup className="gap-4">
          {choices.length > 1 && (
            <Select value={picked} onValueChange={onPick}>
              <SelectTrigger aria-label="Kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choices.map((choice) => (
                  <SelectItem key={key(choice)} value={key(choice)}>
                    {choice.kind.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Field>
            <FieldLabel htmlFor="connect-name">Name</FieldLabel>
            <Input id="connect-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {fields.map(([field, property]) => (
            <Field key={field}>
              <FieldLabel htmlFor={`connect-${field}`}>{labelOf(field, property)}</FieldLabel>
              {isList(property) ? (
                <Textarea
                  id={`connect-${field}`}
                  placeholder="One per line"
                  className="font-mono text-xs"
                  value={values[field] ?? ""}
                  onChange={(e) => setValues({ ...values, [field]: e.target.value })}
                />
              ) : (
                <Input
                  id={`connect-${field}`}
                  className="font-mono text-xs"
                  value={values[field] ?? ""}
                  onChange={(e) => setValues({ ...values, [field]: e.target.value })}
                />
              )}
            </Field>
          ))}
          {secretFields.map(([field, property]) => (
            <Field key={field}>
              <FieldLabel htmlFor={`connect-secret-${field}`}>
                {labelOf(field, property)}
              </FieldLabel>
              <Input
                id={`connect-secret-${field}`}
                type="password"
                autoComplete="off"
                value={hidden[field] ?? ""}
                onChange={(e) => setHidden({ ...hidden, [field]: e.target.value })}
              />
            </Field>
          ))}
          {openSecrets && (
            <Field>
              <div className="flex items-center justify-between">
                <FieldLabel>Secrets</FieldLabel>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Add a secret"
                  onClick={() => setNamed([...named, { name: "", value: "" }])}
                >
                  <PlusIcon />
                </Button>
              </div>
              {named.map((one, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity but their place.
                <div key={i} className="flex items-center gap-2">
                  <Input
                    aria-label="Secret name"
                    placeholder="NAME"
                    className="font-mono text-xs"
                    value={one.name}
                    onChange={(e) =>
                      setNamed(
                        named.map((n, at) => (at === i ? { ...n, name: e.target.value } : n)),
                      )
                    }
                  />
                  <Input
                    aria-label="Secret value"
                    type="password"
                    autoComplete="off"
                    value={one.value}
                    onChange={(e) =>
                      setNamed(
                        named.map((n, at) => (at === i ? { ...n, value: e.target.value } : n)),
                      )
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Remove this secret"
                    onClick={() => setNamed(named.filter((_, at) => at !== i))}
                  >
                    <XIcon />
                  </Button>
                </div>
              ))}
            </Field>
          )}
        </FieldGroup>
      </div>
      <DialogFooter className="sm:items-center">
        {act.failed && (
          <p role="alert" className="mr-auto min-w-0 text-[13px] text-[var(--bad)]">
            {act.failed}
          </p>
        )}
        <Button type="submit" disabled={!ready || act.busy}>
          Connect
        </Button>
      </DialogFooter>
    </form>
  );
}
