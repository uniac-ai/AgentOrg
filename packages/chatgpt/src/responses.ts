/** Inference on the person's ChatGPT plan: the Responses API, streamed, with nothing stored at OpenAI. */
import type { Item, llmSession, OutputItem } from "@agentorg/interfaces";
import { Refused } from "@agentorg/sdk";
import type { z } from "zod";
import { type Account, notEligible } from "./account.js";
import { type Fetch, word } from "./oauth.js";

const API = "https://api.openai.com/v1";
export const USAGE_SETTINGS = "https://chatgpt.com/settings/usage";

type RespondInput = z.output<typeof llmSession.methods.respond.input>;
type Output = z.output<typeof OutputItem>;

/** How often a request that failed for a passing reason is made again. */
export const RETRIES = 3;
/** The wait before the first of those; each next one is twice as long, a tenth more or less. */
const BACKOFF_MS = 1000;
/** The longest wait OpenAI can ask for that is taken: past it the failure is the answer. */
const WAIT_MAX_MS = 60_000;
/**
 * A try begins within this long of the first, or not at all: its caller has a limit of its own
 * on one call, and a person is waiting.
 */
const RETRY_WITHIN_MS = 120_000;
/** OpenAI's codes for a server that failed or is overloaded, in a reply or inside a stream. */
const SERVER_CODES = new Set(["server_error", "server_is_overloaded"]);

/**
 * The failures marked as passing, each with the wait OpenAI asked for, if it did. `tried` makes
 * a marked one again; any other failure is the answer at once.
 */
const passing = new WeakMap<Refused, { waitMs?: number }>();
const pass = (refused: Refused, waitMs?: number) => {
  passing.set(refused, waitMs === undefined ? {} : { waitMs });
  return refused;
};

/**
 * `refused`, marked as passing when it is: one that says to try again later (`unavailable`), or
 * a failure with no words of its own (`failed`) whose code or HTTP status is a server's: 408 or
 * any 5xx. A usage limit, an account that isn't eligible and a request plan usage doesn't support
 * are final whatever the status.
 */
function marked(refused: Refused, at: { code?: string; status?: number; waitMs?: number } = {}) {
  const server =
    (at.code !== undefined && SERVER_CODES.has(at.code)) ||
    at.status === 408 ||
    (at.status !== undefined && at.status >= 500);
  return refused.code === "unavailable" || (refused.code === "failed" && server)
    ? pass(refused, at.waitMs)
    : refused;
}

const NUMBER = /^\d+(\.\d+)?$/;

/**
 * The wait a reply asks for, in milliseconds: the longer of `retry-after-ms` and `retry-after`
 * in seconds. The date form of `retry-after` isn't read, so such a reply waits as one that
 * asked for nothing.
 */
function waitOf(headers: Headers): number | undefined {
  const ms = headers.get("retry-after-ms")?.trim() ?? "";
  const seconds = headers.get("retry-after")?.trim() ?? "";
  const asked = [
    ...(NUMBER.test(ms) ? [Number(ms)] : []),
    ...(NUMBER.test(seconds) ? [Number(seconds) * 1000] : []),
  ];
  return asked.length ? Math.max(...asked) : undefined;
}

/** Words that say a message is about a credential: such a message can quote part of one. */
const OF_A_CREDENTIAL = /\b(keys?|token|bearer|authorization|credentials?|secret|password)\b/i;

/**
 * OpenAI's own words for an error, fit to show and to log: printable characters on one line, cut
 * at 200. Nothing of a message about a credential, since it can quote one in part; and in any
 * other, a run of 32 or more letters, digits, `_` and `-` is left out, which is every token this
 * program holds and no model's name.
 */
const saidOf = (value: unknown) =>
  typeof value !== "string" || OF_A_CREDENTIAL.test(value)
    ? ""
    : value
        .replace(/[^\x20-\x7E]+/g, " ")
        .replace(/[A-Za-z0-9_-]{32,}/g, "…")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);

/**
 * OpenAI's error, as a refusal: by its code first, then its HTTP status when there is one (an error
 * inside the stream has none). Only sanitized words of OpenAI's reply are shown: an error with no
 * words of its own here ends with what OpenAI `said` of it, when it said something.
 */
