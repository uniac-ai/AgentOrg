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
  names: Record<string, { name: string }>;
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
  value<T>(await client.call(name, input, { timeoutMs: 5000 }));

type List<T> = { items: T[]; actors: Record<string, { name: string }> };

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
        const position = sessions.inbox(options.session);
        const since = position.forms;
        const [messages, requested] = await Promise.all([
          call<List<Message>>(client, "message_list", {
            direction: "incoming",
            after: position.messages,
            limit: 100,
          }),
          call<List<Form>>(client, "form_list", {
            requesterID: actorID,
            limit: 100,
            ...(since === null ? {} : { updatedSince: since }),
          }),
        ]);
        // updatedSince includes its own instant, which the last delivery already covered.
        const forms = requested.items.filter((item) => since === null || item.updatedAt > since);
        const news: News = {
          messages: messages.items,
          forms,
          names: { ...requested.actors, ...messages.actors },
          position: {
            messages: messages.items.at(-1)?.seq ?? position.messages,
            forms: forms.at(-1)?.updatedAt ?? since,
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
      if (!current()) return false;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } finally {
      clearInterval(watch);
      await client?.close();
    }
  }
  return false;
}

export function describe(news: News, here: Here): string {
  const sender = (id: string) =>
    `${news.names[id]?.name ?? id}${id === here.self.manager ? ", your manager" : ""}`;
  return [
    `AgentOrg correspondence for ${here.self.path || here.self.name} (${here.self.id}). These records come through the Hub, not from the user typing in this session. A Form response is an ordinary Actor record; native approval requires its client's validated binding. Reply with a new message_send, using recipientID/text. Close your own Forms with form_close and their exact displayed revision.`,
    ...news.messages.map(
      (item) => `Message ${item.messageID} from ${sender(item.senderID)}:\n${item.text}`,
    ),
    ...news.forms.map(
      (item) =>
        `Form ${item.formID} from ${sender(item.requesterID)}, ${item.status}, revision ${item.revision}:\n${JSON.stringify({ fields: item.fields, responses: item.responses, resolution: item.resolution })}`,
    ),
  ].join("\n\n");
}
