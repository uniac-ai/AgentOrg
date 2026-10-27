import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createApp } from "../../src/app.ts";
import { OPERATIONS, type RequestOf } from "../../src/contract/index.ts";
import type { Caller } from "../../src/operations/index.ts";
import { StoreService } from "../../src/operations/service.ts";
import { Store } from "../../src/store/index.ts";

const directory = mkdtempSync(join(tmpdir(), "agentorg-page-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const mcp = (clientSessionId: string): Caller => ({
  channel: "mcp",
  client: "claude-code",
  clientSessionId,
});
const parse = <N extends keyof typeof OPERATIONS>(name: N, request: unknown) =>
  OPERATIONS[name].request.parse(request) as RequestOf<N>;

test("over the real service, the user answers an escalation, steps in, and acknowledges a report", async () => {
  const service = new StoreService(new Store(join(directory, "agentorg.db")));
  const app = createApp(service, { token: "agents-token" });
  const options = [{ label: "Keep" }, { label: "Delete" }];

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
        options,
        recommendation: "Keep",
        escalates,
      }),
      mcp("x"),
    );
  const lower = await ask(store.session.id, "Delete the files?");
  const carried = await ask(lead.session.id, "May the files go?", [lower.id]);
  const second = await ask(store.session.id, "Keep the index?");
  await service.message_send(
    parse("message_send", { session: lead.session.id, kind: "report", body: "Phase one is done." }),
    mcp("lead"),
  );

  const link = await service.ui_login_link({}, { channel: "api" });
  const login = await app.request(link.path);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const csrf = (await service.getPageSession(cookie.split("=")[1] ?? ""))?.csrf_token ?? "";
  const get = async (path: string) =>
    (await app.request(path, { headers: { Cookie: cookie } })).text();
  const post = (path: string, fields: Record<string, string>) =>
    app.request(path, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, ...fields }).toString(),
    });

  const decisions = await get("/");
  assert.match(decisions, new RegExp(`id="ask-${carried.id}"`));
  assert.match(decisions, /<span class="chain-ask">Delete the files\?<\/span>/);
  assert.match(decisions, /Phase one is done\./);
  assert.match(decisions, /2 asks to answer/);

  assert.equal((await post(`/ui/asks/${carried.id}/answer`, { choice: "Delete" })).status, 303);
  const answered = await service.ask_get({ ask: carried.id }, mcp("lead"));
  assert.deepEqual(
    [answered.state, answered.answer?.choice, answered.answer?.by, answered.answer?.channel],
    ["answered", "Delete", null, "page"],
  );

  const back = `/agents/${child.manager}`;
  const stepIn = await post(`/ui/asks/${second.id}/answer`, { back, choice: "Keep" });
  assert.equal(stepIn.headers.get("location"), `${back}?answered=${second.id}`);
  assert.match(await get(stepIn.headers.get("location") ?? "/"), /You stepped in: Keep/);

  const report = (await service.agent_get({ agent: lead.agent.id }, mcp("lead"))).messages[0];
  assert.equal((await post(`/ui/messages/${report?.id}/ack`, {})).status, 303);
  const acknowledged = (await service.agent_get({ agent: lead.agent.id }, mcp("lead"))).messages[0];
  assert.notEqual(acknowledged?.acknowledged_at, null);
  assert.doesNotMatch(await get("/"), /Phase one is done\./);
});
