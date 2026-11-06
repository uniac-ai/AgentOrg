import { randomBytes } from "node:crypto";
import type { Placement } from "@agentorg/interfaces";
import { Refused } from "@agentorg/sdk";
import type { z } from "zod";

export type PlacementRecord = z.output<typeof Placement>;

/** Where the layout is kept: the person's `kv@1` slot, under one key. */
export interface LayoutStore {
  get(key: string): Promise<{ value?: unknown }>;
  set(key: string, value: unknown): Promise<unknown>;
}

/** The key the layout is kept under, in the person's store. */
export const LAYOUT_KEY = "layout";
/** Placements one layout holds; past it, `place` is refused. */
const MAX_PLACEMENTS = 200;

/**
 * `layout@1`'s logic: what the person has placed, in order, kept in its own store, so it is state
 * like any other Actor's. Writes run one at a time; each one tells `changed`. `isView` says whether
 * a module is a `view` module of an Actor's package, the only thing `place` accepts.
 */
export class Layout {
  readonly #store: () => LayoutStore;
  readonly #isView: (actor: string, module: string) => boolean;
  readonly #changed: () => void;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: {
    store: () => LayoutStore;
    isView(actor: string, module: string): boolean;
    changed(): void;
  }) {
    this.#store = options.store;
    this.#isView = options.isView;
    this.#changed = options.changed;
  }

  async get(): Promise<{ home: PlacementRecord[] }> {
    return { home: await this.#read() };
  }

  /** Place a view, recording `by`, the Actor that asked, as the call's caller says. */
  place(input: { actor: string; module: string; title?: string; after?: string }, by: string) {
    return this.#write((home) => {
      if (!this.#isView(input.actor, input.module))
        throw new Refused(
          "invalid",
          `${input.actor}.${input.module} isn't a view module of a running package Actor.`,
        );
      if (home.length >= MAX_PLACEMENTS)
        throw new Refused("quota", `A layout holds ${MAX_PLACEMENTS} placements at most.`);
      const placement: PlacementRecord = {
        id: randomBytes(9).toString("base64url"),
        actor: input.actor,
        module: input.module,
        ...(input.title === undefined ? {} : { title: input.title }),
        by,
      };
      return { home: insert(home, placement, input.after), result: { id: placement.id } };
    });
  }

  remove(input: { id: string }) {
    return this.#write((home) => {
      at(home, input.id);
      return { home: home.filter((placement) => placement.id !== input.id), result: {} };
    });
  }

  move(input: { id: string; after?: string }) {
    return this.#write((home) => {
      const placement = at(home, input.id);
      if (input.after === input.id)
        throw new Refused("invalid", "A placement can't follow itself.");
      const rest = home.filter((other) => other.id !== input.id);
      // Moved with no `after`, it goes first; placed with none, last.
      return { home: insert(rest, placement, input.after ?? null), result: {} };
    });
  }

  async #read(): Promise<PlacementRecord[]> {
    const { value } = await this.#store().get(LAYOUT_KEY);
    return Array.isArray(value) ? (value as PlacementRecord[]) : [];
  }

  /** One write at a time: read, change, write back, then tell. */
  #write<R>(
    change: (home: PlacementRecord[]) => { home: PlacementRecord[]; result: R },
  ): Promise<R> {
    const run = this.#queue.then(async () => {
      const { home, result } = change(await this.#read());
      await this.#store().set(LAYOUT_KEY, home);
      this.#changed();
      return result;
    });
    this.#queue = run.catch(() => {});
    return run;
  }
}

function at(home: PlacementRecord[], id: string): PlacementRecord {
  const found = home.find((placement) => placement.id === id);
  if (!found) throw new Refused("unknown", `No placement ${id}.`);
  return found;
}

/** `placement` after the one with id `after`: first for `null`, last for `undefined`. */
function insert(home: PlacementRecord[], placement: PlacementRecord, after?: string | null) {
  if (after === undefined) return [...home, placement];
  if (after === null) return [placement, ...home];
  const index = home.findIndex((other) => other.id === after);
  if (index < 0) throw new Refused("unknown", `No placement ${after}.`);
  return [...home.slice(0, index + 1), placement, ...home.slice(index + 1)];
}
