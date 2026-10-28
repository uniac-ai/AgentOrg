/**
 * Communication: progress, which each actor sets for anyone in the organization to read, and
 * messages between two actors, of which a question waits for an answer.
 *
 * - **Progress** is replaced in place, and every version is kept. A read gets the current one and,
 *   when asked, earlier ones.
 * - **A message** is pending on its addressee until read, and is private to its two parties, the
 *   manager of either, and the root.
 * - **A question** is pending on its addressee until answered, and anyone reads it and the reply
 *   that answers it. Its addressee answers it, or the root steps in. When it names an answerer, only
 *   that actor answers. The answer's sender is the actor whose credential sent it.
 * - **Addressing** goes one step up or down, as calls do, and the root reaches anyone. A reply goes
 *   to the sender of what it replies to.
 */

import type { Waiting } from "./builtins.ts";
import type { Claims } from "./claims.ts";
import { Conflict, Forbidden, Invalid, NotFound } from "./errors.ts";
import type { RequestOf, ResponseOf } from "./model/index.ts";
import type { MessageQuery, MessageRow, ProgressRow, Store } from "./ports.ts";
import { type ActorRow, newId, type Registry } from "./registry.ts";
import { routes } from "./wiring.ts";

const isRoot = (actor: ActorRow) => actor.manager === null;

/** The actors messages name. */
const partiesOf = (messages: MessageRow[]) =>
  messages.flatMap((message) => [
    message.from,
    message.to,
    ...(message.answerer === null ? [] : [message.answerer]),
  ]);

/** The actors items name, as owners and as what they wait on. */
const actorsIn = (items: ProgressRow["items"]) =>
  items.flatMap((item) => [
    ...(item.owner === undefined ? [] : [item.owner]),
    ...(item.waits_on ?? []).flatMap((waits) => ("actor" in waits ? [waits.actor] : [])),
  ]);

export class Communication {
  private readonly store: Store;
  private readonly registry: Registry;
  private readonly claims: Claims;
  private readonly now: () => string;
  /** The reads waiting for a new message. */
  private readonly waiters = new Set<() => void>();

  constructor(store: Store, registry: Registry, claims: Claims, now: () => string) {
    this.store = store;
    this.registry = registry;
    this.claims = claims;
    this.now = now;
  }

  setProgress(actor: ActorRow, request: RequestOf<"progress_set">): ProgressRow {
    const [current] = this.store.progress.latest(actor.id, 1);
    const state = request.state ?? current?.state;
    if (state === undefined) throw new Invalid("state: your first progress names its state");
    for (const id of actorsIn(request.items ?? [])) {
      if (!this.registry.get(id)) throw new Invalid(`items: there is no actor ${id}`);
    }
    const progress: ProgressRow = {
      actor: actor.id,
      version: (current?.version ?? 0) + 1,
      state,
      summary: request.summary ?? current?.summary ?? "",
      items: request.items ?? current?.items ?? [],
      links: request.links ?? current?.links ?? [],
      updated_at: this.now(),
    };
    this.store.progress.insert(progress);
    return progress;
  }

  team(actor: ActorRow, request: RequestOf<"team">): ResponseOf<"team"> {
    const start = request.actor === undefined ? actor : this.registry.found(request.actor);
    const callable = new Map<string, string[]>();
    for (const route of routes(this.registry, actor)) {
      callable.set(route.to.id, [...(callable.get(route.to.id) ?? []), route.name]);
    }
    const positions: ResponseOf<"team">["positions"] = [];
    const visit = (at: ActorRow, depth: number) => {
      const { id, name, path, purpose, manager, online, created_at, closed_at } =
        this.registry.asActor(at);
      const [current] = this.store.progress.latest(at.id, 1);
      positions.push({
        id,
        name,
        path,
        purpose,
        manager,
        online,
        created_at,
        closed_at,
        progress: current
          ? {
              version: current.version,
              state: current.state,
              summary: current.summary,
              updated_at: current.updated_at,
            }
          : null,
        questions: this.openQuestions(at.id),
        interfaces: callable.get(at.id) ?? [],
        claims: this.claims.heldBy(at.id),
      });
      if (depth > 0) for (const report of this.registry.reports(at.id)) visit(report, depth - 1);
    };
    visit(start, request.depth);
    return {
      root: (this.registry.root() as ActorRow).id,
      positions,
      names: this.registry.names(positions.flatMap((position) => partiesOf(position.questions))),
    };
  }

