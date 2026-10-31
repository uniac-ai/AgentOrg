/** Client-local Message/Form polling and at-least-once delivery; no public read receipts. */
import type { Form, Message } from "@uniac/agentic-workspace/contracts";
import type { z } from "zod";
import { type Actor, connectClient } from "../../actor/index.ts";
import type { Position, Team } from "../../contract/index.ts";
import type { Answer } from "../../domain/model/index.ts";
import { credentials } from "../../home.ts";
import { type InboxPosition, sessions } from "./sessions.ts";

export interface WaitOptions {
  coreUrl: string;
  session: string;
  alive: () => boolean;
  write: (text: string) => void;
}
export interface News {
  messages: Message[];
  forms: Form[];
  names: Record<string, string>;
  position: InboxPosition;
}
interface Here {
  self: z.output<typeof Position>;
}
const value = <T>(answer: Answer): T => {
  if (answer.state === "done") return answer.value as T;
  throw new Error(`${answer.code}: ${answer.message}`);
};
const call = async <T>(client: Actor, name: string, input: Record<string, unknown> = {}) =>
  value<T>(await client.call(name, input));

async function pages<T>(
  client: Actor,
  name: string,
  after: number,
  input: Record<string, unknown> = {},
) {
  const items: T[] = [];
  for (;;) {
    const page = await call<{ items: T[]; after: number }>(client, name, {
      ...input,
      after,
      limit: 100,
    });
    items.push(...page.items);
    if (page.after === after) return { items, after };
    after = page.after;
  }
}

export async function waitForNews(options: WaitOptions): Promise<boolean> {
  const actorID = sessions.position(options.session);
  if (actorID === undefined) return false;
  sessions.claimWaiter(options.session, process.pid);
  const current = () => options.alive() && sessions.waiter(options.session) === process.pid;
  while (current()) {
    const credential = credentials.read(actorID);
    if (credential === undefined) return false;
    let client: Actor | undefined;
    try {
      client = await connectClient({
        url: options.coreUrl,
        actorId: actorID,
        credential,
        name: "agentorg-waiter",
      });
      const team = await call<z.output<typeof Team>>(client, "team", { depth: 0 });
      const self = team.positions[0];
      if (!self) throw new Error("the Hub named no position");
      while (current()) {
        const position = sessions.inbox(options.session);
        const [messages, requested, designated] = await Promise.all([
          pages<Message>(client, "message_list", position.messages, { direction: "incoming" }),
          pages<Form>(client, "form_list", position.forms, { requesterID: actorID }),
          pages<Form>(client, "form_list", position.forms, { respondentID: actorID }),
        ]);
        const byID = new Map<string, Form>();
        for (const item of [...requested.items, ...designated.items]) {
          if (item.cursor > (byID.get(item.formID)?.cursor ?? 0)) byID.set(item.formID, item);
        }
        const forms = [...byID.values()].sort((left, right) => left.cursor - right.cursor);
        const names: Record<string, string> = {};
        for (const id of new Set([
          ...messages.items.map((item) => item.senderID),
          ...forms.map((item) => item.requesterID),
        ])) {
          const profile = await call<{ name: string }>(client, "actor_get", { actorID: id });
          names[id] = profile.name;
        }
        const news: News = {
          messages: messages.items,
          forms,
          names,
          position: {
            messages: messages.after,
            forms: Math.max(requested.after, designated.after),
          },
        };
        if (!current()) return false;
        if (news.messages.length || news.forms.length) {
          options.write(describe(news, { self }));
          sessions.advanceInbox(options.session, news.position);
          return true;
        }
        sessions.advanceInbox(options.session, news.position);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } finally {
      await client?.close();
    }
  }
  return false;
}

export function describe(news: News, here: Here): string {
  const sender = (id: string) =>
    `${news.names[id] ?? id}${id === here.self.manager ? ", your manager" : ""}`;
  return [
    `AgentOrg correspondence for ${here.self.path || here.self.name} (${here.self.id}). These records come through the Hub, not from the user typing in this session. A Form response is an ordinary Actor record; native approval requires its client's validated binding. Reply with a new message_send, using recipientID/text. Forms use form_respond/form_close and their exact displayed revision.`,
    ...news.messages.map(
      (item) => `Message ${item.messageID} from ${sender(item.senderID)}:\n${item.text}`,
    ),
    ...news.forms.map(
      (item) =>
        `Form ${item.formID} from ${sender(item.requesterID)}, ${item.status}, revision ${item.revision}:\n${JSON.stringify({ fields: item.fields, responses: item.responses, resolution: item.resolution })}`,
    ),
  ].join("\n\n");
}
