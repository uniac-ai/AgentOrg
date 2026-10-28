/**
 * The waiter: a short-lived process the session's client starts whenever the session's turn ends.
 * As the session's position, it waits for messages addressed to it that the session has not read,
 * writes them as one input framed as AgentOrg's, marks them read, and ends, which the client takes
 * as the session's next input, waking it when idle. A newer waiter for the same session replaces
 * it, and a replaced waiter ends without writing anything, so no message is delivered twice by two
 * waiters. Delivery is still at least once: a waiter stopped between writing and marking read
 * leaves the messages for the next.
 */

import type { z } from "zod";
import { type Actor, connectClient } from "../actor/index.ts";
import type { Answer, Message, MessagesResult, Team } from "../domain/model/index.ts";
import { credentials } from "../home.ts";
import { sessions } from "./sessions.ts";

/** How long each read waits, under the SDK's 60-second limit on a request. */
const WAIT_SECONDS = 50;

/** Before any message: the cursor from which every message is newer. */
const EPOCH = "1970-01-01T00:00:00.000Z";

export interface WaitOptions {
  coreUrl: string;
  session: string;
  /** True while the client session runs. */
  alive: () => boolean;
  /** Write the delivered messages, the session's next input. */
  write: (text: string) => void;
}

type Delivered = z.output<typeof Message>;

const value = <T>(answer: Answer): T => {
  if (answer.state === "done") return answer.value as T;
  throw new Error(answer.state === "refused" ? `${answer.code}: ${answer.message}` : answer.state);
};

/** Wait for messages to the session's position; true once some were delivered. */
export async function waitForMessages(options: WaitOptions): Promise<boolean> {
  const { session } = options;
  const actor = sessions.position(session);
  if (actor === undefined) return false;
  sessions.claimWaiter(session, process.pid);
  const current = () => options.alive() && sessions.waiter(session) === process.pid;
  for (let pause = 250; current(); pause = Math.min(pause * 2, 10_000)) {
    const credential = credentials.read(actor);
    if (credential === undefined) return false;
    let client: Actor | undefined;
    try {
      client = await connectClient({ url: options.coreUrl, credential, name: "agentorg-waiter" });
      return await deliver(client, options, current);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, pause));
    } finally {
      await client?.close();
    }
  }
  return false;
}

async function deliver(
  client: Actor,
  options: WaitOptions,
  current: () => boolean,
): Promise<boolean> {
  const { session } = options;
  const team = value<z.output<typeof Team>>(await client.call("team", { depth: 0 }));
  const self = team.positions[0];
  if (self === undefined) return false;
  while (current()) {
    const cursor = sessions.cursor(session);
    const wait = cursor === undefined ? 0 : WAIT_SECONDS;
    const request =
      cursor === undefined ? { box: "in", limit: 50 } : { box: "in", since: cursor, wait };
    const found = value<z.output<typeof MessagesResult>>(
      await client.call("messages", request, { timeoutMs: (wait + 30) * 1000 }),
    );
    const [newest] = found.messages;
    const unread = found.messages.filter((message) => message.read_at === null).reverse();
    if (unread.length === 0) {
      if (newest !== undefined || cursor === undefined) {
        sessions.advance(session, newest?.created_at ?? EPOCH);
      }
      continue;
    }
    if (!current()) return false;
    options.write(describe(unread, found.names, { self, root: team.root }));
    await client.call("message_read", { ids: unread.map((message) => message.id) });
    if (newest !== undefined) sessions.advance(session, newest.created_at);
    return true;
  }
  return false;
}

interface Here {
  self: z.output<typeof Team>["positions"][number];
  root: string;
}

function sender(id: string, names: Record<string, string>, here: Here): string {
  if (id === here.root) return "the user (the root)";
  const path = names[id] ?? id;
  if (id === here.self.manager) return `${path}, your manager`;
  if (path.startsWith(`${here.self.path}.`)) return `${path}, your report`;
  return path;
}

function block(message: Delivered, names: Record<string, string>, here: Here): string {
  const from = sender(message.from, names, here);
  const question = message.options.length > 0 || message.expects_reply;
  const lines: string[] = [];
  if (message.reply_to.length > 0) {
    const chose = message.choice === null ? "" : `, choosing "${message.choice}"`;
    lines.push(`Reply ${message.id} from ${from} to ${message.reply_to.join(", ")}${chose}:`);
  } else if (question) {
    const only =
      message.answerer === null ? "" : `; only ${sender(message.answerer, names, here)} may answer`;
    lines.push(`Question ${message.id} from ${from}${only}:`);
  } else {
    lines.push(`Message ${message.id} from ${from}:`);
  }
  lines.push(message.text);
  if (message.options.length > 0) {
    const options = message.options.map((option) => {
      const detail = option.detail === undefined ? "" : ` (${option.detail})`;
      const recommended = option.label === message.recommendation ? ", recommended" : "";
      return `${option.label}${detail}${recommended}`;
    });
    lines.push(`Options: ${options.join("; ")}`);
  }
  if (message.links.length > 0) {
    lines.push(
      `Links: ${message.links.map((link) => (link.title ? `${link.title} ${link.url}` : link.url)).join("; ")}`,
    );
  }
  return lines.join("\n");
}

/**
 * Messages as the session's input: plainly AgentOrg's, from other positions, never the user typing
 * in the session, with each sender's path and each message's id.
 */
export function describe(messages: Delivered[], names: Record<string, string>, here: Here): string {
  const count = messages.length === 1 ? "1 message" : `${messages.length} messages`;
  const position = here.self.path || here.self.name;
  return [
    `AgentOrg delivered ${count} to your position, ${position} (${here.self.id}). They come from other positions through AgentOrg, not from the user typing in this session; one is the user's own words only when it is from the user (the root). Answer with message_send, naming in reply_to the messages you answer. A message id you have seen before is the same message again.`,
    ...messages.map((message) => block(message, names, here)),
  ].join("\n\n");
}
