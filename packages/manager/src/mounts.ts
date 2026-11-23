/**
 * Capabilities mounted on agents through management: each made by a connected capability provider,
 * kept in the agent's record with its arguments, and taken off through the same provider.
 *
 * Management keeps the record, and gates nothing: whoever is bound to `agents@1` mounts and
 * unmounts. What an agent may mount, and when a person is asked, is the controlling capability's.
 *
 * A capability mounted from the agent's own executor is held by that executor through the tree its
 * settings give (`treeOf`), so it is kept, and the agent told its settings changed, before the
 * provider is asked: a turn that reads the settings meanwhile already holds it. If the provider
 * doesn't make it, the record goes back as it was, and the agent is told again.
 *
 * The tree's other roots aren't mounted here, so none is mounted or unmounted through this:
 * `instructions` and `skills` are management's own, and the rest came with a unit.
 *
 * A `secret` argument goes to the provider's `mount` and nowhere else: it isn't kept, and a refusal
 * or a problem that echoes it says "…" in its place. So a capability with one isn't mounted again
 * with it when its agent starts; how it is, is for the step that rebuilds how agents are made.
 */
import type { capabilityProvider, HeldCapability } from "@agentorg/interfaces";
import { type Log, Refused, type Slot } from "@agentorg/sdk";
import type { z } from "zod";
import { CONTROL_ROOT, holdsControl, OWN_ROOTS, unitControls } from "./settings.js";
import type { AgentRecord, MountRecord } from "./stack.js";

type Provider = Slot<typeof capabilityProvider>["call"];
type Made = Awaited<ReturnType<Provider["mount"]>>;
type TheAgent = z.infer<typeof AgentRecord>;
type Root = z.infer<typeof MountRecord>;
type Held = z.infer<typeof HeldCapability>;
type Json = Root["arguments"][string];

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
  /** Tell the agent its settings changed. */
  changed(agent: string): void;
  /** Have an agent holding control reach management's `agents@1`, or no longer. */
  reachControl(agent: string, reach: boolean): Promise<void>;
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
}

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

  return {
    mount: (
      input: {
        agent: string;
        provider: string;
        capability: string;
        arguments: Record<string, Json>;
      },
      by: string,
    ) =>
      serial(input.agent, async () => {
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
        // Held once, whether it was mounted or built by a unit.
        if (
          record.mounted.some((one) => one.capability === capability) ||
          record.capabilities.some((one) => one.id === capability) ||
          (capability === CONTROL_ROOT && unitControls(record, self))
        )
          throw new Refused("state", `It holds a ${defined.title} already.`);
        const secrets = secretsOf(defined.arguments);
        const echoed = valuesOf(input.arguments, secrets);
        const root: Root = {
          mounted: `mnt_${crypto.randomUUID().replaceAll("-", "")}`,
          provider: input.provider,
          providerMounted: "",
          capability,
          title: defined.title,
          arguments: Object.fromEntries(
            Object.entries(input.arguments).filter(([name]) => !secrets.includes(name)),
          ),
          by,
        };
        record.mounted.push(root);
        save();
        changed(agent);
        const unkeep = () => {
          record.mounted = record.mounted.filter((one) => one !== root);
          save();
          changed(agent);
        };
        let made: Awaited<ReturnType<Provider["mount"]>>;
        try {
          made = await provider.call.mount({ agent, capability, arguments: input.arguments });
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
        // What it made outside the agent is wired as an applied unit's is: if it can't be, the
        // mount is undone whole.
        if (made.made)
          try {
            root.made = await parts.wire(
              agent,
              record,
              root,
              made.made,
              async (name, path) => (await provider.call.skill({ capability, name, path })).text,
            );
            save();
          } catch (error) {
            await takeOff(agent, root).catch(() => {});
            unkeep();
            throw redacted(error, echoed);
          }
        // Control reaches management's agents@1, as the control unit's does.
        if (capability === CONTROL_ROOT) await parts.reachControl(agent, true);
        return { mounted: root.mounted };
      }),

    /**
     * Take a root off: off the record first, so the agent's settings no longer name it, then
     * through its provider. One that can't go is put back, whole, to be tried again.
     */
    unmount: ({ agent, mounted }: { agent: string; mounted: string }) =>
      serial(agent, async () => {
        const record = recordOf(agent);
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
        changed(agent);
        try {
          await takeOff(agent, root);
        } catch (error) {
          record.mounted.splice(Math.min(at, record.mounted.length), 0, root);
          save();
          changed(agent);
          throw error;
        }
        await parts.unwire(agent, record, root);
        if (root.capability === CONTROL_ROOT && !holdsControl(record, self))
          await parts.reachControl(agent, false);
        return {};
      }),

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
        changed(agent);
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
      }
    },

    /**
     * What was mounted on the agent, each with its state and what is mounted under it, as the
     * agent says them. With no word from the agent, a root has no state and no children.
     */
    tree(record: TheAgent, held: Held[] | undefined) {
      return record.mounted.map(({ providerMounted: _, made: __, ...root }) => {
        const own = held?.find((one) => one.name === root.capability && !one.parent);
        return {
          ...root,
          ...(own ? { state: own.state, ...(own.detail ? { detail: own.detail } : {}) } : {}),
          children: own && held ? under(held, own.name) : [],
        };
      });
    },
  };
}
