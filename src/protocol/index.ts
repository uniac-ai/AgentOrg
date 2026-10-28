/**
 * The protocol between the core and its actors: MCP in both directions, over two endpoints that
 * an actor dials with one credential, `Authorization: Bearer <credential>`. Both refuse a request
 * with an `Origin` header, so a web page cannot reach them.
 *
 * - `/mcp`, Streamable HTTP: the core is the MCP server and the actor its client. Its tool list is
 *   the actor's available tools: the core's built-ins, its manager's tools as `manager.<tool>`, and
 *   each direct report's tools as `<handle>.<tool>`; the root has every actor's tools under their
 *   paths, as `release.storage.review`.
 * - `/mcp/reverse`, a WebSocket the actor opens with subprotocol `mcp`: the core is the MCP client
 *   and the actor its server. The core learns the actor's exposed tools with `tools/list`, again on
 *   each `notifications/tools/list_changed`, and delivers calls into the actor as `tools/call`.
 *
 * A routed call is recorded before it is delivered, and delivered at least once: again whenever the
 * actor reconnects while it is pending. A tool that declares `execution.taskSupport` receives its
 * calls as MCP tasks, so it may finish one hours later; the core waits on `tasks/result`.
 */

export * from "./actor.ts";
export * from "./builtins.ts";
export * from "./endpoints.ts";
export * from "./json-schema.ts";
export * from "./records.ts";
export * from "./websocket.ts";