  progress(_actor: ActorRow, request: RequestOf<"progress">): ResponseOf<"progress"> {
    const target = this.registry.found(request.actor);
    const versions = this.store.progress.latest(target.id, request.history + 1);
    const [current, ...history] = versions;
    const questions = this.openQuestions(target.id);
    return {
      actor: target.id,
      progress: current ?? null,
      questions,
      history,
      names: this.registry.names([
        target.id,
        ...versions.flatMap((version) => actorsIn(version.items)),
        ...partiesOf(questions),
      ]),
    };
  }

  /** The questions the actor asked that are not answered yet, oldest first. */
  private openQuestions(actor: string): MessageRow[] {
    const query = { viewer: null, from: actor, questions: true, pending: true };
    return this.store.messages.list(query).reverse();
  }

  send(actor: ActorRow, request: RequestOf<"message_send">): MessageRow {
    const named = [...new Set(request.reply_to ?? [])].map((id) => this.found(actor, id));
    for (const message of named) this.mayReply(actor, message);
    const answered = named.filter((message) => message.expects_reply);
    if (request.choice !== undefined) {
      const offering = answered.filter((question) => question.options.length > 0);
      const offered = (question: MessageRow) =>
        question.options.some((option) => option.label === request.choice);
      if (offering.length === 0 || !offering.every(offered)) {
        throw new Invalid(`choice: ${request.choice} is not an option of what it answers`);
      }
    }
    const to =
      named.length > 0
        ? this.replyAddressee(actor, named, request.to)
        : this.addressee(actor, request.to);
    if (request.answerer !== undefined) this.open(request.answerer);
    if (request.cause !== undefined && this.store.messages.get(request.cause)?.to !== actor.id) {
      throw new Invalid(`cause: ${request.cause} is not a message to you`);
    }
    const options = request.options ?? [];
    const question = options.length > 0 || request.expects_reply === true;
    const message: MessageRow = {
      id: newId("msg"),
      from: actor.id,
      to: to.id,
      text: request.text,
      links: request.links ?? [],
      options,
      recommendation: request.recommendation ?? null,
      expects_reply: question,
      answerer: request.answerer ?? null,
      cause: request.cause ?? null,
      reply_to: named.map((each) => each.id),
      choice: request.choice ?? null,
      public: question || answered.length > 0,
      answer: null,
      created_at: this.now(),
      read_at: null,
    };
    this.store.transaction(() => {
      this.store.messages.insert(message);
      for (const each of answered) this.store.messages.answer(each.id, message.id);
      if (named.length > 0) this.store.messages.read(message.reply_to, message.created_at);
    });
    for (const wake of this.waiters) wake();
    return message;
  }

  /** A question is answered once, by its answerer, else by its addressee or the root. */
  private mayReply(actor: ActorRow, message: MessageRow): void {
    if (!message.expects_reply) {
      if (message.to !== actor.id) {
        throw new Forbidden(`only its addressee replies to message ${message.id}`);
      }
      return;
    }
    if (message.answer !== null) {
      throw new Conflict(`question ${message.id} is already answered, by ${message.answer}`);
    }
    if (message.answerer !== null) {
      if (actor.id !== message.answerer) {
        const answerer = this.registry.get(message.answerer);
        throw new Forbidden(
          `only ${answerer?.name ?? message.answerer} answers question ${message.id}`,
        );
      }
    } else if (actor.id !== message.to && !isRoot(actor)) {
      throw new Forbidden(`only its addressee or the root answers question ${message.id}`);
    }
  }

