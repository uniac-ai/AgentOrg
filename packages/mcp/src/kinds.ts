import { z } from "zod";

const SecretValue = z.string().min(1).max(16_384);
const EnvName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .max(256);

const UrlParams = z.strictObject({
  url: z
    .url({ protocol: /^https?$/ })
    .max(4096)
    .refine((url) => {
      const { username, password } = new URL(url);
      return !username && !password;
    }, "An address can't hold a user or a password: give a token as a secret."),
});
/** The bearer token sent to the server on every request. */
const UrlSecrets = z.strictObject({ token: SecretValue.optional() });
const CommandParams = z.strictObject({
  command: z.string().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(256).optional(),
  cwd: z.string().min(1).max(4096).optional(),
});
/** Each one is an environment variable of the server, by its name. */
const CommandSecrets = z.record(EnvName, SecretValue);

export type Spec =
  | ({ kind: "url" } & z.infer<typeof UrlParams>)
  | ({ kind: "command" } & z.infer<typeof CommandParams>);
export type Secrets = Record<string, string>;

export const KINDS = [
  { kind: "url", title: "A server at an address", params: UrlParams, secrets: UrlSecrets },
  {
    kind: "command",
    title: "A local server this machine starts",
    params: CommandParams,
    secrets: CommandSecrets,
  },
] as const;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** What a connection's parameters and secrets say, or why they don't fit its kind. */
export function parseConnection(
  kind: string,
  params: unknown,
  secrets: unknown,
):
  | { spec: Spec; secrets: Secrets; why?: undefined }
  | { spec?: undefined; secrets?: undefined; why: string } {
  const found = KINDS.find((k) => k.kind === kind);
  if (!found) return { why: `No kind is named ${kind}: this provider offers url and command.` };
  const parsed = found.params.safeParse(params);
  if (!parsed.success) return { why: `${kind}: ${z.prettifyError(parsed.error)}` };
  const hidden = found.secrets.safeParse(secrets ?? {});
  // Named by what's wrong with their shape only: a refusal never repeats a value.
  if (!hidden.success) return { why: `${kind}: its secrets don't fit: ${found.title}.` };
  const spec = { kind, ...parsed.data } as Spec;
  if (spec.kind === "url" && "token" in hidden.data) {
    const url = new URL(spec.url);
    if (url.protocol === "http:" && !LOOPBACK.has(url.hostname))
      return { why: "A token is sent only over https, or to this machine." };
  }
  return { spec, secrets: hidden.data as Secrets };
}

/**
 * What a connection attaches to or runs, for people to read. An address loses its query, which is
 * where a secret would be.
 */
export function targetOf(spec: Spec): string {
  if (spec.kind === "url") {
    const url = new URL(spec.url);
    url.search = "";
    url.hash = "";
    return url.href.slice(0, 4096);
  }
  const line = [spec.command, ...(spec.args ?? [])].join(" ");
  return (spec.cwd ? `${line} (in ${spec.cwd})` : line).slice(0, 4096);
}
