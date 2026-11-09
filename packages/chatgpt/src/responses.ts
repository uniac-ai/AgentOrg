/** Inference on the person's ChatGPT plan: the Responses API, streamed, with nothing stored. */
import type { Item, llmSession, OutputItem } from "@agentorg/interfaces";
import { Refused } from "@agentorg/sdk";
import type { z } from "zod";
import { type Account, notEligible } from "./account.js";
import { type Fetch, word } from "./oauth.js";

const API = "https://api.openai.com/v1";
export const USAGE_SETTINGS = "https://chatgpt.com/settings/usage";

type RespondInput = z.output<typeof llmSession.methods.respond.input>;
type Output = z.output<typeof OutputItem>;

/**
 * OpenAI's error, as a refusal: by its code first, then its HTTP status when there is one (an error
 * inside the stream has none). Only sanitized words of OpenAI's reply are shown.
 */
export function refusalOf(
  code: string | undefined,
  at: { status?: number; requestId?: string | null; param?: string } = {},
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
  return new Refused(
    "failed",
    at.status === undefined
      ? `OpenAI ended the response with an error${what}${ref}.`
      : `OpenAI answered ${at.status}${what}${ref}.`,
  );
}

async function errorOf(response: Response) {
  let error: { code?: unknown; param?: unknown } | undefined;
  try {
    error = ((await response.json()) as { error?: typeof error }).error;
  } catch {
    // Admission errors may carry only `detail`, which is diagnostic and isn't echoed.
  }
  return refusalOf(typeof error?.code === "string" ? error.code : undefined, {
    status: response.status,
    requestId: response.headers.get("x-request-id"),
    ...(typeof error?.param === "string" ? { param: error.param } : {}),
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

/** The final output items of a completed response: assistant text and function calls. */
function outputOf(response: Record<string, unknown>): Output[] {
  const items = Array.isArray(response.output)
    ? (response.output as Record<string, unknown>[])
    : [];
  const output: Output[] = [];
  for (const item of items) {
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
    // Reasoning items aren't carried: nothing is stored, and the next request sends the history.
  }
  return output;
}

const cancelled = () => new Refused("cancelled", "The response was cancelled.");

export function createSession(options: {
  fetch: Fetch;
  account: Account;
  /** Streamed text, for the one Actor whose request it answers. */
  delta(caller: string, requestId: string, text: string): void;
}) {
  const { fetch, account } = options;
  let listed: Promise<{ id: string; name: string }[]> | undefined;
  /**
   * Responses still running, by caller and request id, so a caller's `cancel` can stop its own and
   * no other's.
   */
  const running = new Map<string, AbortController>();
  const keyOf = (caller: string, requestId: string) => `${caller}\0${requestId}`;

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
      if (error instanceof Refused || (error instanceof Error && error.name === "NotConnected"))
        throw error;
      throw new Refused("unavailable", "OpenAI couldn't be reached. Try again later.");
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
      throw error;
    });
    return listed;
  };

  async function stream(input: RespondInput, caller: string, signal: AbortSignal) {
    const model = input.model ?? (await models())[0]?.id;
    if (!model) throw new Refused("failed", "No model is offered to this account.");
    if (signal.aborted) throw cancelled();
    const body = JSON.stringify({
      model,
      instructions: input.instructions,
      input: input.input.map(toApi),
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
    try {
      for await (const event of events(response.body, signal)) {
        switch (event.type) {
          case "response.output_text.delta":
            if (typeof event.delta === "string")
              options.delta(caller, input.requestId, event.delta);
            break;
          case "response.completed": {
            const done = (event.response ?? {}) as Record<string, unknown>;
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
            const refused = refusalOf(typeof error.code === "string" ? error.code : undefined, {
              requestId,
            });
            if (refused.code === "ineligible") await account.ineligible();
            throw refused;
          }
          case "response.incomplete":
            throw new Refused("failed", "The response ended incomplete.");
          case "error":
            throw refusalOf(typeof event.code === "string" ? event.code : undefined, { requestId });
        }
      }
    } catch (error) {
      if (error instanceof Refused) throw error;
      if (signal.aborted) throw cancelled();
      throw new Refused("failed", "The response stream broke off.");
    }
    if (signal.aborted) throw cancelled();
    throw new Refused("failed", "The response ended before it completed.");
  }

  return {
    /** Stop every response still running. */
    stop() {
      for (const controller of running.values()) controller.abort();
    },
    /** Forget the model list, so it is read again for the next account. */
    reset() {
      listed = undefined;
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
        return await stream(input, caller, controller.signal);
      } finally {
        running.delete(key);
      }
    },
  };
}
