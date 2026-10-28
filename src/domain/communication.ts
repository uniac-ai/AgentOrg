/**
 * Communication: progress and questions, which anyone in the organization reads, and private
 * messages between two actors.
 *
 * - **Progress** is replaced in place, and every version is kept. A read gets the current one and,
 *   when asked, earlier ones.
 * - **A question** goes to the asker's manager or a direct report; the root asks anyone. It is
 *   pending on its addressee until answered. Its addressee answers it, or the answerer it names,
 *   and the root may always. The answer records the actor whose credential gave it, or that the
 *   asker recorded the user's words for its own question, which a question with an answerer
 *   refuses.
 * - **A message** goes to any open position and is pending on its addressee until read. Its two
 *   parties, the manager of either, and the root read it; for anyone else it is not found.
 * - **The cursor** orders questions and messages in one sequence. A question takes a new cursor
 *   when answered. A read with `wait` holds until it finds something, and every write wakes it.
 */

import type { Waiting } from "./builtins.ts";
import { Conflict, Forbidden, Invalid, NotFound } from "./errors.ts";
import type { RequestOf, ResponseOf } from "./model/index.ts";
import type { MessageRow, ProgressRow, QuestionRow, Store } from "./ports.ts";
import { type ActorRow, newId, type Registry } from "./registry.ts";
import { routes } from "./wiring.ts";

const isRoot = (actor: ActorRow) => actor.manager === null;

/** The actors questions name. */
const askersOf = (questions: QuestionRow[]) =>
  questions.flatMap((question) => [
    question.from,
    question.to,
    ...(question.answerer === null ? [] : [question.answerer]),
    ...(question.answer === null ? [] : [question.answer.by]),
  ]);

const partiesOf = (messages: MessageRow[]) =>
  messages.flatMap((message) => [message.from, message.to]);

/** The actors items name, as owners and as what they wait on. */
const actorsIn = (items: ProgressRow["items"]) =>
  items.flatMap((item) => [
    ...(item.owner === undefined ? [] : [item.owner]),
    ...(item.waits_on ?? []).flatMap((waits) => ("actor" in waits ? [waits.actor] : [])),
  ]);

export class Communication {
  private readonly store: Store;
  private readonly registry: Registry;
  private readonly now: () => string;
  /** The reads waiting for a new question, answer or message. */
  private readonly waiters = new Set<() => void>();

