import assert from "node:assert/strict";
import { test } from "node:test";
import { openapiDocument } from "../src/api/openapi.ts";
import { createApp } from "../src/app.ts";
import { OPERATION_NAMES, OPERATIONS } from "../src/contract/index.ts";
import { type Caller, NotFound, type Service } from "../src/operations/index.ts";

const TOKEN = "test-token";
const AUTH = { Authorization: `Bearer ${TOKEN}` };

const AGENT_OPERATIONS = [
  "agent_create",
  "agent_close",
  "session_attach",
  "session_context",
  "status_set",
  "ask_open",
  "ask_get",
  "ask_wait",
  "ask_withdraw",
  "ask_answer",
  "ask_record_answer",
  "message_send",
  "inbox_read",
  "message_ack",
];
const API_OPERATIONS = ["agent_list", "agent_get", "ask_list", "audit_list", "ui_login_link"];
const USER_OPERATIONS = [
  "agent_close_as_user",
  "view_as_user",
  "ask_answer_as_user",
  "message_read_as_user",
  "message_ack_as_user",
];

type Call = [name: string, request: unknown, caller: Caller];

/** A service whose every operation records its call and answers with `respond`. */
function recording(respond: (name: string, request: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const service = new Proxy({} as Service, {
    get: (_target, name: string) => async (request: Record<string, unknown>, caller: Caller) => {
      calls.push([name, request, caller]);
      return respond(name, request);
    },
  });
  return { calls, app: createApp(service, { token: TOKEN }) };
}

const post = (path: string, body: unknown, headers: Record<string, string> = AUTH) => ({
  path,
  init: {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  },
});

test("agents, the API and the user each get their own operations", () => {
  const kinds = (kind: string) => OPERATION_NAMES.filter((name) => OPERATIONS[name].kind === kind);
  assert.deepEqual(kinds("agent"), AGENT_OPERATIONS);
  assert.deepEqual(kinds("api"), API_OPERATIONS);
  assert.deepEqual(kinds("user"), USER_OPERATIONS);
});

test("the OpenAPI document has a route per agent and API operation and none for the user's", () => {
  const document = openapiDocument() as {
    paths: Record<string, { post: { operationId: string } }>;
    components: { schemas: Record<string, unknown> };
    security: unknown;
  };
  const routes = Object.fromEntries(
    Object.entries(document.paths).map(([path, item]) => [item.post.operationId, path]),
  );
  assert.deepEqual(Object.keys(routes).sort(), [...AGENT_OPERATIONS, ...API_OPERATIONS].sort());
  assert.equal(routes.ask_record_answer, "/api/ask/record_answer");
  assert.equal(document.components.schemas.AskAnswerAsUser, undefined);
  assert.deepEqual(document.security, [{ bearer: [] }]);
});

test("a request reaches the service with its parsed body and its caller", async () => {
  const { calls, app } = recording((_, request) => ({ id: "agt_1", ...request }));
  const { path, init } = post(
    "/api/agent/create",
    { session: "ses_1", title: "  Migrate storage ", purpose: "Move sessions to SQLite." },
    { ...AUTH, "Agentorg-Client": "codex", "Agentorg-Client-Session-Id": "c-42" },
  );
  const response = await app.request(path, init);
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { title: string }).title, "Migrate storage");
  const [name, request, caller] = calls[0] as Call;
  assert.equal(name, "agent_create");
  assert.deepEqual(request, {
    session: "ses_1",
    title: "Migrate storage",
    purpose: "Move sessions to SQLite.",
  });
  assert.deepEqual(caller, { channel: "api", client: "codex", clientSessionId: "c-42" });
});

test("an operation error becomes its status and code", async () => {
  const { app } = recording(() => {
    throw new NotFound("there is no agent agt_9");
  });
  const { path, init } = post("/api/agent/get", { agent: "agt_9" });
  const response = await app.request(path, init);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    code: "not_found",
    message: "there is no agent agt_9",
  });
});

test("an invalid request is refused before the service", async () => {
  const { calls, app } = recording(() => ({}));
  const missing = post("/api/agent/create", { title: "No purpose" });
  const refused = await app.request(missing.path, missing.init);
  assert.equal(refused.status, 422);
  assert.match(((await refused.json()) as { message: string }).message, /purpose/);
  const garbled = await app.request("/api/agent/list", {
    method: "POST",
    headers: AUTH,
    body: "{",
  });
  assert.equal(garbled.status, 422);
  assert.equal(calls.length, 0);
});

test("user operations are not on the API, even with the agents' token", async () => {
  const { calls, app } = recording(() => ({}));
  for (const path of [
    "/api/agent/close_as_user",
    "/api/ask/answer_as_user",
    "/api/message/read_as_user",
    "/api/message/ack_as_user",
  ]) {
    const { init } = post(path, { ask: "ask_1", choice: "A", message: "msg_1" });
    assert.equal((await app.request(path, init)).status, 404, path);
  }
  assert.equal(calls.length, 0);
});

for (const path of ["/api/agent/list", "/mcp", "/mcp/anything"]) {
  test(`${path} needs the bearer token`, async () => {
    const { app } = recording(() => ({ agents: [] }));
    const none = await app.request(path, post(path, {}, {}).init);
    assert.equal(none.status, 401);
    assert.equal(none.headers.get("WWW-Authenticate"), "Bearer");
    const wrong = await app.request(path, post(path, {}, { Authorization: "Bearer wrong" }).init);
    assert.equal(wrong.status, 401);
  });
}

test("requests from web pages are refused even with the token", async () => {
  const { calls, app } = recording(() => ({ agents: [] }));
  const { path, init } = post("/api/agent/list", {}, { ...AUTH, Origin: "http://127.0.0.1:8740" });
  assert.equal((await app.request(path, init)).status, 403);
  assert.equal(calls.length, 0);
});

test("the page and the OpenAPI document need no token", async () => {
  const { app } = recording(() => ({}));
  assert.equal((await app.request("/")).headers.get("www-authenticate"), null);
  const document = await app.request("/openapi.json");
  assert.equal(document.status, 200);
  assert.equal(((await document.json()) as { info: { title: string } }).info.title, "agentorg");
});