export function refusalOf(
  code: string | undefined,
  at: { status?: number; requestId?: string | null; param?: string; said?: unknown } = {},
): Refused {
  const ref = at.requestId ? ` (request ${word(at.requestId)})` : "";
  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
      return new Refused(
        "usage_limit",
        `Usage limit reached. Review your plan or this app's limit in ChatGPT settings: ${USAGE_SETTINGS}`,
      );
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return new Refused(
        "unavailable",
        "ChatGPT plan usage is unavailable right now. Try again later.",
      );
    case "rate_limit_exceeded":
    case "slow_down":
      return new Refused(
        "unavailable",
        "OpenAI is limiting how often requests are made right now. Try again later.",
      );
    case "subscription_sharing_user_not_eligible":
      return notEligible();
    case "subscription_sharing_unsupported_capability":
      return new Refused(
        "unsupported",
        `The request asked for something plan usage doesn't support${at.param ? `: ${word(at.param)}` : ""}${ref}.`,
      );
  }
  if (at.status === 429) return refusalOf("subscription_sharing_usage_limit_exceeded", at);
  if (at.status === 503) return refusalOf("subscription_sharing_usage_unavailable", at);
  const what = code ? ` ${word(code)}` : "";
  // A reply that refuses the sign-in is about the token it was sent: none of it is shown.
  const said = at.status === 401 || at.status === 403 ? "" : saidOf(at.said);
  const reason = said ? ` OpenAI said: ${said}` : "";
  return new Refused(
    "failed",
    at.status === undefined
      ? `OpenAI ended the response with an error${what}${ref}.${reason}`
      : `OpenAI answered ${at.status}${what}${ref}.${reason}`,
  );
}

/**
 * The refusals by which OpenAI read a request and wouldn't take it as it is: a 400 or a 422, and
 * an error inside a response's stream.
 */
const notTaken = new WeakSet<Refused>();

/** A reply that isn't a response, as a refusal, marked when it passes, with the wait it asks for. */
async function errorOf(response: Response) {
  let error: { code?: unknown; param?: unknown; message?: unknown } | undefined;
  try {
    error = ((await response.json()) as { error?: typeof error }).error;
  } catch {
    // Admission errors may carry only `detail`, which is diagnostic and isn't echoed.
  }
  const code = typeof error?.code === "string" ? error.code : undefined;
  const refused = refusalOf(code, {
    status: response.status,
    requestId: response.headers.get("x-request-id"),
    ...(typeof error?.param === "string" ? { param: error.param } : {}),
    said: error?.message,
  });
  const waitMs = waitOf(response.headers);
  if (response.status === 400 || response.status === 422) notTaken.add(refused);
  return marked(refused, {
    status: response.status,
    ...(code === undefined ? {} : { code }),
    ...(waitMs === undefined ? {} : { waitMs }),
  });
}

const BLANK_LINE = /\r?\n\r?\n/;

/** Server-sent events, one parsed `data` object at a time, until the stream or `signal` ends. */
async function* events(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const stop = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", stop);
  let buffer = "";
  let done = false;
  try {
    while (!done) {
      const read = await reader.read();
      done = read.done;
      if (signal.aborted) return;
      buffer += decoder.decode(read.value, { stream: !done });
      for (let end = BLANK_LINE.exec(buffer); end; end = BLANK_LINE.exec(buffer)) {
        const block = buffer.slice(0, end.index);
        buffer = buffer.slice(end.index + end[0].length);
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data && data !== "[DONE]") {
          const parsed: unknown = JSON.parse(data);
          if (typeof parsed === "object" && parsed !== null)
            yield parsed as Record<string, unknown>;
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", stop);
    // A response that ended early leaves the rest of its body: close it.
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const toApi = (item: z.output<typeof Item>) => {
  switch (item.type) {
    case "message":
      return { type: "message", role: item.role, content: item.content };
    case "function_call":
      return {
        type: "function_call",
        call_id: item.callId,
        name: item.name,
        arguments: item.arguments,
      };
    case "function_call_output":
      return { type: "function_call_output", call_id: item.callId, output: item.output };
  }
};

/** The items of a completed response, as OpenAI gave them. */
const itemsOf = (response: Record<string, unknown>) =>
  Array.isArray(response.output) ? (response.output as Record<string, unknown>[]) : [];

/** One call's sealed reasoning is kept up to this many characters of JSON. */
const REASONING_CALL_MAX_CHARS = 200_000;
/**
 * The sealed reasoning kept for one caller is at most this many characters of JSON, the oldest
 * going first: it is also the most that is put back in one request.
 */
const REASONING_KEPT_MAX_CHARS = 400_000;

/** A call's reasoning, sealed by OpenAI, as it is sent back; and its size in characters. */
interface Sealed {
  items: Record<string, unknown>[];
  chars: number;
}

/**
 * The sealed reasoning in a response's output, by the id of the first call after each part.
 * Reasoning with nothing sealed can't be sent back with nothing stored at OpenAI, and reasoning
 * with no call after it has nothing to go back with: neither is kept.
 */
function sealedOf(output: Record<string, unknown>[]) {
  const found = new Map<string, Sealed>();
  let items: Record<string, unknown>[] = [];
  for (const item of output) {
    if (item.type === "reasoning") {
      if (typeof item.id !== "string" || typeof item.encrypted_content !== "string") continue;
      if (item.encrypted_content === "") continue;
      items.push({
        type: "reasoning",
        id: item.id,
        summary: Array.isArray(item.summary) ? item.summary : [],
        encrypted_content: item.encrypted_content,
      });
    } else if (item.type === "function_call" && typeof item.call_id === "string") {
      const chars = JSON.stringify(items).length;
      if (items.length && chars <= REASONING_CALL_MAX_CHARS)
        found.set(item.call_id, { items, chars });
      items = [];
    }
  }
  return found;
}

/** The final output items of a completed response: assistant text and function calls. */
function outputOf(response: Record<string, unknown>): Output[] {
  const output: Output[] = [];
  for (const item of itemsOf(response)) {
    if (item.type === "message" && Array.isArray(item.content)) {
      const text = (item.content as Record<string, unknown>[])
        .map((part) =>
          part.type === "output_text" && typeof part.text === "string"
            ? part.text
            : part.type === "refusal" && typeof part.refusal === "string"
              ? part.refusal
              : "",
        )
        .join("");
      output.push({ type: "message", role: "assistant", content: text });
    } else if (
      item.type === "function_call" &&
      typeof item.call_id === "string" &&
      typeof item.name === "string" &&
      typeof item.arguments === "string"
    )
      output.push({
        type: "function_call",
        callId: item.call_id,
        name: item.name,
        arguments: item.arguments,
      });
    // Reasoning is not a caller's to carry: it is kept here, by the call it came before.
  }
  return output;
}

const cancelled = () => new Refused("cancelled", "The response was cancelled.");

/** Wait `ms`, or until `signal` aborts, which rejects as cancelled and leaves no timer. */
export const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", done);
      resolve();
    }, ms);
    if (signal.aborted) done();
    else signal.addEventListener("abort", done, { once: true });
  });

