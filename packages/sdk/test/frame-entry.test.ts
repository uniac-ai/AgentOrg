import assert from "node:assert/strict";
import test from "node:test";
import { FRAME_HELLO, type PortLike } from "../src/frame-protocol.ts";

type Listener = (event: unknown) => void;

test("the frame takes one port, from its parent only, and sets theme tokens on its document", async () => {
  // The few browser globals the entry reads, as a frame's window has them.
  const listeners = new Map<string, Listener[]>();
  const parent = { name: "the shell" };
  const style = new Map<string, string>();
  const g = globalThis as Record<string, unknown>;
  g.parent = parent;
  g.document = {
    body: { root: true },
    documentElement: {
      style: { setProperty: (name: string, value: string) => style.set(name, value) },
    },
  };
  g.addEventListener = (type: string, listener: Listener) =>
    listeners.set(type, [...(listeners.get(type) ?? []), listener]);
  await import("../src/frame-entry.ts");
  const channels: InstanceType<typeof MessageChannel>[] = [];
  const channel = () => {
    const made = new MessageChannel();
    channels.push(made);
    return made;
  };
  try {
    const fire = (type: string, event: unknown) => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    };
    /** Whether a frame answers on this port: a reply to a load means it took the port. */
    const answers = async (port: PortLike) => {
      const replies: unknown[] = [];
      port.onmessage = (event) => void replies.push(event.data);
      port.postMessage({ op: "mount", id: 1, theme: {}, size: { width: 1, height: 1 } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      port.close();
      return replies.length > 0;
    };

    const stranger = channel();
    fire("message", {
      source: { name: "another window" },
      data: FRAME_HELLO,
      ports: [stranger.port2],
    });
    assert.equal(
      await answers(stranger.port1 as unknown as PortLike),
      false,
      "a hello from anyone but the parent",
    );

    const wrong = channel();
    fire("message", { source: parent, data: "frame/0", ports: [wrong.port2] });
    assert.equal(await answers(wrong.port1 as unknown as PortLike), false, "another hello");

    const first = channel();
    fire("message", { source: parent, data: FRAME_HELLO, ports: [first.port2] });
    const second = channel();
    fire("message", { source: parent, data: FRAME_HELLO, ports: [second.port2] });
    assert.equal(await answers(second.port1 as unknown as PortLike), false, "a second port");

    // The first port is the frame's: it imports the view from the URL it's given, and mounting sets
    // the theme's CSS variables, and only those, on the frame's document.
    const any = "{ safeParse: (data) => ({ success: true, data }) }";
    const method = `{ input: ${any}, output: ${any} }`;
    const view = `export default {
    agentorg: "agentorg.module/1", placement: "view", slots: {},
    exports: { view: { kind: "rpc", name: "ui.view", major: 1, events: {},
      methods: { mount: ${method}, resize: ${method}, unmount: ${method} } } },
    start(ctx) { ctx.exports.view.implement({ mount(el) { el.mounted = true; } }); },
  };`;
    const replies: { id: number; error?: unknown }[] = [];
    (first.port1 as unknown as PortLike).onmessage = (event) =>
      void replies.push(event.data as { id: number });
    first.port1.postMessage({
      op: "load",
      id: 1,
      src: `data:text/javascript,${encodeURIComponent(view)}`,
      self: { actorId: "act_view", module: "panel" },
      slots: {},
    });
    /** Until the reply to `id` came, a few seconds at most: a full run's load makes fixed waits flaky. */
    const replied = async (id: number) => {
      for (let waited = 0; !replies.some((reply) => reply.id === id); waited += 10) {
        if (waited > 5000) throw new Error(`No reply to ${id}.`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    await replied(1);
    first.port1.postMessage({
      op: "mount",
      id: 2,
      theme: { "--canvas": "rgb(20 20 20)", color: "red" },
      size: { width: 1, height: 1 },
    });
    await replied(2);
    assert.deepEqual(replies, [
      { op: "reply", id: 1, result: {} },
      { op: "reply", id: 2, result: {} },
    ]);
    assert.deepEqual([...style], [["--canvas", "rgb(20 20 20)"]]);
    assert.equal((g.document as { body: { mounted?: boolean } }).body.mounted, true);
  } finally {
    // Closing our end closes the frame's too, so nothing keeps the test's process alive.
    for (const made of channels) made.port1.close();
    for (const name of ["parent", "document", "addEventListener"]) delete g[name];
  }
});
