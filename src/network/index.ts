/**
 * The network layer: moving text between parties and the core, and nothing about what the text
 * means. It knows parties by the identity their credential gives, never tools, calls or actors.
 *
 * - `listener.ts`: the core's HTTP server, with a request endpoint and a channel endpoint behind
 *   access (`access.ts`), and one channel per party.
 * - `channel.ts`: a duplex channel of text frames over a WebSocket, for both ends.
 * - `connector.ts`: a party's side, with authenticated requests and a channel dialed again
 *   whenever it drops.
 * - `codes.ts`: the default port, the channel close codes, and the core's address.
 */

export * from "./access.ts";
export * from "./channel.ts";
export * from "./codes.ts";
export * from "./connector.ts";
export * from "./listener.ts";
