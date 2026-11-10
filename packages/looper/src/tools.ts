/** Running the functions a model calls, and what is kept of their output. */
import { codeOf, type Outcome, type Tool } from "./types.js";

/** A function's output keeps this many characters, so one result can't fill a request. */
export const MAX_OUTPUT = 30_000;

/**
 * `text`, or its first and last `MAX_OUTPUT / 2` characters with what was cut between them: a
 * failing command's error is at the end, and what it was doing at the start.
 */
export function capped(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  // Between characters: never half of a surrogate pair at either cut.
  const head = text.slice(0, MAX_OUTPUT / 2).replace(/[\uD800-\uDBFF]$/, "");
  const tail = text.slice(-MAX_OUTPUT / 2).replace(/^[\uDC00-\uDFFF]/, "");
  return `${head}\n… [${text.length - head.length - tail.length} characters cut] …\n${tail}`;
}

const failure = ({ code, message }: { code: string; message: string }) =>
  JSON.stringify({ error: { code, message } });

/** Run a function call: the result, or the refusal, as the function's output. */
export async function runTool(tools: Tool[], name: string, args: string): Promise<Outcome> {
  const refused = (code: string, message: string) => ({
    output: failure({ code, message }),
    ok: false,
    code,
  });
  const found = tools.find((tool) => tool.name === name);
  if (!found) return refused("unknown_tool", `No tool is named ${name.slice(0, 64)}.`);
  let input: unknown;
  try {
    input = args.trim() === "" ? {} : JSON.parse(args);
  } catch {
    return refused("invalid", "The arguments aren't JSON.");
  }
  try {
    return await found.run(input);
  } catch (error) {
    const { code, message } = codeOf(error);
    return refused(code, message);
  }
}
