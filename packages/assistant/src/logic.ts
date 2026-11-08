// The assistant's logic: its chat, its agent loop, and its connections as its tools.
import {
  chat,
  hubActors,
  hubExports,
  hubGrants,
  hubPackages,
  installer,
  kv,
  layout,
  llmSession,
} from "@agentorg/interfaces";
import { defineActor, describeInterface, Refused } from "@agentorg/sdk";
import { createAgent } from "./agent.js";
import { createHistory } from "./history.js";
import { type ToolSlot, toolsOf } from "./tools.js";

/** The slots that become tools; `model` and `store` are the assistant's own. */
const tools = {
  layout,
  packages: hubPackages,
  actors: hubActors,
  grants: hubGrants,
  exports: hubExports,
  installer,
};

/** Where the agent keeps the model chosen for it, beside its record in the store. */
const MODEL_KEY = "settings/model";

/** A whole package, as `packages__build` takes it: the instructions' example, built by a test. */
export const EXAMPLE: Record<string, string> = {
  "package.json": `${JSON.stringify(
    {
      name: "counter",
      version: "0.1.0",
      private: true,
      type: "module",
      agentorg: {
        modules: { logic: "src/logic.ts", panel: "src/panel.ts" },
        connections: [["panel.counter", "logic.counter"]],
      },
    },
    null,
    2,
  )}\n`,
  "src/interface.ts": `import { defineInterface, event, method } from "@agentorg/sdk";
import { z } from "zod";

const Count = z.object({ value: z.number() });
export const counter = defineInterface({
  name: "counter",
  major: 1,
  kind: "rpc",
  methods: {
    get: method({ input: z.object({}), output: Count }),
    increment: method({ input: z.object({}), output: Count }),
  },
  events: { changed: event(Count) },
});
`,
  "src/logic.ts": `import { kv } from "@agentorg/interfaces";
import { defineActor } from "@agentorg/sdk";
import { counter } from "./interface.ts";

export default defineActor({
  slots: { store: kv },
  exports: { counter },
  start(ctx) {
    const read = async () => {
      const { value } = await ctx.slots.store.call.get({ key: "count" });
      return typeof value === "number" ? value : 0;
    };
    ctx.exports.counter.implement({
      get: async () => ({ value: await read() }),
      increment: async () => {
        const value = (await read()) + 1;
        await ctx.slots.store.call.set({ key: "count", value });
        ctx.exports.counter.emit("changed", { value });
        return { value };
      },
    });
  },
});
`,
  "src/panel.ts": `import { uiView } from "@agentorg/interfaces";
import { defineWidget } from "@agentorg/sdk";
import { counter } from "./interface.ts";

export default defineWidget({
  slots: { counter },
  exports: { view: uiView },
  start(ctx) {
    ctx.exports.view.implement({
      mount(el) {
        const button = el.ownerDocument.createElement("button");
        // A call can fail (its Actor may be starting): say so, and draw again when it's back.
        const draw = () =>
          ctx.slots.counter.call.get({}).then(
            ({ value }) => {
              button.textContent = String(value);
            },
            () => {
              button.textContent = "…";
            },
          );
        button.addEventListener("click", () => {
          ctx.slots.counter.call.increment({}).catch(() => void draw());
        });
        el.replaceChildren(button);
        const off = ctx.slots.counter.on("changed", () => void draw());
        const offBind = ctx.slots.counter.onBind(() => void draw());
        if (ctx.slots.counter.bound) void draw();
        return () => {
          off();
          offBind();
        };
      },
    });
  },
});
`,
};

/** A view on the kit, as an agent writes one: React mounted into the view's element. */
export const KIT_EXAMPLE = `import { uiView } from "@agentorg/interfaces";
import { Button, Stack } from "@agentorg/kit";
import { defineWidget } from "@agentorg/sdk";
import { useState } from "react";
import { createRoot } from "react-dom/client";

function Panel() {
  const [count, setCount] = useState(0);
  return (
    <Stack>
      <p>Pressed {count} times.</p>
      <Button onClick={() => setCount(count + 1)}>Press</Button>
    </Stack>
  );
}

export default defineWidget({
  exports: { view: uiView },
  start(ctx) {
    ctx.exports.view.implement({
      mount(el) {
        const root = createRoot(el as Element);
        root.render(<Panel />);
        return () => root.unmount();
      },
    });
  },
});
`;

