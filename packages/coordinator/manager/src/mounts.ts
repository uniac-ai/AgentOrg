/**
 * Capabilities mounted on agents through management: each made by a connected capability provider,
 * kept in the agent's record with its arguments, and taken off through the same provider.
 *
 * Management keeps the record. Whoever is bound to `agents@1` mounts and unmounts, the person or
 * another program; an agent mounts through its control's tools, on itself and the agents it made.
 *
 * A capability mounted from the agent's own executor is held by that executor through the tree it
 * is given (`treeOf`), so it is kept, and the agent's provider given the tree and answered, before
 * the capability's provider is asked: the agent holds it by then. If the provider doesn't make it,
 * the record goes back as it was, and the agent is given that.
 *
 * The tree's other roots aren't mounted here, so none is mounted or unmounted through this:
 * `instructions` and `skills` are management's own, and the rest came with a unit.
 *
 * A `secret` argument goes to the provider's `mount` and nowhere else: it isn't kept, and a refusal
 * or a problem that echoes it says "…" in its place. So a capability with one isn't mounted again
 * with it when its agent starts; how it is, is for the step that rebuilds how agents are made.
 */
import type { capabilityProvider, HeldCapability, Template2 } from "@agentorg/interfaces";
import { type Log, NotConnected, Refused, type Slot } from "@agentorg/sdk";
import type { z } from "zod";
import { CONTROL_ROOT, holdsControl, OWN_ROOTS, unitControls } from "./settings.js";
import type { AgentRecord, MountRecord } from "./stack.js";

type Provider = Slot<typeof capabilityProvider>["call"];
type Made = Awaited<ReturnType<Provider["mount"]>>;
type TheAgent = z.infer<typeof AgentRecord>;
type Root = z.infer<typeof MountRecord>;
type Held = z.infer<typeof HeldCapability>;
/** How a mount stands, as its provider says it. */
type Stood = { state: Held["state"]; detail?: string };
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
type Json = Root["arguments"][string];
type TheTemplate = z.infer<typeof Template2>;
type Problem = { path?: string; message: string };
type Mounting = { mounted: string } | { problems: Problem[] };
interface Input {
  agent: string;
  provider: string;
  capability: string;
  arguments: Record<string, Json>;
}

export interface MountParts {
  /** Management's own id. */
  self: string;
  records: { agents: Record<string, TheAgent> };
  save(): void;
  log: Log;
  recordOf(agent: string): TheAgent;
  /** One change to an agent at a time. */
  serial<T>(agent: string, work: () => T | Promise<T>): Promise<T>;
  /** The capability providers exposed to management now. */
  providers(): { actor: string; call: Provider }[];
  /** What is mounted on the agent changed: give its provider its list. Settles once answered. */
  changed(agent: string): Promise<void>;
  /** Give the agent's provider its list, with no word to the agent: settles once answered. */
  give(agent: string): Promise<void>;
  /** Have an agent that holds control no more reach management's tools, or other agents, by it. */
  unreachControl(agent: string): Promise<void>;
  /** Wire what a provider made for a mount, all or none; what it wired is kept on the mount. */
  wire(
    agent: string,
    record: TheAgent,
    root: Root,
    made: NonNullable<Extract<Made, { mounted: string }>["made"]>,
    skillOf: (name: string, path: string) => Promise<string>,
  ): Promise<NonNullable<Root["made"]>>;
  /** Take off what was wired of a mount. */
  unwire(agent: string, record: TheAgent, root: Root): Promise<void>;
  /**
   * Control's arguments, settled as its control unit's answers are, and what is wrong with them;
   * given by an agent, held to its own control.
   */
  settleControl(
    record: TheAgent,
    given: Record<string, Json>,
    by: string,
  ): Promise<{ values: Record<string, unknown>; problems: { field?: string; message: string }[] }>;
  /** Give the agent what mounted control gives, as its control unit does; what it gave is kept. */
  wireControl(agent: string, record: TheAgent): Promise<NonNullable<Root["made"]>>;
  /** A capability provider's name on the Hub. */
  nameOf(actor: string): Promise<string>;
}

/** A problem with a field of a form, at its path among the arguments. */
const atPath = ({ field, message }: { field?: string; message: string }): Problem => ({
  ...(field ? { path: `/${field}` } : {}),
  message,
});
const isObject = (value: unknown): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Each capability a template lists by its key: its capability's id, with `-2`, `-3` and on for a
 * repeat.
 */
export const keysOf = (template: TheTemplate) => {
  const seen = new Map<string, number>();
  return template.capabilities.map(({ capability }) => {
    const count = (seen.get(capability) ?? 0) + 1;
    seen.set(capability, count);
    return count === 1 ? capability : `${capability}-${count}`;
  });
};

