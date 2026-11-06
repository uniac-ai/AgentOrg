// The installer: a package Actor that turns packages into working Actors. It holds the Hub's
// management (packages, Actors, grants, exports, bindings: as a manager it can grant what an
// install connects) and storage.admin@1 for seeds. It proposes; whoever calls it picks.
import {
  hubActors,
  hubBindings,
  hubExports,
  hubGrants,
  hubPackages,
  installer,
  storageAdmin,
} from "@agentorg/interfaces";
import { defineActor, Refused } from "@agentorg/sdk";
import type { Manifest } from "@agentorg/sdk/manifest";

/** The built-in Actors that keep state and that manage. */
const STORAGE = "storage";
const HUB = "hub";
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
        // itself. The export side, as the Hub's rule has it: the caller is the provider, is bound
        // to that export, or is a manager (bound to hub.bindings).
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
        const beyond = Object.entries(connections).filter(
          ([, target]) =>
            !manager &&
            target.actor !== caller &&
            !held.some((b) => b.provider === target.actor && b.export === target.export),
        );
        if (beyond.length)
          throw new Refused(
            "forbidden",
            `${caller} can't grant ${beyond.map(([slot, t]) => `${slot} → ${t.actor}.${t.export}`).join(", ")}, so the installer won't either; nothing was created. Install without ${beyond.length === 1 ? "it" : "them"}, then have the new Actor (it holds the slot side) or a manager request ${beyond.length === 1 ? "it" : "them"} with hub.grants.request.`,
          );
        // Seeds are checked before anything is made: each one for a kv store is an object. One for
        // a slot that won't be bound to storage.kv can't land, and is listed.
        const unseeded = Object.keys(manifest.seed ?? {}).filter(
          (slot) =>
            open.includes(slot) &&
            (connections[slot]?.actor !== STORAGE || connections[slot]?.export !== "kv"),
        );
        const seeds = Object.entries(connections).flatMap(([slot, target]) => {
          const seed = manifest.seed?.[slot];
          if (seed === undefined || target.actor !== STORAGE || target.export !== "kv") return [];
          if (!isRecord(seed))
            throw new Refused(
              "invalid",
              `The package's seed for ${slot} isn't an object of key to value.`,
            );
          // kv@1's keys: 1 to 1024 characters, at most 1 KiB, well-formed text.
          for (const key of Object.keys(seed))
            if (
              !key ||
              key.length > 1024 ||
              utf8.encode(key).length > 1024 ||
              LONE_SURROGATE.test(key)
            )
              throw new Refused(
                "invalid",
                `The package's seed for ${slot} has a key kv@1 can't hold: ${JSON.stringify(key.slice(0, 64))}.`,
              );
          return [{ slot, entries: Object.entries(seed).map(([key, value]) => ({ key, value })) }];
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
          const why = error instanceof Error ? error.message : String(error);
          try {
            await ctx.slots.actors.call.close({ actorId });
          } catch (closing) {
            throw new Refused(
              error instanceof Refused ? error.code : "failed",
              `${why} The new Actor ${actorId} couldn't be closed after: ${closing instanceof Error ? closing.message : String(closing)}`,
            );
          }
          throw error;
        }
        return {
          actorId,
          unbound: open.filter((slot) => !Object.hasOwn(connections, slot)),
          unseeded,
        };
      },
    });
  },
});