/** What the assistant is always told. */
export const BASE_INSTRUCTIONS = `You are an assistant in AgentOrg, working for the person who created you.
You act only through your tools, and your tools are exactly the connections the person gave you. If something needs a connection you don't have, say which.
Before you promise to do something, check that one of your tools does it. A connection you are given later shows up as new tools at your next turn; until then, don't say you can use it.
To show the person a widget, place a view module of a running Actor on their dashboard with layout__place; actors__list and actors__get find the Actors.
Keep replies short and plain.`;

/** How to make an Actor: told only when it can, with `packages` and `installer` both bound. */
export const MAKING_INSTRUCTIONS = `## Making a new Actor
When the person asks for something no running Actor does, you can write a package and add it:
1. Write the package's files and call packages__build with them as {files: {path: text}}. A build that fails says why: fix the files and build again.
2. Call installer__plan with the hash it returns, to see each slot's interface and what could serve it.
3. Call installer__install with the hash, a name, and an explicit connection for each slot you want bound, as {"module.slot": {actor, export}}; start: true runs it. A kv@1 store connects to {actor: "storage", export: "kv"}.
4. Call layout__place with the new Actor's id and its view module, so the person sees it.

Making or installing an Actor gives you no access to it. To operate it yourself, it must be exposed to you: in steps 2 and 3, pass expose: [{export: "<module>.<export>", to: <your Actor id>}] for each of its exports you need (only an rpc export of a host module can be exposed); installer__plan's exposes says how each would settle. installer__install's result lists exposures: one that settles "granted" is yours now; for one that settles "request", call grants__expose with exactly its call. That files your request: the person approves it on Home, or a rule they turned on approves it. Tell the person it is waiting on Home, and use grants__mine to see how it stands. Once approved, the Actor's methods are among your tools at your next turn.

## The package format
A package is a package.json and TypeScript files under src/ (.tsx for JSX). They may import only @agentorg/sdk, @agentorg/interfaces, zod, react, react-dom and @agentorg/kit, and the package's own files by relative path with their extension (.ts or .tsx).
- package.json: {"name", "version", "private": true, "type": "module", "agentorg": {"modules": {"<module>": "src/<file>.ts"}, "connections": [["<module>.<slot>", "<module>.<export>"]]}}. Module names are lower camel case. connections wires the package's own modules to each other, such as a view to its logic.
- A host module is a file whose default export is defineActor({slots, exports, start(ctx)}), from @agentorg/sdk. It runs in its own process, with no files, network or environment: what must outlast a restart goes in a kv@1 slot, never only in memory. Its top level only defines things; work starts in start. ctx.slots.<slot>.call.<method>(input) calls what a slot is bound to, ctx.slots.<slot>.bound says whether it is bound, and ctx.slots.<slot>.onBind(fn) runs fn when it is bound again; ctx.exports.<export>.implement({method: async (input) => output}) serves an export, and ctx.exports.<export>.emit(event, payload) tells its subscribers.
- A view module (a widget) is a file whose default export is defineWidget({slots, exports: {view: uiView}, start(ctx)}). In start, ctx.exports.view.implement({mount(el) { ...; return cleanup }}) draws into el with the DOM; it has no network and no storage of its own, so it reads and changes everything through its slots. Its frame is sandboxed: a form never submits (handle Enter or a click instead), alert, confirm and prompt do nothing, and images load only from data: or blob: addresses. ctx.slots.<slot>.on(event, fn) subscribes, and returns a function that stops it. Widgets fill the space they are placed in; never size one to its content. Plain HTML already looks like the app: use semantic elements, no background. For components, import from @agentorg/kit (Button, Switch, Field, List, Table, Card, Meter, Markdown, Stack, Fill, Scroll, Chat), in a .tsx view that mounts with React, as the kit example below shows. Use the theme tokens (var(--fg), var(--muted), var(--surface), var(--accent), var(--radius) …) for anything custom. A widget may draw its own look when the person asks for one.
- An interface is defineInterface({name, major: 1, kind: "rpc", methods: {name: method({input, output})}, events: {name: event(payload)}}) with zod objects, in its own file. kv and uiView come from @agentorg/interfaces: kv@1 is get({key}) → {value?} (value absent when unset), set({key, value}) for any JSON value, delete({key}) → {deleted}, and list({prefix?, after?, limit?}) → {keys, next}: keys only, a page at a time. An interface's name is lowercase words joined by dots, such as "counter" or "todo.list".

For example, a counter, as packages__build takes its files:
${Object.entries(EXAMPLE)
  .map(([path, text]) => `--- ${path}\n${text}`)
  .join("\n")}
Install it with connections {"logic.store": {"actor": "storage", "export": "kv"}} and start: true, then place its "panel".

A view on the kit, src/panel.tsx (in package.json's modules as "panel": "src/panel.tsx"):
${KIT_EXAMPLE}`;