  constructor(store: Store, registry: Registry, now: () => string) {
    this.store = store;
    this.registry = registry;
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
      const { id, name, path, purpose, manager, online, created_at_attach, created_at, closed_at } =
        this.registry.asActor(at);
      const [current] = this.store.progress.latest(at.id, 1);
      positions.push({
        id,
        name,
        path,
        purpose,
        manager,
        online,
        created_at_attach,
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
      });
      if (depth > 0) for (const report of this.registry.reports(at.id)) visit(report, depth - 1);
    };
    visit(start, request.depth);
    return {
      root: (this.registry.root() as ActorRow).id,
      positions,
      names: this.registry.names(positions.flatMap((position) => askersOf(position.questions))),
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
        ...askersOf(questions),
      ]),
    };
  }

  /** The questions the actor asked that are not answered yet, oldest first. */
  private openQuestions(actor: string): QuestionRow[] {
    return this.store.questions.list({ from: actor, open: true }).reverse();
  }

  ask(actor: ActorRow, request: RequestOf<"question_ask">): QuestionRow {
    const id = request.to ?? actor.manager;
    if (id === null) throw new Invalid("to: the root names the addressee");
    const to = this.recipient(actor, id);
    if (!isRoot(actor) && to.id !== actor.manager && to.manager !== actor.id) {
      throw new Forbidden(`you ask your manager or a direct report, not ${to.name}`);
    }
    if (request.answerer !== undefined) this.open(request.answerer);
    if (request.cause !== undefined && this.store.questions.get(request.cause)?.to !== actor.id) {
      throw new Invalid(`cause: ${request.cause} is not a question to you`);
    }
    const question = this.store.transaction(() => {
      const asked: QuestionRow = {
        id: newId("q"),
        cursor: this.store.head() + 1,
        from: actor.id,
        to: to.id,
        text: request.text,
        links: request.links ?? [],
        options: request.options ?? [],
        recommendation: request.recommendation ?? null,
        answerer: request.answerer ?? null,
        cause: request.cause ?? null,
        answer: null,
        created_at: this.now(),
      };
      this.store.questions.insert(asked);
      return asked;
    });
    this.wake();
    return question;
  }

  answer(actor: ActorRow, request: RequestOf<"question_answer">): ResponseOf<"question_answer"> {
    const questions = [...new Set(request.questions)].map((id) => {
      const question = this.store.questions.get(id);
      if (!question) throw new NotFound(`there is no question ${id}`);
      this.mayAnswer(actor, question, request.recorded);
      return question;
    });
    if (request.choice !== undefined) {
      const offering = questions.filter((question) => question.options.length > 0);
      const offered = (question: QuestionRow) =>
        question.options.some((option) => option.label === request.choice);
      if (offering.length === 0 || !offering.every(offered)) {
        throw new Invalid(`choice: ${request.choice} is not an option of what it answers`);
      }
    }
    const answer = {
      by: actor.id,
      choice: request.choice ?? null,
      text: request.text ?? null,
      recorded: request.recorded,
      at: this.now(),
    };
    this.store.transaction(() => {
      for (const question of questions) {
        this.store.questions.answer(question.id, answer, this.store.head() + 1);
      }
    });
    this.wake();
    const answered = questions.map(
      (question) => this.store.questions.get(question.id) as QuestionRow,
    );
    return {
      questions: answered.reverse(),
      cursor: this.store.head(),
      names: this.registry.names(askersOf(answered)),
    };
  }

  /**
   * An open question is answered by its addressee, or the answerer it names, and by the root.
   * The asker records the user's words only for its own question without an answerer.
   */
  private mayAnswer(actor: ActorRow, question: QuestionRow, recorded: boolean): void {
    if (question.answer !== null) {
      throw new Conflict(`question ${question.id} is already answered`);
    }
    if (recorded) {
      if (question.from !== actor.id) {
        throw new Forbidden(`you record answers only to your own questions, not ${question.id}`);
      }
      if (question.answerer !== null) {
        throw new Forbidden(
          `question ${question.id} names its answerer, so the user answers it through the core`,
        );
      }
      return;
    }
    const answerer = question.answerer ?? question.to;
    if (actor.id !== answerer && !isRoot(actor)) {
      const name = this.registry.get(answerer)?.name ?? answerer;
      throw new Forbidden(`only ${name} or the root answers question ${question.id}`);
    }
  }

  async questions(
    _actor: ActorRow,
    request: RequestOf<"questions">,
    waiting: Waiting,
  ): Promise<ResponseOf<"questions">> {
    const query = {
      ...(request.to && { to: request.to }),
      ...(request.from && { from: request.from }),
      ...(request.since !== undefined && { since: request.since }),
      open: request.open,
      limit: request.limit,
    };
    const found = await this.until(() => this.store.questions.list(query), request.wait, waiting);
    return {
      questions: found,
      cursor: this.store.head(),
      names: this.registry.names(askersOf(found)),
    };
  }

  send(actor: ActorRow, request: RequestOf<"message_send">): MessageRow {
    const to = this.recipient(actor, request.to);
    const replied =
      request.reply_to === undefined ? undefined : this.found(actor, request.reply_to);
    if (
      replied &&
      ![replied.from, replied.to].every((party) => [actor.id, to.id].includes(party))
    ) {
      throw new Invalid(`reply_to: ${replied.id} is not between you and ${to.name}`);
    }
    const message = this.store.transaction(() => {
      const sent: MessageRow = {
        id: newId("msg"),
        cursor: this.store.head() + 1,
        from: actor.id,
        to: to.id,
        text: request.text,
        links: request.links ?? [],
        reply_to: replied?.id ?? null,
        created_at: this.now(),
        read_at: null,
      };
      this.store.messages.insert(sent);
      if (replied?.to === actor.id) this.store.messages.read([replied.id], sent.created_at);
      return sent;
    });
    this.wake();
    return message;
  }

  private recipient(actor: ActorRow, id: string): ActorRow {
    if (id === actor.id) throw new Invalid("to: not yourself");
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
    const other = request.with;
    const query = {
      viewer: isRoot(actor) ? null : actor.id,
      ...(request.box === "in"
        ? { to: owner, ...(other && { from: other }) }
        : { from: owner, ...(other && { to: other }) }),
      ...(request.since !== undefined && { since: request.since }),
      unread: request.unread,
      limit: request.limit,
    };
    const found = await this.until(() => this.store.messages.list(query), request.wait, waiting);
    return {
      messages: found,
      cursor: this.store.head(),
      names: this.registry.names(partiesOf(found)),
    };
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
      .sort((a, b) => b.cursor - a.cursor);
    return {
      messages,
      cursor: this.store.head(),
      names: this.registry.names(partiesOf(messages)),
    };
  }

  /** A message the actor may read; one it may not is not found, so its existence stays private. */
  private found(actor: ActorRow, id: string): MessageRow {
    const message = this.store.messages.get(id);
    const readable =
      message !== undefined &&
      (isRoot(actor) ||
        [message.from, message.to].some(
          (party) => party === actor.id || this.registry.get(party)?.manager === actor.id,
        ));
    if (!readable) throw new NotFound(`there is no message ${id}`);
    return message;
  }

  private wake(): void {
    for (const wake of this.waiters) wake();
  }

  /**
   * What `read` finds once it finds something or `seconds` pass, whichever is first. Each write
   * reads again; each step of `stepMs` without one reports progress.
   */
  private async until<T>(read: () => T[], seconds: number, waiting: Waiting): Promise<T[]> {
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