const alreadyGone = (error: unknown) => error instanceof Refused && error.code === "unknown";
const ownRoot = (name: string) =>
  new Refused("forbidden", `${name} is management's own: it is never mounted or unmounted.`);

/** The top-level properties the schema marks `secret`. */
const secretsOf = (schema: Record<string, Json>) => {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  return Object.entries(properties).flatMap(([name, property]) =>
    property && typeof property === "object" && !Array.isArray(property) && property.secret === true
      ? [name]
      : [],
  );
};

/** Each string a secret argument holds, to be said as "…" wherever it is echoed. */
const valuesOf = (given: Record<string, Json>, secrets: string[]) =>
  secrets.flatMap((name) => {
    const value = given[name];
    return typeof value === "string" && value.length > 0 ? [value] : [];
  });
const redact = (text: string, values: string[]) =>
  values.reduce((said, value) => said.split(value).join("…"), text);
const redacted = (error: unknown, values: string[]) => {
  if (values.length === 0) return error;
  if (error instanceof Refused) return new Refused(error.code, redact(error.message, values));
  return new Error(redact(error instanceof Error ? error.message : String(error), values));
};

/** Every capability mounted under `name` in the agent's own list, at any depth. */
const under = (held: Held[], name: string) => {
  const found: Held[] = [];
  const parents = new Set([name]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const one of held)
      if (one.parent && parents.has(one.parent) && !parents.has(one.name)) {
        parents.add(one.name);
        found.push(one);
        grew = true;
      }
  }
  return held.filter((one) => found.includes(one));
};