/** Everything it can be told. */
export const INSTRUCTIONS = `${BASE_INSTRUCTIONS}\n\n${MAKING_INSTRUCTIONS}`;

export default defineActor({
  slots: { model: llmSession, store: kv, ...tools },
  exports: { chat },
  start(ctx) {
    const history = createHistory(ctx.slots.store.call, ctx.log);
    ctx.slots.store.onBind(() => history.reset());
    ctx.slots.store.onUnbind(() => history.reset());
    /** The model chosen for this agent, if any; read for each request. */
    const chosen = async () => {
      const { value } = await ctx.slots.store.call.get({ key: MODEL_KEY });
      return typeof value === "string" ? value : undefined;
    };
    const described = (Object.keys(tools) as (keyof typeof tools)[]).map(
      (name) => [name, describeInterface(tools[name])] as const,
    );
    const agent = createAgent({
      instructions: () =>
        `${ctx.slots.packages.bound && ctx.slots.installer.bound ? INSTRUCTIONS : BASE_INSTRUCTIONS}\n\nYour Actor id is ${ctx.self.actorId}.`,
      model: ctx.slots.model,
      chosenModel: chosen,
      history,
      // Its package's slots, then those exposed to it at run time: every bound slot is tools.
      tools: () =>
        toolsOf({
          ...Object.fromEntries(
            ctx
              .exposed()
              .map((exposed) => [
                exposed.slot,
                { described: exposed.described, slot: { bound: true, call: exposed.call } },
              ]),
          ),
          ...Object.fromEntries(
            described.map(([name, schemas]) => [
              name,
              { described: schemas, slot: ctx.slots[name] satisfies ToolSlot },
            ]),
          ),
        }),
      chat: {
        message: (message) => ctx.exports.chat.emit("message", message),
        delta: (id, text) => ctx.exports.chat.emit("delta", { id, text }),
        status: (status) => ctx.exports.chat.emit("status", status),
      },
      log: ctx.log,
    });
    ctx.slots.model.on("delta", ({ requestId, text }) => agent.delta(requestId, text));
    ctx.exports.chat.implement({
      send: ({ text }) => agent.send(text),
      history: ({ before, limit }) => history.page(before, limit ?? 50),
      cancel: async () => {
        await agent.cancel();
        return {};
      },
      state: () => agent.state(),
      retry: () => agent.retry(),
      models: async () => {
        const [{ models }, current] = await Promise.all([
          ctx.slots.model.call.models({}),
          chosen(),
        ]);
        return { models, ...(current ? { current } : {}) };
      },
      setModel: async ({ model }) => {
        if (!model) {
          await ctx.slots.store.call.delete({ key: MODEL_KEY });
          return {};
        }
        const { models } = await ctx.slots.model.call.models({});
        if (!models.some((offered) => offered.id === model))
          throw new Refused("unknown", `${model} isn't one of the models offered.`);
        await ctx.slots.store.call.set({ key: MODEL_KEY, value: model });
        return {};
      },
    });
  },
});
