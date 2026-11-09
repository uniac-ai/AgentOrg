import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * The Hub home a command uses: `--home`, else `$AGENTORG_HUB_HOME`, else `agentorg` in the XDG
 * data folder: `$XDG_DATA_HOME` when it is an absolute path (a relative one is ignored, as the
 * XDG spec says), else `~/.local/share`. An empty value counts as unset.
 */
export function hubHome(
  flag: string | undefined,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  if (flag) return resolve(flag);
  if (env.AGENTORG_HUB_HOME) return resolve(env.AGENTORG_HUB_HOME);
  const data = env.XDG_DATA_HOME;
  return join(data && isAbsolute(data) ? data : join(home, ".local", "share"), "agentorg");
}

/** A command's arguments don't fit it; the message says how. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}
function usage(message: string): never {
  throw new UsageError(message);
}

/** Each person command: the person's hub slot and method it calls, and its input from the args. */
const commands: Record<string, { slot: string; method: string; input(args: string[]): unknown }> = {
  actors: { slot: "actors", method: "list", input: () => ({}) },
  bindings: { slot: "bindings", method: "list", input: () => ({}) },
  exports: { slot: "exports", method: "list", input: () => ({}) },
  audit: { slot: "audit", method: "list", input: () => ({}) },
  bind: {
    slot: "grants",
    method: "bind",
    input([from, to]) {
      // Actor ids have no dots, so the first dot ends the Actor; a package's slot keeps the rest.
      const end = (arg: string | undefined, what: string) => {
        const dot = arg?.indexOf(".") ?? -1;
        if (!arg || dot < 1 || dot === arg.length - 1) usage(`bind takes ${what} as actor.name.`);
        return [arg.slice(0, dot), arg.slice(dot + 1)] as const;
      };
      const [consumer, slot] = end(from, "<consumer.slot>");
      const [provider, exported] = end(to, "<provider.export>");
      return { consumer, slot, provider, export: exported };
    },
  },
};

/**
 * A command that acts as the person, as one call: the person's slot and method, and the input its
 * arguments give. `undefined` for any other command; a `UsageError` when the arguments don't fit.
 */
export function personCall(
  command: string,
  args: string[],
): { slot: string; method: string; input: unknown } | undefined {
  if (command === "call") {
    const [slot, method, json = "{}"] = args;
    if (!slot || !method) usage("call takes <slot> <method> [json].");
    let input: unknown;
    try {
      input = JSON.parse(json);
    } catch {
      usage("call's input must be JSON.");
    }
    return { slot: slot as string, method: method as string, input };
  }
  if (!Object.hasOwn(commands, command)) return undefined;
  const { slot, method, input } = commands[command] as (typeof commands)[string];
  return { slot, method, input: input(args) };
}
