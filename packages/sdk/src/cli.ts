#!/usr/bin/env node
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openChannel } from "./client.js";
import { NotConnected, OutcomeUnknown, Refused } from "./errors.js";
import { BuildError, buildPackage } from "./package.js";

const USAGE = `Usage: agentorg <command> [--home DIR]

  build [package-dir]                       build a package into a .agentorg archive
  hub [--port N]                            run a Hub, serving on loopback
  add <file.agentorg>                       hub.packages.add
  actors | bindings | exports | audit       each one's list
  bind <consumer.slot> <provider.export>    hub.grants.bind
  call <slot> <method> [json]               call one of the person's slots

Commands other than build and hub act as the person, with the Hub home's person-credential.
The home is --home, else $AGENTORG_HUB_HOME, else ~/.local/share/agentorg-next.
`;

const write = (stream: NodeJS.WriteStream, text: string) => stream.write(`${text}\n`);
function usage(problem?: string): never {
  if (problem) write(process.stderr, problem);
  process.stderr.write(USAGE);
  process.exit(2);
}

const { values, positionals } = (() => {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      options: {
        home: { type: "string" },
        port: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    });
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }
})();
const [command, ...rest] = positionals;
if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
const home = resolve(
  values.home ??
    process.env.AGENTORG_HUB_HOME ??
    join(homedir(), ".local", "share", "agentorg-next"),
);

/** Each person command: the person's hub slot and method it calls, and its input from the args. */
const commands: Record<string, { slot: string; method: string; input(args: string[]): unknown }> = {
  add: {
    slot: "packages",
    method: "add",
    input: ([file]) => (file ? { path: resolve(file) } : usage("add takes a .agentorg file.")),
  },
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

async function build() {
  try {
    const built = await buildPackage(rest[0] ?? ".");
    write(
      process.stdout,
      `${built.manifest.name}@${built.manifest.version} ${built.hash}\n${relative(process.cwd(), built.file)}`,
    );
  } catch (error) {
    // A BuildError says what to fix; anything else is a bug, so its stack is shown.
    write(
      process.stderr,
      error instanceof BuildError
        ? error.message
        : error instanceof Error
          ? (error.stack ?? error.message)
          : String(error),
    );
    process.exit(1);
  }
}

/** Run a Hub in the home, and leave its address in `<home>/url` for the other commands. */
async function hub() {
  if (values.port !== undefined && !/^\d{1,5}$/.test(values.port))
    usage("--port takes a port number.");
  const port = values.port === undefined ? 0 : Number(values.port);
  if (port > 65535) usage("--port takes a port number.");
  // The Hub is its own package: the SDK doesn't depend on it, so it is loaded only here.
  const name = "@agentorg/hub";
  let loaded: {
    Hub: { open(home: string): { close(): void } };
    listen(
      hub: unknown,
      options: { port: number },
    ): Promise<{ url: string; close(): Promise<void> }>;
  };
  try {
    loaded = await import(name);
  } catch (error) {
    const missing =
      (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND" &&
      String((error as Error).message).includes(name);
    write(
      process.stderr,
      missing
        ? "agentorg hub needs @agentorg/hub installed next to @agentorg/sdk."
        : `@agentorg/hub didn't load: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  let running: { close(): void };
  try {
    running = loaded.Hub.open(home);
  } catch (error) {
    // Another Hub already has the home, or it is from a newer version.
    write(process.stderr, error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const listener = await loaded.listen(running, { port });
  const file = join(home, "url");
  writeFileSync(`${file}.tmp`, `${listener.url}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  chmodSync(file, 0o600);
  write(process.stdout, `Hub at ${listener.url}, home ${home}`);
  const stop = async () => {
    // Gone with the Hub, so no command tries an address nothing serves (if it is still ours).
    try {
      if (readFileSync(file, "utf8").trim() === listener.url) rmSync(file);
    } catch {
      // Already gone.
    }
    await listener.close();
    running.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

/** Act as the person: one call through one of its hub slots, its result printed as JSON. */
async function asPerson(slot: string, method: string, input: unknown) {
  const read = (file: string, what: string) => {
    try {
      return readFileSync(join(home, file), "utf8").trim();
    } catch {
      write(process.stderr, `No ${what} in ${home}. Is a Hub running there (agentorg hub)?`);
      process.exit(1);
    }
  };
  const hubUrl = read("url", "Hub address");
  const credential = read("person-credential", "person credential");
  try {
    // Never take over: a channel the person already has (the shell, at step 4) stays. Another
    // agentorg command holds it only briefly, so a refusal is retried for a moment first.
    let channel: Awaited<ReturnType<typeof openChannel>> | undefined;
    for (let wait = 50; !channel; wait *= 2)
      try {
        channel = await openChannel({ hubUrl, actorId: "person", credential, replace: false });
      } catch (error) {
        if (!(error instanceof Refused && error.code === "connected") || wait > 1600) throw error;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    try {
      write(process.stdout, JSON.stringify(await channel.call(slot, method, input), null, 2));
    } finally {
      channel.close();
    }
  } catch (error) {
    if (error instanceof Refused && error.code === "connected")
      write(
        process.stderr,
        "Something else holds the person's channel to this Hub (another program, or an agentorg command still running), so this command won't take it over. Run it again once that one is done.",
      );
    else if (error instanceof Refused)
      write(process.stderr, `Refused (${error.code}): ${error.message}`);
    else if (error instanceof NotConnected || error instanceof OutcomeUnknown)
      write(process.stderr, `${error.name}: ${error.message}`);
    else throw error;
    process.exit(1);
  }
}

if (command === "build") await build();
else if (command === "hub") await hub();
else if (command === "call") {
  const [slot, method, json = "{}"] = rest;
  if (!slot || !method) usage("call takes <slot> <method> [json].");
  let input: unknown;
  try {
    input = JSON.parse(json);
  } catch {
    usage("call's input must be JSON.");
  }
  await asPerson(slot, method, input);
} else if (command && Object.hasOwn(commands, command)) {
  const { slot, method, input } = commands[command] as (typeof commands)[string];
  await asPerson(slot, method, input(rest));
} else usage(command ? `Unknown command ${JSON.stringify(command)}.` : undefined);
