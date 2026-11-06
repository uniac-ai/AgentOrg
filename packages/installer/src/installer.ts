// The installer: a package Actor that turns packages into working Actors, and systems into
// compositions and back. It holds the Hub's management (packages, Actors, grants, exports,
// bindings: as a manager it can grant what an install connects), storage.admin@1 for seeds and
// the person's layout@1. It proposes; whoever calls it picks, and it grants nothing its caller
// couldn't.
import {
  type Composition,
  hubActors,
  hubBindings,
  hubExports,
  hubGrants,
  hubPackages,
  installer,
  layout,
  storageAdmin,
} from "@agentorg/interfaces";
import { defineActor, Refused } from "@agentorg/sdk";
import type { Manifest } from "@agentorg/sdk/manifest";

/** The built-in Actors that keep state and that manage. */
const STORAGE = "storage";
const HUB = "hub";
/** Built-in Actors: a composition names them by their ids. */
const BUILTIN = new Set([HUB, STORAGE, "net"]);
type System = import("zod").infer<typeof Composition>;
type Unresolved = { what: string; why: string }[];
const utf8 = new TextEncoder();
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export default defineActor({
  slots: {
    packages: hubPackages,
    actors: hubActors,
    grants: hubGrants,
    exports: hubExports,
    bindings: hubBindings,
    storage: storageAdmin,
    layout,
  },
  exports: { installer },
  start(ctx) {
    const manifestOf = async (hash: string) =>
      (await ctx.slots.packages.call.get({ hash })).manifest as unknown as Manifest;
    /** The package's slots the installer connects (`module.slot`), with their interfaces. */
    const openSlots = (manifest: Manifest) => {
      const wired = new Set(manifest.connections.map(([slot]) => slot));
      return Object.entries(manifest.modules).flatMap(([module, m]) =>
        Object.entries(m.slots)
          .map(([slot, id]) => ({ slot: `${module}.${slot}`, id }))
          .filter(({ slot }) => !wired.has(slot)),
      );
    };

    /**
     * What a caller may grant, by the Hub's rule for an export side: it is the provider, is bound
     * to that export, or is a manager. Refused when the installer can't read the caller's bindings.
     */
    const grantsOf = async (caller: string) => {
      let held: { consumer: string; provider: string; export: string }[];
      try {
        held = (await ctx.slots.bindings.call.list({ actor: caller })).bindings.filter(
          (b) => b.consumer === caller,
        );
      } catch {
        throw new Refused(
          "forbidden",
          "This installer isn't bound to hub.bindings, so it can't tell what its caller may grant; nothing was created.",
        );
      }
      const manager = held.some((b) => b.provider === HUB && b.export === "bindings");
      return {
        manager,
        may: (target: { actor: string; export: string }) =>
          manager ||
          target.actor === caller ||
          held.some((b) => b.provider === target.actor && b.export === target.export),
      };
    };
    /** A package's seed for a slot bound to storage's kv, checked: entries for storage.seed. */
    const seedFor = (manifest: Manifest, slot: string) => {
      const seed = manifest.seed?.[slot];
      if (seed === undefined) return undefined;
      if (!isRecord(seed))
        throw new Refused(
          "invalid",
          `The package's seed for ${slot} isn't an object of key to value.`,
        );
      // kv@1's keys: 1 to 1024 characters, at most 1 KiB, well-formed text.
      for (const key of Object.keys(seed))
        if (!key || key.length > 1024 || utf8.encode(key).length > 1024 || LONE_SURROGATE.test(key))
          throw new Refused(
            "invalid",
            `The package's seed for ${slot} has a key kv@1 can't hold: ${JSON.stringify(key.slice(0, 64))}.`,
          );
      return Object.entries(seed).map(([key, value]) => ({ key, value }));
    };
    /** Close what was made, and say so if that fails too. */
    const undo = async (made: string[], error: unknown): Promise<never> => {
      const why = error instanceof Error ? error.message : String(error);
      const stuck: string[] = [];
      for (const actorId of made)
        await ctx.slots.actors.call
          .close({ actorId })
          .catch((closing: unknown) =>
            stuck.push(
              `${actorId} (${closing instanceof Error ? closing.message : String(closing)})`,
            ),
          );
      if (stuck.length)
        throw new Refused(
          error instanceof Refused ? error.code : "failed",
          `${why} What was made couldn't all be closed after: ${stuck.join(", ")}.`,
        );
      throw error;
    };
    const isStorageKv = (target?: { actor: string; export: string }) =>
      target?.actor === STORAGE && target.export === "kv";

    ctx.exports.installer.implement({
      async plan({ package: hash }) {
        const manifest = await manifestOf(hash);
        const [{ exports }, { actors }] = await Promise.all([
          ctx.slots.exports.call.list({}),
          ctx.slots.actors.call.list({}),
        ]);
        // What can serve now: built-in and external Actors, and package Actors that run.
        const live = new Set(
          actors
            .filter(
              (a) => a.state === "running" || (a.package === "external" && a.state !== "closed"),
            )
            .map((a) => a.actorId),
        );
        return {
          slots: openSlots(manifest).map(({ slot, id }) => ({
            slot,
            interface: id,
            candidates: exports
              .filter(
                (e) =>
                  e.interface === id &&
                  e.hash === manifest.interfaces[id]?.hash &&
                  live.has(e.actor),
              )
              .map((e) => ({ actor: e.actor, export: e.export })),
          })),
          views: Object.keys(manifest.modules).filter(
            (name) => manifest.modules[name]?.placement === "view",
          ),
        };
      },

      async install({ package: hash, name, connections, start }, { caller }) {
        const manifest = await manifestOf(hash);
        const open = openSlots(manifest).map(({ slot }) => slot);
        for (const slot of Object.keys(connections))
          if (!open.includes(slot))
            throw new Refused("invalid", `${slot} isn't one of the package's slots to connect.`);
        // Delegation only narrows: the installer grants no connection its caller couldn't grant
        // itself.
        const { may } = await grantsOf(caller);
        const beyond = Object.entries(connections).filter(([, target]) => !may(target));
        if (beyond.length)
          throw new Refused(
            "forbidden",
            `${caller} can't grant ${beyond.map(([slot, t]) => `${slot} → ${t.actor}.${t.export}`).join(", ")}, so the installer won't either; nothing was created. Install without ${beyond.length === 1 ? "it" : "them"}, then have the new Actor (it holds the slot side) or a manager request ${beyond.length === 1 ? "it" : "them"} with hub.grants.request.`,
          );
        // Seeds are checked before anything is made: each one for a kv store is an object. One for
        // a slot that won't be bound to storage.kv can't land, and is listed.
        const unseeded = Object.keys(manifest.seed ?? {}).filter(
          (slot) => open.includes(slot) && !isStorageKv(connections[slot]),
        );
        const seeds = Object.entries(connections).flatMap(([slot, target]) => {
          const entries = isStorageKv(target) ? seedFor(manifest, slot) : undefined;
          return entries ? [{ slot, entries }] : [];
        });
        let actorId: string;
        try {
          ({ actorId } = await ctx.slots.actors.call.create({
            name,
            package: hash,
            bindings: Object.entries(connections).map(([slot, target]) => ({
              slot,
              provider: target.actor,
              export: target.export,
            })),
          }));
        } catch (error) {
          // The caller could grant them, but this installer can't (it isn't a manager).
          if (error instanceof Refused && error.code === "forbidden")
            throw new Refused(
              "forbidden",
              `The installer can't make these connections (${error.message}); nothing was created. Install without them, then request them with hub.grants.request.`,
            );
          throw error;
        }
        // All or none: a seed or a start that fails takes the new Actor with it. If even that
        // fails, the error says so, with the Actor's id.
        try {
          for (const { slot, entries } of seeds)
            await ctx.slots.storage.call.seed({
              consumer: actorId,
              slot,
              entries: entries as never,
            });
          if (start) await ctx.slots.actors.call.start({ actorId });
        } catch (error) {
          return undo([actorId], error);
        }
        return {
          actorId,
          unbound: open.filter((slot) => !Object.hasOwn(connections, slot)),
          unseeded,
        };
      },

      async exportSystem() {
        const [{ actors }, { bindings }, { home }] = await Promise.all([
          ctx.slots.actors.call.list({}),
          ctx.slots.bindings.call.list({}),
          ctx.slots.layout.call.get({}),
        ]);
        const unresolved: Unresolved = [];
        // Each package Actor by a name of its own: built-in ids and names already used are taken.
        const names = new Map<string, string>();
        const used = new Set(BUILTIN);
        const composition: System = {
          format: "agentorg.system/1",
          actors: {},
          connections: [],
          layout: { home: [] },
        };
        const manifests = new Map<string, Manifest>();
        const packageOf = new Map<string, string>();
        /** Any Actor, by its name, for what is listed: never an id. */
        const label = (id: string) =>
          names.get(id) ?? actors.find((a) => a.actorId === id)?.name ?? id;
        for (const actor of actors) {
          if (actor.state === "closed" || actor.package === "builtin") continue;
          if (actor.package === "external") {
            if (actor.actorId !== "person")
              unresolved.push({ what: actor.name, why: "an external Actor: it connects itself" });
            continue;
          }
          // A home has its own installer: making a second one elsewhere would be a second manager.
          if (actor.actorId === ctx.self.actorId) {
            unresolved.push({
              what: actor.name,
              why: "this home's installer: every home has its own",
            });
            continue;
          }
          let name = actor.name;
          for (let n = 2; used.has(name); n++) name = `${actor.name} (${n})`;
          used.add(name);
          names.set(actor.actorId, name);
          packageOf.set(actor.actorId, actor.package);
          if (!manifests.has(actor.package))
            manifests.set(actor.package, await manifestOf(actor.package));
          const manifest = manifests.get(actor.package) as Manifest;
          composition.actors[name] = {
            package: `${manifest.name}@${manifest.version}#${actor.package}`,
            ...(actor.state === "running" ? { running: true } : {}),
          };
        }
        const nameOf = (id: string) => names.get(id) ?? (BUILTIN.has(id) ? id : undefined);
        for (const b of bindings) {
          const consumer = names.get(b.consumer);
          // A package's own wiring is made with it.
          const own = manifests.get(packageOf.get(b.consumer) ?? "")?.connections;
          if (
            b.consumer === b.provider &&
            own?.some(([slot, exported]) => slot === b.slot && exported === b.export)
          )
            continue;
          const provider = nameOf(b.provider);
          if (consumer && provider)
            composition.connections.push({ consumer, slot: b.slot, provider, export: b.export });
          else if (consumer)
            unresolved.push({
              what: `${consumer}.${b.slot}`,
              why: `bound to ${label(b.provider)}.${b.export}, which isn't part of the system`,
            });
          else if (names.has(b.provider) && b.consumer !== "person")
            unresolved.push({
              what: `${label(b.consumer)}.${b.slot}`,
              why: `a slot of an Actor outside the system, bound to ${label(b.provider)}.${b.export}`,
            });
        }
        for (const placed of home) {
          const actor = names.get(placed.actor);
          if (actor)
            composition.layout.home.push({
              actor,
              module: placed.module,
              ...(placed.title === undefined ? {} : { title: placed.title }),
            });
          else
            unresolved.push({
              what: `${label(placed.actor)}.${placed.module}${placed.title ? ` (${placed.title})` : ""}`,
              why: "a placement whose Actor isn't part of the system",
            });
        }
        return { composition, unresolved };
      },

      async importSystem({ composition }, { caller }) {
        const unresolved: Unresolved = [];
        for (const name of Object.keys(composition.actors))
          if (BUILTIN.has(name))
            throw new Refused(
              "invalid",
              `${name} is a built-in Actor's id, not a name a composition's Actor may have.`,
            );
        // Each Actor's package, if it is here, and it is the package the composition names.
        const manifests = new Map<string, { hash: string; manifest: Manifest }>();
        for (const [name, actor] of Object.entries(composition.actors)) {
          const [label = "", hash = ""] = actor.package.split("#");
          let manifest: Manifest;
          try {
            manifest = await manifestOf(hash);
          } catch {
            unresolved.push({
              what: name,
              why: `its package ${actor.package} isn't here: add it, then import again`,
            });
            continue;
          }
          const here = `${manifest.name}@${manifest.version}`;
          if (label !== here) {
            unresolved.push({ what: name, why: `its package is ${here} here, not ${label}` });
            continue;
          }
          manifests.set(name, { hash, manifest });
        }
        const known = (name: string) => manifests.has(name) || BUILTIN.has(name);
        // A composition may come from anyone: management and seeding powers are never granted by
        // importing it, even by a manager. They are listed, for the person to grant one by one.
        const ungranted = composition.connections.filter(
          (c) => c.provider === HUB || (c.provider === STORAGE && c.export === "admin"),
        );
        const connections = composition.connections.filter((c) => {
          if (ungranted.includes(c)) return false;
          if (known(c.consumer) && known(c.provider) && !BUILTIN.has(c.consumer)) return true;
          unresolved.push({
            what: `${c.consumer}.${c.slot}`,
            why: `its connection to ${c.provider}.${c.export} needs an Actor that isn't here`,
          });
          return false;
        });
        // Each connection is to a slot its package leaves open, and only once.
        const wired = new Set<string>();
        for (const c of connections) {
          const open = openSlots((manifests.get(c.consumer) as { manifest: Manifest }).manifest);
          if (!open.some(({ slot }) => slot === c.slot))
            throw new Refused(
              "invalid",
              `${c.consumer}.${c.slot} isn't one of its package's slots to connect.`,
            );
          if (wired.has(`${c.consumer}\0${c.slot}`))
            throw new Refused("invalid", `${c.consumer}.${c.slot} is connected twice.`);
          wired.add(`${c.consumer}\0${c.slot}`);
        }
        // Each placement is of a view module of its Actor's package.
        for (const placed of composition.layout.home) {
          const manifest = manifests.get(placed.actor)?.manifest;
          if (manifest && manifest.modules[placed.module]?.placement !== "view")
            throw new Refused(
              "invalid",
              `${placed.actor}.${placed.module} isn't a view module to place.`,
            );
        }
        // With the caller's authority: an export of an Actor this import makes is the caller's to
        // grant only if the caller is a manager (it is neither its provider nor bound to it yet);
        // a built-in's, by the usual rule.
        const { manager, may } = await grantsOf(caller);
        const beyond = connections.filter((c) =>
          BUILTIN.has(c.provider) ? !may({ actor: c.provider, export: c.export }) : !manager,
        );
        if (beyond.length)
          throw new Refused(
            "forbidden",
            `${caller} can't grant ${beyond.map((c) => `${c.consumer}.${c.slot} → ${c.provider}.${c.export}`).join(", ")}, so the installer won't either; nothing was created.`,
          );
        // Placing on the person's layout, too, is the caller's to do only if it holds that layout.
        const own = (await ctx.slots.bindings.call.list({ actor: ctx.self.actorId })).bindings.find(
          (b) => b.consumer === ctx.self.actorId && b.slot === "installer.layout",
        );
        const mayPlace = !!own && may({ actor: own.provider, export: own.export });
        const taken = new Set(
          (await ctx.slots.actors.call.list({})).actors
            .filter((a) => a.state !== "closed")
            .map((a) => a.name),
        );
        const created: Record<string, string> = {};
        const placedIds: string[] = [];
        try {
          for (const [name, { hash, manifest }] of manifests) {
            let given = name;
            for (let n = 2; taken.has(given); n++) given = `${name} (${n})`;
            taken.add(given);
            created[name] = (
              await ctx.slots.actors.call.create({ name: given, package: hash })
            ).actorId;
            if (given !== name)
              unresolved.push({ what: name, why: `the name was taken: made as ${given}` });
            if (
              Object.values(manifest.modules).some((m) =>
                Object.values(m.exports).includes("account.login@1"),
              )
            )
              unresolved.push({ what: name, why: "it needs a sign-in" });
            // Seeds for slots that won't be bound to storage.kv can't land.
            for (const slot of Object.keys(manifest.seed ?? {}))
              if (
                !connections.some(
                  (c) =>
                    c.consumer === name &&
                    c.slot === slot &&
                    isStorageKv({ actor: c.provider, export: c.export }),
                )
              )
                unresolved.push({
                  what: `${name}.${slot}`,
                  why: "its seed can't land: the slot isn't connected to storage.kv",
                });
          }
          const idOf = (name: string) => created[name] ?? name;
          for (const c of connections) {
            const done = await ctx.slots.grants.call.bind({
              consumer: idOf(c.consumer),
              slot: c.slot,
              provider: idOf(c.provider),
              export: c.export,
            });
            if (!done.bound)
              throw new Refused(
                "forbidden",
                `The installer couldn't make ${c.consumer}.${c.slot} → ${c.provider}.${c.export}.`,
              );
          }
          for (const c of connections) {
            if (!isStorageKv({ actor: c.provider, export: c.export })) continue;
            const entries = seedFor(
              (manifests.get(c.consumer) as { manifest: Manifest }).manifest,
              c.slot,
            );
            if (entries)
              await ctx.slots.storage.call.seed({
                consumer: idOf(c.consumer),
                slot: c.slot,
                entries: entries as never,
              });
          }
          for (const [name, actor] of Object.entries(composition.actors))
            if (actor.running && created[name])
              await ctx.slots.actors.call.start({ actorId: created[name] });
          for (const placed of composition.layout.home) {
            const actorId = created[placed.actor];
            if (!actorId || !mayPlace) {
              unresolved.push({
                what: `${placed.actor}.${placed.module}`,
                why: actorId
                  ? `${caller} can't place on the person's layout`
                  : "a placement whose Actor isn't here",
              });
              continue;
            }
            placedIds.push(
              (
                await ctx.slots.layout.call.place({
                  actor: actorId,
                  module: placed.module,
                  ...(placed.title === undefined ? {} : { title: placed.title }),
                })
              ).id,
            );
          }
        } catch (error) {
          // All or none: the placements go, then the Actors (with their bindings and stores).
          for (const id of placedIds) await ctx.slots.layout.call.remove({ id }).catch(() => {});
          return undo(Object.values(created), error);
        }
        return { created, unresolved, ungranted };
      },
    });
  },
});
