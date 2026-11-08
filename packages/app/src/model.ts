// The app's first run: the bundled packages, the installer the person bootstraps, the model Actor
// installed through it, and the person's `login` bound to that model. Every step reads what is
// there before it acts, so each start converges on the same system and makes nothing twice.
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How the first run reaches the Hub: the person's own calls, as `/api` makes them. A call that
 * doesn't reach its provider rejects with an error named `NotConnected`, as `/api` names it.
 */
export interface PersonCalls {
  call(slot: string, method: string, input: unknown): Promise<unknown>;
}

/** An export of a running Actor. */
export interface Target {
  actor: string;
  export: string;
}

export interface FirstRunOptions {
  /** Where the bundled archives and their `index.json` are; the app's own by default. */
  bundled?: string;
  /** What the model Actor's `web` connects to: the built-in `net`'s `egress` by default. */
  egress?: Target;
  /** Where the first run says what it did, and what it couldn't. */
  log?: (message: string) => void;
  /**
   * Whether an Actor's process is connected (the Hub's `connected`): the first run waits for the
   * installer's before it installs through it. Without it, it installs at once.
   */
  connected?: (actorId: string) => boolean;
}

export interface FirstRun {
  /** The bundled packages by name, each added. */
  packages: Record<string, string>;
  /** The installer Actor and the model Actor, when they exist. */
  installer?: string;
  chatgpt?: string;
}

/** The app's bundled packages, built into `dist/bundled` with the app. */
const BUNDLED = join(dirname(fileURLToPath(import.meta.url)), "..", "bundled");
const PERSON = "person";
/** How long the first run waits for the installer's process to connect, and how often it looks. */
const CONNECT_MS = 30_000;
const CONNECT_EVERY_MS = 100;
/**
 * Where the first run keeps the Actors it made, in the person's store: it trusts those, never an
 * Actor because of the name its package gives itself, which any package can take.
 */
const RECORD = "app/first-run";
/** The installer's own module, and the model's. */
const INSTALLER = "installer";
const CHATGPT = "chatgpt";
/**
 * The installer's slots, each bound explicitly by the person at first run: the Hub's management
 * (it is the person's delegated manager), seeding new Actors' stores, and the person's layout.
 */
const INSTALLER_BINDINGS: { slot: string; provider: string; export: string }[] = [
  ...["packages", "actors", "grants", "exports", "bindings"].map((name) => ({
    slot: `installer.${name}`,
    provider: "hub",
    export: name,
  })),
  { slot: "installer.storage", provider: "storage", export: "admin" },
  { slot: "installer.layout", provider: PERSON, export: "layout" },
];

type Actor = { actorId: string; name: string; package: string; state: string };
type Binding = { consumer: string; slot: string; provider: string; export: string };

/**
 * The first run, at every start after the person's store is bound: add the bundled packages,
 * ensure the installer (made by the person, with its bindings, started), bind the person's
 * `installer` to it, ensure the model Actor installed through it (`web` to `egress`, `store` to
 * storage's `kv`, started), and bind the person's `login` to the model's. What earlier runs made
 * (recorded in the person's store) is kept and brought to this build: an installer or model Actor
 * on another package is upgraded in place, with its id, its store and its bindings; so is an agent
 * on an assistant build an earlier run bundled (by the hashes recorded, never by a package's
 * name). A binding an upgrade drops, its interface having changed, is made again where its ends
 * match now. A step that fails is logged and the rest still runs where it can; the next start
 * tries again.
 */
