import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Channel, openChannel, type Serve, type ServeHandlers } from "./client.js";
import type { Manifest } from "./manifest.js";
import { type Duplex, isModuleDefinition, type Log } from "./module.js";
import { localServe, ModuleHost, noModule } from "./module-host.js";
import { createRuntime } from "./runtime.js";

export interface RunHostOptions {
  /** The package's folder: `agentorg.json` and `dist/<module>.js`. */
  packageDir: string;
  /** The Actor this process runs, as the Hub named it. */
  actorId: string;
  /** The pipe to the Hub. */
  channel: Duplex;
  /** Where each module's `ctx.log` lines go, and (with no module) the runner's own. */
  log(module?: string): Log;
}

export interface Host {
  readonly channel: Channel;
  /** The host modules running, by name. */
  readonly modules: readonly string[];
}

/**
 * Run a package Actor's host modules over the pipe the Hub made for its process. Each module gets
 * its own runtime, the same one `connect()` and the test context use, with its slots and exports
 * named `<module>.<name>` on the wire. Every module's `start` runs before the hello, so the Hub
 * never reaches an export before it is implemented; then slots are bound as the Hub says, and each
 * `serve` stream goes to the module its export names. A `start` that throws is thrown from here.
 */
export async function runHost(options: RunHostOptions): Promise<Host> {
  const manifest = JSON.parse(
    await readFile(join(options.packageDir, "agentorg.json"), "utf8"),
  ) as Manifest;
  const hosts = new Map<string, ModuleHost>();
  for (const [name, module] of Object.entries(manifest.modules)) {
    if (module.placement !== "host") continue;
    const loaded = (await import(
      pathToFileURL(join(options.packageDir, "dist", `${name}.js`)).href
    )) as { default?: unknown };
    const definition = loaded.default;
    if (!isModuleDefinition(definition))
      throw new Error(`dist/${name}.js doesn't export a module definition.`);
    const log = options.log(name);
    const host = new ModuleHost(`${name}.`, definition.slots, log);
    host.runtime = createRuntime(definition, {
      self: { actorId: options.actorId, module: name },
      log,
      ...host.hooks(),
    }) as unknown as ModuleHost["runtime"];
    hosts.set(name, host);
  }
  // Every module's start, in the manifest's order, before the Hub can reach any of them.
  for (const host of hosts.values()) await host.runtime.start();

  /** The module a wire name belongs to, and the name within it. */
  const route = (name: string): [ModuleHost, string] | undefined => {
    const dot = name.indexOf(".");
    const host = dot > 0 ? hosts.get(name.slice(0, dot)) : undefined;
    return host && [host, name.slice(dot + 1)];
  };
  const routed = (serve: Serve): [ServeHandlers, Serve] => {
    const found = route(serve.export);
    if (!found) throw noModule(serve.export);
    return [found[0].serve, localServe(serve, found[1])];
  };
  const channel = await openChannel({
    channel: options.channel,
    actorId: options.actorId,
    log: options.log(),
    onSlot(name, bound) {
      const found = route(name);
      found?.[0].onSlot(found[1], bound);
    },
    // A slot made at run time is the Actor's: every host module has it.
    onExposed(name, exposure) {
      for (const host of hosts.values()) host.onExposed(name, exposure);
    },
    serve: {
      call: (serve, value) => {
        const [handlers, local] = routed(serve);
        return handlers.call(local, value);
      },
      subscribe: (serve, send, end) => {
        const [handlers, local] = routed(serve);
        return handlers.subscribe(local, send, end);
      },
      accept: (serve) => {
        const [handlers, local] = routed(serve);
        return handlers.accept(local);
      },
      serveHttp: (serve) => {
        const [handlers, local] = routed(serve);
        return handlers.serveHttp(local);
      },
    },
  });
  for (const host of hosts.values()) host.attach(channel);
  return { channel, modules: [...hosts.keys()] };
}
