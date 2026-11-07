// The person's named rules: conveniences the person turns on, held by the gateway, which acts on a
// rule that is on as the person (a manager) and only within what the person could grant. Each rule
// is named and visible, and off until the person turns it on; nothing else acts on provenance.
import { Refused } from "@agentorg/sdk";
import type { PersonSide } from "./api.js";

/** Where the rules that are on are kept, in the person's store: `{<id>: {on}}`. */
export const RULES_KEY = "app/rules";

/** An exposure a request asks for: `provider`'s `export`, as a slot on `to`. */
export interface Exposure {
  provider: string;
  export: string;
  to: string;
  as?: string;
}

/** An open request, as `hub.grants` tells it. */
export interface Request {
  requestId: string;
  [field: string]: unknown;
}

/**
 * The exposure an open request asks for, if it asks for one. The one place that reads the Hub's
 * request shape for exposures.
 */
export function exposureOf(request: Request): Exposure | undefined {
  const { exposed, provider, export: name, consumer, slot } = request as Record<string, unknown>;
  if (exposed !== true) return undefined;
  if (typeof provider !== "string" || typeof name !== "string" || typeof consumer !== "string")
    return undefined;
  return {
    provider,
    export: name,
    to: consumer,
    ...(typeof slot === "string" ? { as: slot } : {}),
  };
}

interface Definition {
  id: string;
  name: string;
  says: string;
  /** Whether this rule approves the exposure, read from the Hub as the person. */
  approves(exposure: Exposure, person: PersonSide): Promise<boolean>;
}

/** The rules the app knows, in the order Settings lists them. */
export const DEFINITIONS: readonly Definition[] = [
  {
    id: "agents-use-what-they-install",
    name: "Let an agent use what it installs",
    says: "When an agent asks to use an Actor it installed, approve it.",
    async approves(exposure, person) {
      // Provenance only: who the installer installed it for. The Hub grants nothing from it.
      const actor = (await person.call("actors", "get", { actorId: exposure.provider })) as {
        state?: string;
        installedFor?: string;
      };
      return actor.state !== "closed" && actor.installedFor === exposure.to;
    },
  },
];

export interface RulesOptions {
  person: PersonSide;
  /** Where the rules say what they approved, and what they couldn't. */
  log?: (message: string) => void;
  /** Told after a rule is turned on or off. */
  changed?: () => void;
}

/**
 * The rules, for `app.rules@1`, and their engine: it hears each request the person could approve,
 * and goes through the open ones at start and whenever a rule is turned on. It approves a request a
 * rule that is on matches, as an approver does, with the call the request asked for; the Hub checks
 * that the person could grant it. It never declines: anything no rule matches stays for the person.
 */
export class Rules {
  readonly #person: PersonSide;
  readonly #log: (message: string) => void;
  readonly #changed: () => void;
  /** Requests being settled, so an event and a sweep don't settle one twice. */
  readonly #settling = new Set<string>();
  #stop: (() => void) | undefined;

  constructor(options: RulesOptions) {
    this.#person = options.person;
    this.#log = options.log ?? (() => {});
    this.#changed = options.changed ?? (() => {});
  }

  /** The ids of the rules that are on. */
  async #on(): Promise<Set<string>> {
    const { value } = (await this.#person.call("store", "get", { key: RULES_KEY })) as {
      value?: unknown;
    };
    const held = typeof value === "object" && value !== null ? value : {};
    return new Set(
      DEFINITIONS.filter(
        (rule) => (held as Record<string, { on?: unknown }>)[rule.id]?.on === true,
      ).map((rule) => rule.id),
    );
  }

  async list() {
    const on = await this.#on();
    return {
      rules: DEFINITIONS.map(({ id, name, says }) => ({ id, name, says, on: on.has(id) })),
    };
  }

  async set({ id, on }: { id: string; on: boolean }) {
    if (!DEFINITIONS.some((rule) => rule.id === id))
      throw new Refused("unknown", `There is no rule ${id}.`);
    const now = await this.#on();
    if (on) now.add(id);
    else now.delete(id);
    await this.#person.call("store", "set", {
      key: RULES_KEY,
      value: Object.fromEntries([...now].map((ruleId) => [ruleId, { on: true }])),
    });
    this.#changed();
    // Turned on, it settles what already waits for it.
    if (on) await this.sweep();
    return {};
  }

  /** Hear each new request, and settle the open ones. */
  async start() {
    await this.sweep();
  }

  /** Hear each new request, once; heard again after a subscription that ended. */
  #listen() {
    this.#stop ??= this.#person.subscribe(
      "grants",
      "requested",
      (request) => void this.#settle(request as Request),
      () => {
        this.#stop = undefined;
      },
    );
  }

  close() {
    this.#stop?.();
    this.#stop = undefined;
  }

  /** Go through every open request the person could approve. */
  async sweep() {
    this.#listen();
    const { requests } = (await this.#person.call("grants", "requests", {})) as {
      requests: Request[];
    };
    for (const request of requests) await this.#settle(request);
  }

  async #settle(request: Request) {
    const exposure = exposureOf(request);
    if (!exposure || this.#settling.has(request.requestId)) return;
    this.#settling.add(request.requestId);
    try {
      const on = await this.#on();
      for (const rule of DEFINITIONS) {
        if (!on.has(rule.id) || !(await rule.approves(exposure, this.#person))) continue;
        // As an approver approves: the call the request asked for, checked by the Hub.
        await this.#person.call("grants", "expose", exposure);
        this.#log(
          `Rule "${rule.name}" approved ${exposure.provider}'s ${exposure.export} for ${exposure.to}.`,
        );
        return;
      }
    } catch (error) {
      this.#log(
        `A rule couldn't settle request ${request.requestId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.#settling.delete(request.requestId);
    }
  }
}
