/** Questions, answers and private messages, with a shared cursor, authorization and waiting reads. */

import { Conflict, Forbidden, Invalid, NotFound } from "./errors.ts";
import type { RequestOf, ResponseOf } from "./model/index.ts";
import type { MessageRow, QuestionRow, Store, Waiting } from "./ports.ts";
import { type ActorRow, newId, type Registry } from "./registry.ts";

const isRoot = (actor: ActorRow) => actor.manager === null;

/** The actors questions name. */
export const askersOf = (questions: QuestionRow[]) =>
  questions.flatMap((question) => [
    question.from,
    question.to,
    ...(question.answerer === null ? [] : [question.answerer]),
    ...(question.answer === null ? [] : [question.answer.by]),
  ]);

const partiesOf = (messages: MessageRow[]) =>
  messages.flatMap((message) => [message.from, message.to]);

export function communication(
  store: Pick<Store, "questions" | "messages" | "head" | "transaction">,
  registry: Registry,
  now: () => string,
) {
  /** The reads waiting for a new question, answer or message. */
  const waiters = new Set<() => void>();

  /** The questions the actor asked that are not answered yet, oldest first. */
  function openQuestions(actor: string): QuestionRow[] {
    return store.questions.list({ from: actor, open: true }).reverse();
  }

  function ask(actor: ActorRow, request: RequestOf<"question_ask">): QuestionRow {
    const id = request.to ?? actor.manager;
    if (id === null) throw new Invalid("to: the root names the addressee");
    const to = recipient(actor, id);
    if (!isRoot(actor) && to.id !== actor.manager && to.manager !== actor.id) {
      throw new Forbidden(`you ask your manager or a direct report, not ${to.name}`);
    }
    if (request.answerer !== undefined) open(request.answerer);
    if (request.cause !== undefined && store.questions.get(request.cause)?.to !== actor.id) {
      throw new Invalid(`cause: ${request.cause} is not a question to you`);
    }
    const question = store.transaction(() => {
      const asked: QuestionRow = {
        id: newId("q"),
        cursor: store.head() + 1,
        from: actor.id,
        to: to.id,
        text: request.text,
        links: request.links ?? [],
        options: request.options ?? [],
        recommendation: request.recommendation ?? null,
        answerer: request.answerer ?? null,
        cause: request.cause ?? null,
        answer: null,
        created_at: now(),
      };
      store.questions.insert(asked);
      return asked;
    });
    wake();
    return question;
  }

  function answer(
    actor: ActorRow,
    request: RequestOf<"question_answer">,
  ): ResponseOf<"question_answer"> {
    const questions = [...new Set(request.questions)].map((id) => {
      const question = store.questions.get(id);
      if (!question) throw new NotFound(`there is no question ${id}`);
      mayAnswer(actor, question, request.recorded);
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
      at: now(),
    };
    store.transaction(() => {
      for (const question of questions) {
        store.questions.answer(question.id, answer, store.head() + 1);
      }
    });
    wake();
    const answered = questions.map((question) => store.questions.get(question.id) as QuestionRow);
    return {
      questions: answered.reverse(),
      cursor: store.head(),
      names: registry.names(askersOf(answered)),
    };
  }

  /**
   * An open question is answered by its addressee, or the answerer it names, and by the root.
   * The asker records the user's words only for its own question without an answerer.
   */
  function mayAnswer(actor: ActorRow, question: QuestionRow, recorded: boolean): void {
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
      const name = registry.get(answerer)?.name ?? answerer;
      throw new Forbidden(`only ${name} or the root answers question ${question.id}`);
    }
  }

  async function questions(
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
    const found = await until(() => store.questions.list(query), request.wait, waiting);
    return {
      questions: found,
      cursor: store.head(),
      names: registry.names(askersOf(found)),
    };
  }

  function send(actor: ActorRow, request: RequestOf<"message_send">): MessageRow {
    const to = recipient(actor, request.to);
    const replied = request.reply_to === undefined ? undefined : found(actor, request.reply_to);
    if (
      replied &&
      ![replied.from, replied.to].every((party) => [actor.id, to.id].includes(party))
    ) {
      throw new Invalid(`reply_to: ${replied.id} is not between you and ${to.name}`);
    }
    const message = store.transaction(() => {
      const sent: MessageRow = {
        id: newId("msg"),
        cursor: store.head() + 1,
        from: actor.id,
        to: to.id,
        text: request.text,
        links: request.links ?? [],
        reply_to: replied?.id ?? null,
        created_at: now(),
        read_at: null,
      };
      store.messages.insert(sent);
      if (replied?.to === actor.id) store.messages.read([replied.id], sent.created_at);
      return sent;
    });
    wake();
    return message;
  }

  function recipient(actor: ActorRow, id: string): ActorRow {
    if (id === actor.id) throw new Invalid("to: not yourself");
    return open(id);
  }

  function open(id: string): ActorRow {
    const target = registry.found(id);
    if (target.closed_at !== null) throw new Conflict(`${target.name} is closed`);
    return target;
  }

  async function messages(
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
    const found = await until(() => store.messages.list(query), request.wait, waiting);
    return {
      messages: found,
      cursor: store.head(),
      names: registry.names(partiesOf(found)),
    };
  }

  function read(actor: ActorRow, request: RequestOf<"message_read">): ResponseOf<"message_read"> {
    const ids = [...new Set(request.ids)];
    for (const message of ids.map((id) => found(actor, id))) {
      if (message.to !== actor.id) {
        throw new Forbidden(`only its addressee marks message ${message.id} read`);
      }
    }
    store.messages.read(ids, now());
    const messages = ids
      .map((id) => store.messages.get(id) as MessageRow)
      .sort((a, b) => b.cursor - a.cursor);
    return {
      messages,
      cursor: store.head(),
      names: registry.names(partiesOf(messages)),
    };
  }

  /** A message the actor may read; one it may not is not found, so its existence stays private. */
  function found(actor: ActorRow, id: string): MessageRow {
    const message = store.messages.get(id);
    const readable =
      message !== undefined &&
      (isRoot(actor) ||
        [message.from, message.to].some(
          (party) => party === actor.id || registry.get(party)?.manager === actor.id,
        ));
    if (!readable) throw new NotFound(`there is no message ${id}`);
    return message;
  }

  function wake(): void {
    for (const wake of waiters) wake();
  }

  /**
   * What `read` finds once it finds something or `seconds` pass, whichever is first. Each write
   * reads again; each step of `stepMs` without one reports progress.
   */
  async function until<T>(read: () => T[], seconds: number, waiting: Waiting): Promise<T[]> {
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
          waiters.add(wake);
        }),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), Math.min(waiting.stepMs, left));
        }),
      ]);
      waiters.delete(wake);
      clearTimeout(timer);
      if (stepped && Date.now() < deadline) await waiting.progress();
    }
  }
  return { openQuestions, ask, answer, questions, send, messages, read };
}

export type Communication = ReturnType<typeof communication>;