export async function firstRun(
  person: PersonCalls,
  options: FirstRunOptions = {},
): Promise<FirstRun> {
  const log = options.log ?? (() => {});
  const call = <T>(slot: string, method: string, input: unknown = {}) =>
    person.call(slot, method, input) as Promise<T>;
  const attempt = async <T>(what: string, run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      log(
        `First run: ${what} didn't work: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  };

  const bundled = options.bundled ?? BUNDLED;
  const index = JSON.parse(readFileSync(join(bundled, "index.json"), "utf8")) as Record<
    string,
    string
  >;
  const packages: Record<string, string> = {};
  for (const [name, file] of Object.entries(index)) {
    const added = await attempt(`adding ${name}`, () =>
      call<{ hash: string }>("packages", "add", { path: join(bundled, file) }),
    );
    if (added) packages[name] = added.hash;
  }

  // What earlier runs made, by role, kept while it isn't closed. Unread, nothing is made: a run that
  // couldn't see its record would make a second installer.
  const read = (await call<{ value?: unknown }>("store", "get", { key: RECORD })).value;
  const kept = (read ?? {}) as Record<string, unknown>;
  const record: {
    installer?: string;
    chatgpt?: string;
    assistant?: string;
    assistants?: string[];
  } = Object.fromEntries(
    Object.entries(kept).filter(
      ([role, id]) => (role === "installer" || role === "chatgpt") && typeof id === "string",
    ),
  );
  const remember = (role: "installer" | "chatgpt", actorId: string) => {
    record[role] = actorId;
    return call("store", "set", { key: RECORD, value: { ...record } });
  };
  // Every assistant build a run has bundled, by hash: an agent on one of them is this app's to
  // bring to this build. Never a package by its name, which an agent's own package could take.
  const earlier = [
    ...(Array.isArray(kept.assistants) ? kept.assistants : []),
    kept.assistant,
  ].filter((hash): hash is string => typeof hash === "string");
  // The assistant New agent installs is this build's, by hash.
  if (packages.assistant) {
    record.assistant = packages.assistant;
    record.assistants = [...new Set([...earlier, packages.assistant])];
    await attempt("recording the assistant", () =>
      call("store", "set", { key: RECORD, value: { ...record } }),
    );
  }
  /** What upgrades dropped, their interfaces having changed: made again once all are done. */
  const dropped: Binding[] = [];
  /** Run this build's package as an Actor an earlier run made, keeping its id and its store. */
  const upgrade = async (actor: Actor, hash: string, what: string): Promise<Actor> => {
    const { dropped: lost } = await call<{ dropped: Binding[] }>("actors", "upgrade", {
      actorId: actor.actorId,
      package: hash,
    });
    dropped.push(...lost);
    log(
      `First run: upgraded ${what} (${actor.actorId}) to this build${lost.length ? `; ${lost.length} of its bindings to make again` : ""}.`,
    );
    return { ...actor, package: hash };
  };
  /** The Actor an earlier run made for `role`, unless it is gone or closed. */
  const madeBefore = async (role: "installer" | "chatgpt") => {
    const id = record[role];
    if (!id) return undefined;
    const { actors } = await call<{ actors: Actor[] }>("actors", "list");
    return actors.find((a) => a.actorId === id && a.state !== "closed");
  };
  const running = async (actor: Actor) => {
    if (actor.state !== "running") await call("actors", "start", { actorId: actor.actorId });
  };
  const bindingsOf = async (actor: string) =>
    (await call<{ bindings: Binding[] }>("bindings", "list", { actor })).bindings.filter(
      (b) => b.consumer === actor,
    );
  /**
   * Made before: each of these slots it lost is bound again, if its package declares the slot (an
   * older build may not); one bound to another is kept.
   */
  const rebind = async (actor: Actor, bindings: typeof INSTALLER_BINDINGS) => {
    const { manifest } = await call<{ manifest: { modules: Record<string, { slots: object }> } }>(
      "packages",
      "get",
      { hash: actor.package },
    );
    const declared = (slot: string) => {
      const [module = "", name = ""] = slot.split(".");
      return Object.hasOwn(manifest.modules[module]?.slots ?? {}, name);
    };
    const held = new Set((await bindingsOf(actor.actorId)).map((b) => b.slot));
    for (const binding of bindings)
      if (!held.has(binding.slot) && declared(binding.slot))
        await call("grants", "bind", { consumer: actor.actorId, ...binding });
  };
  /** Bind the person's `slot` to `target`, unless it is bound already (to it, or to another). */
  const personSlot = async (slot: string, target: Target) => {
    if ((await bindingsOf(PERSON)).some((b) => b.slot === slot)) return;
    await call("grants", "bind", {
      consumer: PERSON,
      slot,
      provider: target.actor,
      export: target.export,
    });
  };

  const installer = await attempt("the installer", async () => {
    let actor = await madeBefore("installer");
    if (!actor) {
      const hash = packages[INSTALLER];
      if (!hash) return undefined;
      const { actorId } = await call<{ actorId: string }>("actors", "create", {
        name: "Installer",
        package: hash,
        bindings: INSTALLER_BINDINGS,
      });
      await remember("installer", actorId);
      log("First run: made the installer.");
      actor = { actorId, name: "Installer", package: hash, state: "created" };
    } else {
      const hash = packages[INSTALLER];
      if (hash && actor.package !== hash) actor = await upgrade(actor, hash, "the installer");
      await rebind(actor, INSTALLER_BINDINGS);
    }
    await personSlot("installer", { actor: actor.actorId, export: "installer.installer" });
    await running(actor);
    return actor.actorId;
  });

  const egress = options.egress ?? { actor: "net", export: "egress" };
  const chatgptBindings = [
    { slot: "model.web", provider: egress.actor, export: egress.export },
    { slot: "model.store", provider: "storage", export: "kv" },
  ];
  const chatgpt = await attempt("ChatGPT", async () => {
    let actor = await madeBefore("chatgpt");
    if (actor) {
      const hash = packages[CHATGPT];
      if (hash && actor.package !== hash) actor = await upgrade(actor, hash, "ChatGPT");
      await rebind(actor, chatgptBindings);
      await running(actor);
      return actor.actorId;
    }
    const hash = packages[CHATGPT];
    if (!hash || !installer) return undefined;
    // The installer's process may still be connecting: wait for it, then install once.
    const { connected } = options;
    if (connected) {
      const until = Date.now() + CONNECT_MS;
      while (!connected(installer)) {
        if (Date.now() > until)
          throw new Error("the installer's process didn't connect; the next start tries again.");
        await new Promise((done) => setTimeout(done, CONNECT_EVERY_MS));
      }
    }
    const { actorId } = await call<{ actorId: string }>("installer", "install", {
      package: hash,
      name: "ChatGPT",
      connections: Object.fromEntries(
        chatgptBindings.map((b) => [b.slot, { actor: b.provider, export: b.export }]),
      ),
      start: true,
    });
    await remember("chatgpt", actorId);
    log("First run: installed ChatGPT.");
    return actorId;
  });
  if (chatgpt)
    await attempt("binding the login", () =>
      personSlot("login", { actor: chatgpt, export: "model.login" }),
    );

  // Agents on an assistant build an earlier run bundled: brought to this build's assistant.
  const assistant = packages.assistant;
  if (assistant) {
    const agents = await attempt("finding agents on earlier builds", async () =>
      (await call<{ actors: Actor[] }>("actors", "list")).actors.filter(
        (a) => a.state !== "closed" && a.package !== assistant && earlier.includes(a.package),
      ),
    );
    for (const agent of agents ?? [])
      await attempt(`upgrading ${agent.name}`, () =>
        upgrade(agent, assistant, `the agent ${agent.name}`),
      );
  }
  // What the upgrades dropped, made again where its slot is still unbound: the ends now match,
  // both on this build. One whose ends still don't is logged and left.
  for (const wiring of dropped)
    await attempt(`binding ${wiring.slot} again`, async () => {
      if ((await bindingsOf(wiring.consumer)).some((b) => b.slot === wiring.slot)) return;
      await call("grants", "bind", wiring);
      log(`First run: bound ${wiring.consumer}'s ${wiring.slot} again.`);
    });

  return {
    packages,
    ...(installer ? { installer } : {}),
    ...(chatgpt ? { chatgpt } : {}),
  };
}