  private replyAddressee(actor: ActorRow, named: MessageRow[], to: string | undefined): ActorRow {
    const senders = [...new Set(named.map((message) => message.from))];
    const id = to ?? (senders.length === 1 ? senders[0] : undefined);
    if (id === undefined) {
      throw new Invalid("to: what it replies to has several senders; name the one it goes to");
    }
    if (!senders.includes(id)) {
      throw new Invalid(`to: a reply goes to the sender of what it replies to, not ${id}`);
    }
    return this.recipient(actor, id);
  }

  private addressee(actor: ActorRow, to: string | undefined): ActorRow {
    const id = to ?? actor.manager;
    if (id === null) throw new Invalid("to: the root names the addressee");
    const target = this.recipient(actor, id);
    if (!isRoot(actor) && target.id !== actor.manager && target.manager !== actor.id) {
      throw new Forbidden(`you message your manager and your direct reports, not ${target.name}`);
    }
    return target;
  }

  private recipient(actor: ActorRow, id: string): ActorRow {
    if (id === actor.id) throw new Invalid("to: you do not message yourself");
    return this.open(id);
  }

  private open(id: string): ActorRow {
    const target = this.registry.found(id);
    if (target.closed_at !== null) throw new Conflict(`${target.name} is closed`);
    return target;
  }

  async messages(
    actor: ActorRow,
    request: RequestOf<"messages">,
    waiting: Waiting,
  ): Promise<ResponseOf<"messages">> {
    const owner = request.actor ?? actor.id;
    const box = request.box ?? (request.reply_to === undefined ? "in" : undefined);
    const query: MessageQuery = {
      viewer: isRoot(actor) ? null : actor.id,
      ...(box === "in" && { to: owner, ...(request.with && { from: request.with }) }),
      ...(box === "out" && { from: owner, ...(request.with && { to: request.with }) }),
      ...(box === undefined && {
        parties: [request.actor, request.with].filter((id) => id !== undefined),
      }),
      ...(request.reply_to && { replyTo: request.reply_to }),
      ...(request.since && { since: new Date(request.since).toISOString() }),
      pending: request.pending,
      limit: request.limit,
    };
    const found = await this.until(() => this.store.messages.list(query), request.wait, waiting);
    return { messages: found, names: this.registry.names(partiesOf(found)) };
  }

  read(actor: ActorRow, request: RequestOf<"message_read">): ResponseOf<"message_read"> {
    const ids = [...new Set(request.ids)];
    for (const message of ids.map((id) => this.found(actor, id))) {
      if (message.to !== actor.id) {
        throw new Forbidden(`only its addressee marks message ${message.id} read`);
      }
    }
    this.store.messages.read(ids, this.now());
    const messages = ids
      .map((id) => this.store.messages.get(id) as MessageRow)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { messages, names: this.registry.names(partiesOf(messages)) };
  }

  /** A message the actor may read; one it may not is not found, so its existence stays private. */
  private found(actor: ActorRow, id: string): MessageRow {
    const message = this.store.messages.get(id);
    const readable =
      message !== undefined &&
      (message.public ||
        isRoot(actor) ||
        [message.from, message.to].some(
          (party) => party === actor.id || this.registry.get(party)?.manager === actor.id,
        ));
    if (!readable) throw new NotFound(`there is no message ${id}`);
    return message;
  }

  /**
   * What `read` finds once it finds something or `seconds` pass, whichever is first. A new message
   * reads again; each step of `stepMs` without one reports progress.
   */
  private async until(
    read: () => MessageRow[],
    seconds: number,
    waiting: Waiting,
  ): Promise<MessageRow[]> {
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      const found = read();
      const left = deadline - Date.now();
      if (found.length > 0 || left <= 0 || waiting.signal.aborted) return found;
      let wake = () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stepped = await Promise.race([
        new Promise<boolean>((resolve) => {
          wake = () => resolve(false);
          this.waiters.add(wake);
        }),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), Math.min(waiting.stepMs, left));
        }),
      ]);
      this.waiters.delete(wake);
      clearTimeout(timer);
      if (stepped && Date.now() < deadline) await waiting.progress();
    }
  }
}
