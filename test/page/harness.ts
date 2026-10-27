/** The app over a real service in a temporary store, signed in as a browser would be. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { createApp } from "../../src/app.ts";
import { OPERATIONS, type RequestOf } from "../../src/contract/index.ts";
import type { Caller, Service } from "../../src/operations/index.ts";
import { StoreService } from "../../src/operations/service.ts";
import { CSRF_HEADER } from "../../src/page/types.ts";
import { Store } from "../../src/store/index.ts";

const directory = mkdtempSync(join(tmpdir(), "agentorg-page-"));
after(() => rmSync(directory, { recursive: true, force: true }));
let count = 0;

const mcp = (clientSessionId: string): Caller => ({
  channel: "mcp",
  client: "claude-code",
  clientSessionId,
});
const parse = <N extends keyof typeof OPERATIONS>(name: N, request: unknown) =>
  OPERATIONS[name].request.parse(request) as RequestOf<N>;

export async function harness() {
  const service = new StoreService(new Store(join(directory, `${++count}.db`)));
  /** The user operations the page called, with their requests and callers. */
  const calls: [string, unknown, Caller][] = [];
  const recording = new Proxy(service, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver);
      if (typeof name !== "string" || !name.endsWith("_as_user")) return value;
      return (request: unknown, caller: Caller) => {
        calls.push([name, request, caller]);
        return value.call(target, request, caller);
      };
    },
  }) as Service;
  const app = createApp(recording, { token: "agents-token" });

  const link = await service.ui_login_link({}, { channel: "api" });
  const login = await app.request(link.path);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const pageSession = await service.getPageSession(cookie.split("=")[1] ?? "");
  const csrf = pageSession?.csrf_token ?? "";

  const get = (path: string) => app.request(path, { headers: { Cookie: cookie } });
  const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        [CSRF_HEADER]: csrf,
        ...headers,
      },
      body: JSON.stringify(body),
    });

  /** A lead under the user, a child under it, a session for each, and helpers to ask and send. */
  async function organization() {
    const lead = await service.session_attach(
      parse("session_attach", { new_agent: { title: "Release lead", purpose: "Ship 1.0." } }),
      mcp("lead"),
    );
    const child = await service.agent_create(
      parse("agent_create", { session: lead.session.id, title: "Storage", purpose: "To SQLite." }),
      mcp("lead"),
    );
    const store = await service.session_attach(
      parse("session_attach", { agent: child.id }),
      mcp("c"),
    );
    const ask = (session: string, title: string, escalates: string[] = []) =>
      service.ask_open(
        parse("ask_open", {
          session,
          title,
          context: "Context.",
          options: [{ label: "Keep" }, { label: "Delete" }],
          recommendation: "Keep",
          escalates,
        }),
        mcp("x"),
      );
    const send = (session: string, kind: "note" | "report", body: string) =>
      service.message_send(parse("message_send", { session, kind, body }), mcp("x"));
    return { lead, child, store, ask, send };
  }

  return { service, app, calls, cookie, csrf, login, get, post, organization };
}