export function createMounts(parts: MountParts) {
  const { self, save, log, recordOf, serial, changed } = parts;
  /** Whether a root of the agent's tree came with a unit: its control, or a plugin of one. */
  const fromUnit = (record: TheAgent, mounted: string) =>
    mounted === CONTROL_ROOT
      ? unitControls(record, self)
      : record.capabilities.some(({ plugins = [] }) =>
          plugins.some((plugin) => plugin.name === mounted),
        );
  const providerOf = (actor: string) => parts.providers().find((one) => one.actor === actor);
  /** Take a root off through its provider; one the provider no longer has is gone already. */
  const takeOff = async (agent: string, root: Root) => {
    if (!root.providerMounted) return;
    const provider = providerOf(root.provider);
    if (!provider) throw new Refused("not_connected", "Its provider can't be reached now.");
    try {
      await provider.call.unmount({ agent, mounted: root.providerMounted });
    } catch (error) {
      if (!alreadyGone(error)) throw error;
    }
  };

  /** Mount a capability through its provider, in the agent's queue: as a template's, with `parent`. */
  const mountOne = async (input: Input, by: string, parent?: string): Promise<Mounting> => {
    const { agent, capability } = input;
    const record = recordOf(agent);
    if (OWN_ROOTS.includes(capability)) throw ownRoot(capability);
    const provider = providerOf(input.provider);
    if (!provider)
      throw new Refused("unknown", `${input.provider} isn't a connected capability provider.`);
    const defined = (await provider.call.capabilities({})).capabilities.find(
      (one) => one.id === capability,
    );
    if (!defined)
      throw new Refused("unknown", `${input.provider} offers no capability ${capability}.`);
    // Held once, whether it was mounted or built by a unit, unless it may be held many times.
    if (
      !defined.many &&
      (record.mounted.some((one) => one.capability === capability) ||
        record.capabilities.some((one) => one.id === capability) ||
        (capability === CONTROL_ROOT && unitControls(record, self)))
    )
      throw new Refused("state", `It holds a ${defined.title} already.`);
    // Control's arguments are its control unit's answers, settled as they are: what it gates
    // is management's, and its provider takes none.
    let given = input.arguments;
    if (capability === CONTROL_ROOT) {
      const settled = await parts.settleControl(record, input.arguments, by);
      if (settled.problems.length) return { problems: settled.problems.map(atPath) };
      given = settled.values as Record<string, Json>;
    }
    const secrets = secretsOf(defined.arguments);
    const echoed = valuesOf(input.arguments, secrets);
    const root: Root = {
      mounted: `mnt_${crypto.randomUUID().replaceAll("-", "")}`,
      provider: input.provider,
      providerMounted: "",
      capability,
      title: defined.title,
      arguments: Object.fromEntries(
        Object.entries(given).filter(([name]) => !secrets.includes(name)),
      ),
      by,
      ...(parent ? { parent } : {}),
    };
    record.mounted.push(root);
    save();
    await changed(agent);
    const unkeep = () => {
      record.mounted = record.mounted.filter((one) => one !== root);
      save();
      changed(agent);
    };
    let made: Awaited<ReturnType<Provider["mount"]>>;
    try {
      made = await provider.call.mount({
        agent,
        capability,
        arguments: capability === CONTROL_ROOT ? {} : input.arguments,
      });
    } catch (error) {
      unkeep();
      throw redacted(error, echoed);
    }
    if ("problems" in made) {
      unkeep();
      return {
        problems: made.problems.map((problem) => ({
          ...problem,
          message: redact(problem.message, echoed),
        })),
      };
    }
    root.providerMounted = made.mounted;
    save();
    // What it made outside the agent is wired as an applied unit's is, and control is given
    // what its unit gives: if it can't be, the mount is undone whole.
    const { made: outside } = made;
    const wiring =
      capability === CONTROL_ROOT
        ? () => parts.wireControl(agent, record)
        : outside
          ? () =>
              parts.wire(
                agent,
                record,
                root,
                outside,
                async (name, path) => (await provider.call.skill({ capability, name, path })).text,
              )
          : undefined;
    if (wiring)
      try {
        root.made = await wiring();
        save();
      } catch (error) {
        await takeOff(agent, root).catch(() => {});
        unkeep();
        throw redacted(error, echoed);
      }
    // What was wired, such as its skills, is the agent's too.
    if (wiring) await parts.give(agent);
    return { mounted: root.mounted };
  };

  /**
   * Take a root off: off the record first, so the agent's settings no longer name it, then
   * through its provider. One that can't go is put back, whole, to be tried again. A template's
   * goes with each it mounted, last first.
   */
  const unmountOne = async (agent: string, mounted: string) => {
    const record = recordOf(agent);
    for (const child of record.mounted.filter((one) => one.parent === mounted).reverse())
      await unmountOne(agent, child.mounted);
    const at = record.mounted.findIndex((one) => one.mounted === mounted);
    const root = record.mounted[at];
    if (!root) {
      if (OWN_ROOTS.includes(mounted)) throw ownRoot(mounted);
      if (fromUnit(record, mounted))
        throw new Refused("state", "This came with a unit: remove the unit.");
      throw new Refused("unknown", `${agent} has nothing mounted as ${mounted}.`);
    }
    record.mounted.splice(at, 1);
    save();
    await changed(agent);
    try {
      await takeOff(agent, root);
    } catch (error) {
      record.mounted.splice(Math.min(at, record.mounted.length), 0, root);
      save();
      changed(agent);
      throw error;
    }
    await parts.unwire(agent, record, root);
    await parts.give(agent);
    if (root.capability === CONTROL_ROOT && !holdsControl(record, self))
      await parts.unreachControl(agent);
    return {};
  };

  /**
   * Mount a template: each capability it lists, through its provider, as the template's own, all
   * or none. What is given under a capability's key overrides the template's arguments for it. A
   * required argument left empty is a problem at `/<key>/<argument>`, and nothing is mounted.
   */
  const mountTemplate = async (
    input: { agent: string; template: TheTemplate; arguments: Record<string, Json> },
    by: string,
  ): Promise<Mounting> => {
    const { agent, template } = input;
    const record = recordOf(agent);
    if (record.mounted.some((one) => one.capability === template.id))
      throw new Refused("state", `It holds a ${template.title} already.`);
    const keys = keysOf(template);
    const problems: Problem[] = Object.keys(input.arguments)
      .filter((key) => !keys.includes(key))
      .map((key) => ({ path: `/${key}`, message: `${template.title} has no ${key}.` }));
    const named = await Promise.all(
      parts.providers().map(async (one) => ({ ...one, name: await parts.nameOf(one.actor) })),
    );
    const children: (Input & { key: string })[] = [];
    const kept: Record<string, Json> = {};
    for (const [at, one] of template.capabilities.entries()) {
      const key = keys[at] as string;
      const given = input.arguments[key] ?? {};
      if (!isObject(given)) {
        problems.push({ path: `/${key}`, message: `${key}'s arguments must be an object.` });
        continue;
      }
      const provider = named.find(({ name }) => name === one.provider);
      if (!provider) {
        problems.push({ path: `/${key}`, message: `${one.provider} isn't connected.` });
        continue;
      }
      const defined = (await provider.call.capabilities({})).capabilities.find(
        ({ id }) => id === one.capability,
      );
      if (!defined) {
        problems.push({
          path: `/${key}`,
          message: `${one.provider} offers no capability ${one.capability}.`,
        });
        continue;
      }
      const args = { ...one.arguments, ...given };
      const schema = defined.arguments as Record<string, Json>;
      const properties = isObject(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
      for (const name of required)
        if (args[name] === undefined || args[name] === "") {
          const property = properties[name];
          const title = isObject(property) && property.title ? String(property.title) : name;
          problems.push({ path: `/${key}/${name}`, message: `${title} must be given.` });
        }
      const secrets = secretsOf(schema);
      kept[key] = Object.fromEntries(
        Object.entries(given).filter(([name]) => !secrets.includes(name)),
      );
      children.push({
        key,
        agent,
        provider: provider.actor,
        capability: one.capability,
        arguments: args,
      });
    }
    if (problems.length) return { problems };
    const root: Root = {
      mounted: `mnt_${crypto.randomUUID().replaceAll("-", "")}`,
      provider: self,
      providerMounted: "",
      capability: template.id,
      title: template.title,
      arguments: kept,
      by,
    };
    record.mounted.push(root);
    save();
    changed(agent);
    // Each in the template's order; one that isn't mounted takes the rest off with the template.
    const undo = () => unmountOne(agent, root.mounted).catch(() => {});
    for (const { key, ...child } of children) {
      let made: Mounting;
      try {
        made = await mountOne(child, by, root.mounted);
      } catch (error) {
        await undo();
        throw error;
      }
      if ("problems" in made) {
        await undo();
        return {
          problems: made.problems.map(({ path, message }) => ({
            path: `/${key}${path ?? ""}`,
            message,
          })),
        };
      }
    }
    return { mounted: root.mounted };
  };

  return {
    mount: (input: Input, by: string) => serial(input.agent, () => mountOne(input, by)),
    mountTemplate: (
      input: { agent: string; template: TheTemplate; arguments: Record<string, Json> },
      by: string,
    ) => serial(input.agent, () => mountTemplate(input, by)),
    unmount: ({ agent, mounted }: { agent: string; mounted: string }) =>
      serial(agent, () => unmountOne(agent, mounted)),

    /**
     * Every root of a removed agent, last first: off the record first, so the agent's settings no
     * longer name it, then through its provider, as `unmount` does. One whose provider is away, or
     * has lost it, simply goes; one that can't go is put back, and leaves the agent to be tried
     * again.
     */
    async unmountAll(agent: string, record: TheAgent) {
      for (const root of [...record.mounted].reverse()) {
        const at = record.mounted.indexOf(root);
        record.mounted.splice(at, 1);
        save();
        await changed(agent);
        try {
          await takeOff(agent, root);
        } catch (error) {
          if (!(error instanceof Refused && error.code === "not_connected")) {
            record.mounted.splice(Math.min(at, record.mounted.length), 0, root);
            save();
            changed(agent);
            throw error;
          }
          log.warn("A capability's provider can't be reached as its agent is removed.", {
            agent,
            mounted: root.mounted,
          });
        }
        await parts.unwire(agent, record, root);
        await parts.give(agent);
      }
    },

    /**
     * What was mounted on the agent, each with its state and what is mounted under it, as the
     * agent says them. With no word from the agent, a root has no state and no children. With
     * `parents`, each mounted as a template's names the template's mount.
     */
    tree(
      record: TheAgent,
      held: Held[] | undefined,
      outside: Map<string, Stood> = new Map(),
      parents = false,
    ) {
      return record.mounted.map(({ providerMounted: _, made: __, parent, ...root }) => {
        // One a provider outside the agent made says how it stands through that provider.
        const stood = outside.get(root.mounted);
        const own = stood
          ? undefined
          : held?.find((one) => one.name === root.capability && !one.parent);
        const said = stood ?? own;
        return {
          ...root,
          ...(parents && parent ? { parent } : {}),
          ...(said ? { state: said.state, ...(said.detail ? { detail: said.detail } : {}) } : {}),
          children: own && held ? under(held, own.name) : [],
        };
      });
    },

    /**
     * How each mount a provider outside the agent made stands, by its mount, as that provider says:
     * asked when a person or a program reads the agent, never in its turn. One the provider no
     * longer has is failed, and one whose provider can't be reached now is down.
     */
    async outside(agent: string, record: TheAgent) {
      const asked = record.mounted.filter(
        (one) => one.providerMounted && one.provider !== record.provider && one.provider !== self,
      );
      const said = await Promise.all(
        asked.map(async (root): Promise<[string, Stood]> => {
          const provider = providerOf(root.provider);
          if (!provider)
            return [root.mounted, { state: "down", detail: "Its provider can't be reached now." }];
          try {
            const { state, detail } = await provider.call.status({
              agent,
              mounted: root.providerMounted,
            });
            return [root.mounted, { state, ...(detail ? { detail } : {}) }];
          } catch (error) {
            const away =
              error instanceof NotConnected ||
              (error instanceof Refused && error.code === "not_connected");
            return [
              root.mounted,
              alreadyGone(error)
                ? { state: "failed", detail: "Its provider no longer has it." }
                : away
                  ? { state: "down", detail: "Its provider can't be reached now." }
                  : {
                      state: "down",
                      detail: `Its provider didn't say how it stands: ${messageOf(error)}`.slice(
                        0,
                        2000,
                      ),
                    },
            ];
          }
        }),
      );
      return new Map(said);
    },
  };
}