export function createSession(options: {
  fetch: Fetch;
  account: Account;
  /**
   * Streamed text, for the one Actor whose request it answers: of the reply, or with `call`, of
   * that function call's arguments.
   */
  delta(caller: string, requestId: string, text: string, call?: { id: string; name: string }): void;
  /** How a wait between two tries is spent, and the time: a timer and the clock, unless a test gives its own. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}) {
  const { fetch, account } = options;
  let listed: Promise<{ id: string; name: string }[]> | undefined;
  /**
   * Responses still running, by caller and request id, so a caller's `cancel` can stop its own and
   * no other's.
   */
  const running = new Map<string, AbortController>();
  /** Something of one caller's, by an id it gave: a request, or a call. */
  const keyOf = (caller: string, id: string) => `${caller}\0${id}`;

  /**
   * The sealed reasoning kept, by caller and call id, the oldest first. It is put back before
   * its call in that caller's later requests until a user message follows the call. It is held
   * in memory until `REASONING_KEPT_MAX_CHARS` pushes it out, the account's state changes, or
   * this program stops; it is never given to a caller.
   */
  const sealed = new Map<string, Sealed>();
  /** Counts the changes of the account's state: what one account sealed is not kept for the next. */
  let accounts = 0;
  const keep = (caller: string, output: Record<string, unknown>[]) => {
    for (const [callId, one] of sealedOf(output)) {
      sealed.delete(keyOf(caller, callId));
      sealed.set(keyOf(caller, callId), one);
    }
    const own = [...sealed].filter(([key]) => key.startsWith(keyOf(caller, "")));
    let total = own.reduce((sum, [, one]) => sum + one.chars, 0);
    for (const [key, { chars }] of own) {
      if (total <= REASONING_KEPT_MAX_CHARS) break;
      sealed.delete(key);
      total -= chars;
    }
  };
  /**
   * A request's items as the API takes them, with the reasoning kept for each call after the
   * last user message put back before it: before the assistant messages directly before the
   * call, which are the words the model wrote with it. `used` is what was put back.
   */
  const inputOf = (input: RespondInput, caller: string) => {
    const lastUser = input.input.findLastIndex(
      (item) => item.type === "message" && item.role === "user",
    );
    const items: Record<string, unknown>[] = [];
    const used: string[] = [];
    for (const [at, item] of input.input.entries()) {
      const key = item.type === "function_call" ? keyOf(caller, item.callId) : undefined;
      const kept = key !== undefined && at > lastUser ? sealed.get(key) : undefined;
      if (kept && key !== undefined) {
        let before = at;
        while (before > lastUser + 1) {
          const one = input.input[before - 1];
          if (one?.type !== "message" || one.role !== "assistant") break;
          before--;
        }
        items.splice(items.length - (at - before), 0, ...kept.items);
        used.push(key);
      }
      items.push(toApi(item));
    }
    return { items, used };
  };

  /** A request with the access token, refreshed and tried once more if OpenAI says 401. */
  const authorized = async (
    build: (token: string) => Request,
    signal?: AbortSignal,
  ): Promise<Response> => {
    let response: Response;
    try {
      response = await fetch(build(await account.token()));
      if (response.status === 401) {
        await response.body?.cancel();
        response = await fetch(build(await account.token(true)));
      }
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      // The account's own refusal: a refresh that couldn't reach OpenAI passes as a request does.
      if (error instanceof Refused) throw marked(error);
      throw pass(new Refused("unavailable", "OpenAI couldn't be reached. Try again later."));
    }
    if (!response.ok) {
      const refused = await errorOf(response);
      if (refused.code === "ineligible") await account.ineligible();
      throw refused;
    }
    return response;
  };

  const models = () => {
    listed ??= (async () => {
      const response = await authorized(
        (token) => new Request(`${API}/models`, { headers: { authorization: `Bearer ${token}` } }),
      );
      const body = (await response.json().catch(() => ({}))) as { models?: unknown };
      if (!Array.isArray(body.models))
        throw refusalOf("bad_models", { requestId: response.headers.get("x-request-id") });
      return (body.models as Record<string, unknown>[])
        .filter((model) => model?.visibility === "list" && typeof model.slug === "string")
        .map((model) => ({
          id: (model.slug as string).slice(0, 128),
          name: (typeof model.display_name === "string"
            ? model.display_name
            : (model.slug as string)
          ).slice(0, 256),
        }));
    })().catch((error: unknown) => {
      listed = undefined;
      // A refusal of the listing is not one of a request.
      if (error instanceof Refused) notTaken.delete(error);
      throw error;
    });
    return listed;
  };

  /**
   * One try, sending `items`. `wrote` is told when text of it, or of a call's arguments, has been
   * streamed: such a try is not made again.
   */
  async function stream(
    input: RespondInput,
    items: Record<string, unknown>[],
    caller: string,
    signal: AbortSignal,
    wrote: () => void,
  ) {
    const asked = accounts;
    const model = input.model ?? (await models())[0]?.id;
    if (!model) throw new Refused("failed", "No model is offered to this account.");
    if (signal.aborted) throw cancelled();
    const body = JSON.stringify({
      model,
      instructions: input.instructions,
      input: items,
      // Nothing is stored at OpenAI, so reasoning comes back sealed, to be sent with its calls.
      include: ["reasoning.encrypted_content"],
      ...(input.tools?.length
        ? {
            tools: input.tools.map((tool) => ({
              type: "function",
              name: tool.name,
              ...(tool.description === undefined ? {} : { description: tool.description }),
              parameters: tool.parameters,
              strict: false,
            })),
          }
        : {}),
      stream: true,
      store: false,
    });
    const response = await authorized(
      (token) =>
        new Request(`${API}/responses`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body,
          signal,
        }),
      signal,
    );
    const requestId = response.headers.get("x-request-id");
    if (!response.body) throw refusalOf("empty_stream", { status: response.status, requestId });
    /** An error OpenAI sent inside the stream, marked when it passes. */
    const inStream = async (error: Record<string, unknown>) => {
      const code = typeof error.code === "string" ? error.code : undefined;
      const refused = refusalOf(code, { requestId, said: error.message });
      notTaken.add(refused);
      if (refused.code === "ineligible") await account.ineligible();
      return marked(refused, code ? { code } : {});
    };
    /** Each function call the response is writing, by its item's id. */
    const calls = new Map<string, { id: string; name: string }>();
    try {
      for await (const event of events(response.body, signal)) {
        switch (event.type) {
          case "response.output_text.delta":
            if (typeof event.delta === "string") {
              wrote();
              options.delta(caller, input.requestId, event.delta);
            }
            break;
          case "response.output_item.added": {
            const item = (event.item ?? {}) as Record<string, unknown>;
            if (
              item.type === "function_call" &&
              typeof item.id === "string" &&
              typeof item.call_id === "string" &&
              typeof item.name === "string"
            )
              calls.set(item.id, { id: item.call_id, name: item.name });
            break;
          }
          case "response.function_call_arguments.delta": {
            const call = typeof event.item_id === "string" ? calls.get(event.item_id) : undefined;
            if (call && typeof event.delta === "string") {
              wrote();
              options.delta(caller, input.requestId, event.delta, call);
            }
            break;
          }
          case "response.completed": {
            const done = (event.response ?? {}) as Record<string, unknown>;
            // Not if the account's state changed while it was answered.
            if (accounts === asked) keep(caller, itemsOf(done));
            const usage = done.usage as Record<string, unknown> | undefined;
            return {
              output: outputOf(done),
              ...(typeof usage?.input_tokens === "number" && typeof usage.output_tokens === "number"
                ? { usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } }
                : {}),
            };
          }
          case "response.failed": {
            const error = ((event.response as Record<string, unknown> | undefined)?.error ??
              {}) as Record<string, unknown>;
            throw await inStream(error);
          }
          case "response.incomplete": {
            const details = (event.response as Record<string, unknown> | undefined)
              ?.incomplete_details as Record<string, unknown> | undefined;
            const why = word(details?.reason);
            throw new Refused("failed", `The response ended incomplete${why ? ` (${why})` : ""}.`);
          }
          case "error":
            throw await inStream(event);
        }
      }
    } catch (error) {
      if (error instanceof Refused) throw error;
      if (signal.aborted) throw cancelled();
      throw pass(new Refused("failed", "The response stream broke off."));
    }
    if (signal.aborted) throw cancelled();
    throw pass(new Refused("failed", "The response ended before it completed."));
  }

  /**
   * A response, tried again when its failure is marked as passing: OpenAI couldn't be reached,
   * said to try again later, its server failed or was overloaded, or the stream broke off.
   * `RETRIES` times at most, each after a wait that doubles from `BACKOFF_MS`, a tenth more or
   * less, or after the wait OpenAI asked for when that is longer. A wait past `WAIT_MAX_MS` isn't
   * taken, nor one that would begin a try more than `RETRY_WITHIN_MS` after the first: the
   * failure is the answer. Not once text of it, or of a call's arguments, has been streamed,
   * since those words may be with their reader and a new try would write them again; and not
   * once it is cancelled, which also ends a wait.
   *
   * A try that had reasoning put back, and that OpenAI wouldn't take as it is (`notTaken`) for
   * good with no words of its own (`failed`), before any text, is made once more without it, at
   * once and apart from those tries, and that reasoning is not sent again. It is the one part of
   * a request this program adds, and what was sealed for one model or sign-in may not be taken
   * with another: so a try after the account's state changed goes without it too.
   */
  async function tried(input: RespondInput, caller: string, signal: AbortSignal) {
    const now = options.now ?? Date.now;
    const began = now();
    const asked = accounts;
    let { items, used } = inputOf(input, caller);
    const bare = () => {
      used = [];
      items = input.input.map(toApi);
    };
    for (let failed = 0; ; ) {
      let written = false;
      if (accounts !== asked && used.length) bare();
      try {
        return await stream(input, items, caller, signal, () => {
          written = true;
        });
      } catch (error) {
        const again = error instanceof Refused ? passing.get(error) : undefined;
        const refused =
          error instanceof Refused && notTaken.has(error) && error.code === "failed" && !again;
        const inTime = now() - began <= RETRY_WITHIN_MS;
        if (refused && used.length && !written && inTime && !signal.aborted) {
          for (const key of used) sealed.delete(key);
          bare();
          continue;
        }
        if (!again || written || failed >= RETRIES || signal.aborted) throw error;
        const doubling = BACKOFF_MS * 2 ** failed * (0.9 + Math.random() * 0.2);
        const wait = Math.max(again.waitMs ?? 0, doubling);
        if (wait > WAIT_MAX_MS || now() - began + wait > RETRY_WITHIN_MS) throw error;
        await (options.wait ?? sleep)(wait, signal);
        if (signal.aborted) throw cancelled();
        failed++;
      }
    }
  }

  return {
    /** Stop every response still running. */
    stop() {
      for (const controller of running.values()) controller.abort();
    },
    /** Forget the model list and the reasoning kept: both are one account's. */
    reset() {
      listed = undefined;
      sealed.clear();
      accounts++;
    },
    async models() {
      return { models: await models() };
    },
    cancel({ requestId }: { requestId: string }, caller: string) {
      running.get(keyOf(caller, requestId))?.abort();
      return {};
    },
    async respond(input: RespondInput, caller: string) {
      const key = keyOf(caller, input.requestId);
      if (running.has(key))
        throw new Refused("invalid", "A response with this requestId is already running.");
      const controller = new AbortController();
      running.set(key, controller);
      try {
        return await tried(input, caller, controller.signal);
      } finally {
        running.delete(key);
      }
    },
  };
}
