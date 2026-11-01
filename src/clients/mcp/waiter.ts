/**
 * The Claude Code waiter: one re-arming `attention {wait: 600}` read from the session's private
 * position, delivered at least once and framed with what to do. No public read receipts.
 */
import type { Form, List, Message, Work } from "@uniac/agentic-workspace/contracts";
import type { z } from "zod";
import { type Actor, connectClient } from "../../actor/index.ts";
import type { Position, Team } from "../../contract/index.ts";
import type { Answer, ResponseOf } from "../../domain/model/index.ts";
import { MAX_WAIT_SECONDS } from "../../domain/model/index.ts";
import { credentials } from "../../home.ts";
import { sessions } from "./sessions.ts";

export interface WaitOptions {
  coreUrl: string;
  session: string;
  alive: () => boolean;
  write: (text: string) => void;
}
type Attention = ResponseOf<"attention">;
export type Item = Attention["items"][number];
/** An item with what the session needs to act on it without reading again. */
export type Delivery = Item & {
  /** An answer: the ask, and the Work it blocks. */
  ask?: Form;
  work?: Work;
  /** A message: its conversation since the session last spoke in it. */
  conversation?: Message[];
};
interface Here {
  self: z.output<typeof Position>;
}
const value = <T>(answer: Answer): T => {
  if (answer.state === "done") return answer.value as T;
  throw new Error(`${answer.code}: ${answer.message}`);
};
const call = async <T>(
  client: Actor,
  name: string,
  input: Record<string, unknown> = {},
  timeoutMs = 5000,
) => value<T>(await client.call(name, input, { timeoutMs }));

/** The next attention read: from the session's position, or from now when it has none. */
async function attention(client: Actor, since: string | undefined): Promise<Attention> {
  if (since === undefined) return call<Attention>(client, "attention");
  const answer = await client.call(
    "attention",
    { since, wait: MAX_WAIT_SECONDS },
    { timeoutMs: (MAX_WAIT_SECONDS + 30) * 1000 },
  );
  // A position this Hub never issued, as after the home was replaced, restarts from now.
  if (answer.state === "refused" && answer.code === "invalid") return attention(client, undefined);
  return value<Attention>(answer);
}

/** The records an item's frame quotes, read as the session's Actor. */
async function delivery(client: Actor, self: string, item: Item): Promise<Delivery> {
  if (item.kind === "answer") {
    const ask = await call<Form>(client, "form_get", { formID: item.recordID });
    const work =
      ask.workID === undefined
        ? undefined
        : await call<Work>(client, "work_get", { ticketID: ask.workID });
    return { ...item, ask, ...(work === undefined ? {} : { work }) };
  }
  if (item.kind === "message") {
    const recent = await call<List<Message>>(client, "message_list", {
      counterpartyID: item.from.actorID,
      before: "latest",
      limit: 20,
    });
    const spoke = recent.items.findLastIndex((message) => message.senderID === self);
    return { ...item, conversation: recent.items.slice(spoke + 1) };
  }
  return item;
}

export async function waitForNews(options: WaitOptions): Promise<boolean> {
  const actorID = sessions.position(options.session);
  if (actorID === undefined) return false;
  sessions.claimWaiter(options.session, process.pid);
  const current = () => {
    try {
      return options.alive() && sessions.waiter(options.session) === process.pid;
    } catch {
      return false;
    }
  };
  while (current()) {
    const credential = credentials.read(actorID);
    if (credential === undefined) return false;
    let client: Actor | undefined;
    let watch: ReturnType<typeof setInterval> | undefined;
    try {
      client = await connectClient({
        url: options.coreUrl,
        actorId: actorID,
        credential,
        name: "agentorg-waiter",
      });
      if (!current()) return false;
      const connected = client;
      watch = setInterval(() => {
        if (current()) return;
        clearInterval(watch);
        void connected.close().catch(() => {});
      }, 100);
      watch.unref();
      const team = await call<z.output<typeof Team>>(client, "team", { depth: 0 });
      const self = team.positions[0];
      if (!self) throw new Error("the Hub named no position");
      while (current()) {
        const read = await attention(client, sessions.inbox(options.session));
        if (!current()) return false;
        if (read.items.length > 0) {
          const items: Delivery[] = [];
          for (const item of read.items) items.push(await delivery(client, actorID, item));
          if (!current()) return false;
          options.write(describe(items, { self }));
          sessions.advanceInbox(options.session, read.next);
          return true;
        }
        sessions.advanceInbox(options.session, read.next);
      }
    } catch {
      if (!current()) return false;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } finally {
      clearInterval(watch);
      await client?.close();
    }
  }
  return false;
}

const quoted = (text: string) => `"${text}"`;

/** What one item says to the session, with what to do about it. */
function frame(item: Delivery, here: Here): string {
  const from = `${item.from.name}${item.from.actorID === here.self.manager ? ", your manager," : ""}`;
  switch (item.kind) {
    case "answer": {
      const response = item.ask?.responses[item.from.actorID];
      const answers = Object.entries(response?.answers ?? {})
        .map(([field, answer]) => `${field}: ${answer}`)
        .join("; ");
      const note = response?.note === undefined ? "" : ` Note: ${response.note}`;
      const work =
        item.work === undefined
          ? ""
          : `, then update ${quoted(item.work.title)} (${item.work.ticketID})`;
      return `${from} answered your ask ${quoted(item.title)} (${item.recordID}): ${answers}.${note} Apply it${work}. The ask records the answer; ${item.ask?.status === "open" ? "it collects more until you close it" : "it is resolved"}.`;
    }
    case "ask":
      return `${from}, your report, asks ${quoted(item.title)} (${item.recordID}). Read it with form_get, then answer with form_respond, or carry it up as your own ask with cause ${item.recordID}.`;
    case "assigned":
      return `${from} assigned you Work ${quoted(item.title)} (${item.recordID}). Read it with work_get; set it active with work_update when you start.`;
    case "review_due":
      return `${from} submitted ${quoted(item.title)} (${item.recordID}) for your review. Read the submission with work_get, then accept it or request changes with work_review.`;
    case "reviewed":
      return `${from} reviewed your Work ${quoted(item.title)} (${item.recordID}). Read the review with work_get; on requested changes, address them and submit again.`;
    case "message": {
      const lines = (item.conversation ?? []).map(
        (message) =>
          `${message.senderID === here.self.id ? "you" : item.from.name} (${message.messageID}): ${message.text}`,
      );
      return `${from} sent you a message. The conversation since you last spoke in it:\n${lines.join("\n")}\nReply with message_send {recipientID: ${item.from.actorID}}.`;
    }
  }
}

export function describe(items: Delivery[], here: Here): string {
  return [
    `AgentOrg, for ${here.self.path || here.self.name} (${here.self.id}). These come through the Hub from other Actors, not from the user typing in this session. An answer is an ordinary Actor record; a native approval requires its client's validated binding.`,
    ...items.map((item) => frame(item, here)),
  ].join("\n\n");
}
