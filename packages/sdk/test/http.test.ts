import assert from "node:assert/strict";
import test from "node:test";
import { fetchOver, serveOver } from "../src/client-http.ts";
import type { Duplex } from "../src/module.ts";

const text = new TextEncoder();
const quiet = { info() {}, warn() {}, error() {} };

/** A stream whose other end is played by the test: `incoming` is what it reads, `sent` what it wrote. */
function streamOf(incoming: string) {
  let sent = "";
  const decoder = new TextDecoder();
  const stream: Duplex = {
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(text.encode(incoming));
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        sent += decoder.decode(chunk, { stream: true });
      },
    }),
  };
  return { stream, sent: () => sent };
}

const until = async (condition: () => boolean) => {
  for (let waited = 0; !condition(); waited += 5) {
    if (waited > 5000) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("serve answers 400 to a request line that isn't absolute, or names another host", async () => {
  let handled = 0;
  for (const head of [
    "GET /x HTTP/1.1\r\nHost: web\r\n\r\n",
    "GET https://other/x HTTP/1.1\r\nHost: web\r\n\r\n",
    "GET ftp://web/x HTTP/1.1\r\nHost: web\r\n\r\n",
  ]) {
    const { stream, sent } = streamOf(head);
    void serveOver(
      stream,
      async () => {
        handled++;
        return new Response("no");
      },
      quiet,
    );
    await until(() => sent().includes("\r\n\r\n"));
    assert.match(sent(), /^HTTP\/1\.1 400 /, head);
  }
  assert.equal(handled, 0, "the handler never saw them");

  const { stream, sent } = streamOf("GET https://web/x?y=1 HTTP/1.1\r\nHost: web\r\n\r\n");
  void serveOver(stream, async (request) => new Response(request.url), quiet);
  await until(() => sent().includes("https://web/x?y=1"));
  assert.match(sent(), /^HTTP\/1\.1 200 /);
});

test("fetch throws an SDK error only for a 502 whose error header names one of the three", async () => {
  const respond = (status: number, header?: string) =>
    `HTTP/1.1 ${status} X\r\n${header === undefined ? "" : `agentorg-error: ${header}\r\n`}content-length: 0\r\n\r\n`;
  const fetched = (raw: string) =>
    fetchOver(streamOf(raw).stream, new Request("https://web/x"), "web");

  await assert.rejects(
    fetched(respond(502, JSON.stringify({ name: "Refused", message: "no", code: "forbidden" }))),
    { name: "Refused", code: "forbidden", message: "no" },
  );
  await assert.rejects(
    fetched(respond(502, JSON.stringify({ name: "NotConnected", message: "" }))),
    {
      name: "NotConnected",
    },
  );
  // A 205 has no body, and a status no response can have is an error, never a throw.
  const reset = await fetched("HTTP/1.1 205 Reset\r\ncontent-length: 5\r\n\r\nhello");
  assert.equal(reset.status, 205);
  assert.equal(await reset.text(), "");
  await assert.rejects(fetched("HTTP/1.1 600 Odd\r\ncontent-length: 0\r\n\r\n"), {
    name: "OutcomeUnknown",
  });
  // Anything else is an ordinary response.
  for (const [status, header] of [
    [500, JSON.stringify({ name: "Refused", message: "no" })],
    [502, JSON.stringify({ name: "Error", message: "no" })],
    [502, "not json"],
    [502, undefined],
  ] as const) {
    const response = await fetched(respond(status, header));
    assert.equal(response.status, status);
  }
});