/** What the sign-in tab says, by outcome: `complete`'s refusal code, or `signed_in`. */
const SAYS: Record<string, string> = {
  signed_in: "Signed in to ChatGPT. You can close this tab.",
  denied: "You declined on ChatGPT's page. Start again from AgentOrg when you're ready.",
  expired: "This sign-in expired. Start again from AgentOrg.",
};
const FAILED = "The sign-in didn't work. Start again from AgentOrg.";

/**
 * `/oauth/chatgpt`: where ChatGPT sends the browser back. It hands the whole callback address to
 * the person's `login.complete`, then sends the tab on to `?result=<outcome>`, an address without
 * the sign-in's code, so the code stays out of the tab's address and history; that page says how
 * it went and links back to the shell. The code is never logged or shown, and no page sends a
 * referrer.
 */
export function oauthRoute(person: PersonCalls) {
  return (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (request.method !== "GET") return void response.writeHead(405).end();
    const result = url.searchParams.get("result");
    if (result !== null && [...url.searchParams.keys()].length === 1)
      return page(
        response,
        result === "signed_in" ? 200 : 400,
        Object.hasOwn(SAYS, result) ? (SAYS[result] as string) : FAILED,
      );
    const after = (outcome: string) => {
      response.writeHead(303, {
        Location: `${url.pathname}?result=${encodeURIComponent(outcome)}`,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      response.end();
    };
    void person.call("login", "complete", { callbackUrl: url.href }).then(
      () => after("signed_in"),
      (error: unknown) => {
        const code = (error as { code?: unknown } | undefined)?.code;
        after(typeof code === "string" && Object.hasOwn(SAYS, code) ? code : "failed");
      },
    );
  };
}

function page(response: ServerResponse, status: number, text: string) {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>AgentOrg</title>` +
      `<style>body{font:15px system-ui,sans-serif;margin:20vh auto;max-width:28rem;padding:0 16px}</style>` +
      `<p>${text}</p><p><a href="/">Back to AgentOrg</a></p>`,
  );
}
