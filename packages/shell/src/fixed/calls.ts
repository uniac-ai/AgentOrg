// From an agent's record to what a person reads. Tools we ship are known by their own name, whatever
// slot they came through, and only when the call has the shape that tool's calls have; anything else
// stays its name, input and output. A command and every poll of it are one thing.
import type { ChatMessage } from "./data.ts";

type State = NonNullable<ChatMessage["tool"]>["state"];
interface Base {
  id: string;
  at?: string;
  state: State;
}
export interface Command extends Base {
  kind: "command";
  cmd: string;
  workdir?: string;
  exit?: number;
  seconds: number;
  output: string;
  stopped: boolean;
}
/** A poll of a command whose start isn't in what's been read. */
export interface Poll extends Base {
  kind: "poll";
  output: string;
}
export interface Look extends Base {
  kind: "look";
  calls: { verb: "Read" | "Listed" | "Searched"; target: string; path?: string; output: string }[];
}
export interface Edit extends Base {
  kind: "edit";
  path: string;
  output: string;
  added: number;
  removed: number;
}
export interface PageStep extends Base {
  kind: "page";
  text: string;
  url?: string;
  title?: string;
  snapshot?: string;
}
export interface Find extends Base {
  kind: "find";
  query: string;
  results: { title: string; url: string }[];
}
export interface Fetch extends Base {
  kind: "fetch";
  urls: string[];
  output: string;
}
export interface Other extends Base {
  kind: "other";
  name: string;
  input?: string;
  output?: string;
}
export interface Say {
  kind: "say";
  id: string;
  at?: string;
  text: string;
  state?: undefined;
}
export type Call = Command | Poll | Look | Edit | PageStep | Find | Fetch | Other;
export type Row = Call | Say;

type Input = Record<string, unknown>;

function inputOf(text: string | undefined): Input {
  try {
    const parsed: unknown = JSON.parse(text ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Input) : {};
  } catch {
    return {};
  }
}

/** A tool's own name: what's after its slot. */
const toolOf = (name: string) => {
  const at = name.lastIndexOf("__");
  return at === -1 ? name : name.slice(at + 2);
};

/** AgentExec's fixed answer to `exec_command` and `write_stdin`. */
function answerOf(text = "") {
  const found = /^exit_code: (.+)\nseconds: (.+)\nsession_id: (.+)\ntext:\n?([\s\S]*)$/.exec(text);
  if (!found) return undefined;
  const [, exit, seconds, session, output] = found as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    exit: exit === "running" ? undefined : Number(exit),
    seconds: Number(seconds),
    session,
    output,
  };
}

function counted(diff: string) {
  const lines = diff.split("\n");
  return {
    added: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
    removed: lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length,
  };
}

/** Only `browser_snapshot` carries the page's text; a step may have no page section at all. */
function pageOf(text = "") {
  const url = /^- Page URL: (.+)$/m.exec(text)?.[1];
  const title = /^- Page Title: (.+)$/m.exec(text)?.[1];
  const snapshot = /```yaml\n([\s\S]*?)\n```/.exec(text)?.[1];
  return {
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
    ...(snapshot ? { snapshot } : {}),
  };
}

export const shortUrl = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");
export const baseName = (path: string) => path.split("/").at(-1) ?? path;

/** Playwright names what it acted on in `element`, when given, or else `target`. */
const onWhat = (input: Input) => String(input.element ?? input.target ?? "");
const STEP: Record<string, (input: Input) => string> = {
  browser_navigate: (input) => `Opened ${shortUrl(String(input.url))}`,
  browser_click: (input) => `Clicked ${onWhat(input)}`.trim(),
  browser_type: (input) => `Typed in ${onWhat(input)}`.trim(),
  browser_snapshot: () => "Looked at the page",
  browser_press_key: (input) => `Pressed ${input.key}`,
};
const LOOKS = { read: "Read", list: "Listed", search: "Searched" } as const;

/** Why a refused call was refused: its `{error: {message}}`, or the text as it came. */
export function refusalOf(output = ""): string {
  try {
    const message = (JSON.parse(output) as { error?: { message?: unknown } }).error?.message;
    return typeof message === "string" ? message : output;
  } catch {
    return output;
  }
}

/** The record as rows, in order; a poll joins the command it polls, and adds no row. */
export function rowsOf(messages: readonly ChatMessage[]): Row[] {
  const rows: Row[] = [];
  const running = new Map<string, Command>();
  for (const message of messages) {
    const { tool } = message;
    if (message.role === "user") continue;
    if (!tool) {
      rows.push({ kind: "say", id: message.id, at: message.at, text: message.text });
      continue;
    }
    const name = toolOf(tool.name);
    const input = inputOf(tool.input);
    const common = { id: message.id, at: message.at, state: tool.state };
    const answer = answerOf(tool.output);
    const ended = tool.state !== "running";
    const other = () =>
      rows.push({
        ...common,
        kind: "other",
        name: tool.name,
        ...(tool.input ? { input: tool.input } : {}),
        ...(tool.output ? { output: tool.output } : {}),
      });
    if (name === "exec_command" && typeof input.cmd === "string") {
      if (tool.state === "done" && !answer) {
        other();
        continue;
      }
      const command: Command = {
        ...common,
        kind: "command",
        cmd: input.cmd,
        ...(typeof input.workdir === "string" ? { workdir: input.workdir } : {}),
        ...(answer?.exit !== undefined ? { exit: answer.exit } : {}),
        seconds: answer?.seconds ?? 0,
        output: tool.state === "refused" ? refusalOf(tool.output) : (answer?.output ?? ""),
        stopped: false,
        state: tool.state === "done" && answer?.exit === undefined ? "running" : tool.state,
      };
      if (answer && answer.session !== "none") running.set(answer.session, command);
      rows.push(command);
    } else if (name === "write_stdin" && typeof input.session_id === "string") {
      const command = running.get(input.session_id);
      if (!command) {
        rows.push({ ...common, kind: "poll", output: answer?.output ?? refusalOf(tool.output) });
        continue;
      }
      const chars = typeof input.chars === "string" ? input.chars : "";
      // A poll's seconds are only that wait: how long it has run comes from when it started.
      const lasted = (Date.parse(message.at) - Date.parse(command.at ?? message.at)) / 1000;
      if (answer) command.seconds = (lasted || 0) + answer.seconds;
      command.stopped ||= chars === "\u0003";
      // Each answer is exactly what it wrote since the last: only what was typed needs a line.
      if (chars && chars !== "\u0003" && chars !== "\u0004")
        command.output += `${command.output && !command.output.endsWith("\n") ? "\n" : ""}> ${chars}\n`;
      command.output += answer?.output ?? "";
      if (answer?.exit !== undefined) {
        command.exit = answer.exit;
        command.state = "done";
        running.delete(input.session_id);
      }
    } else if (
      name in LOOKS &&
      typeof (name === "search" ? input.pattern : input.path) === "string"
    ) {
      const verb = LOOKS[name as keyof typeof LOOKS];
      const call = {
        verb,
        target: String(name === "search" ? input.pattern : input.path),
        ...(name === "search" && typeof input.path === "string" ? { path: input.path } : {}),
        output: tool.state === "refused" ? refusalOf(tool.output) : (tool.output ?? ""),
      };
      const last = rows.at(-1);
      if (last?.kind === "look" && last.state === "done" && tool.state === "done") {
        last.calls.push(call);
        last.at = message.at;
      } else rows.push({ ...common, kind: "look", calls: [call] });
    } else if (
      name === "edit" &&
      typeof input.path === "string" &&
      (!ended || tool.state === "refused" || tool.output?.includes("@@"))
    ) {
      const output = tool.state === "refused" ? refusalOf(tool.output) : (tool.output ?? "");
      rows.push({
        ...common,
        kind: "edit",
        path: input.path,
        output,
        ...(tool.state === "done" ? counted(output) : { added: 0, removed: 0 }),
      });
    } else if (STEP[name]) {
      rows.push({
        ...common,
        kind: "page",
        text: (STEP[name] as (input: Input) => string)(input),
        ...pageOf(tool.output),
      });
    } else if (name === "web_search_exa" && typeof input.query === "string") {
      const results = [...(tool.output ?? "").matchAll(/^Title: (.+)\nURL: (.+)$/gm)].map((m) => ({
        title: m[1] as string,
        url: m[2] as string,
      }));
      rows.push({ ...common, kind: "find", query: input.query, results });
    } else if (name === "web_fetch_exa" && Array.isArray(input.urls)) {
      rows.push({
        ...common,
        kind: "fetch",
        urls: input.urls.map(String),
        output: tool.output ?? "",
      });
    } else other();
  }
  return rows;
}

export const failed = (c: Command) => !c.stopped && c.exit !== undefined && c.exit !== 0;

function lookLine(look: Look): string {
  const count = (verb: string) => look.calls.filter((c) => c.verb === verb).length;
  const [only] = look.calls;
  if (only && look.calls.length === 1)
    return only.verb === "Searched"
      ? `Searched for ${only.target}`
      : `${only.verb} ${baseName(only.target)}`;
  const reads = count("Read");
  const lists = count("Listed");
  const found = look.calls.find((c) => c.verb === "Searched");
  const parts = [
    reads ? `read ${reads === 1 ? "a file" : `${reads} files`}` : "",
    lists ? `listed ${lists === 1 ? "a folder" : `${lists} folders`}` : "",
    found ? `searched for ${found.target}` : "",
  ].filter(Boolean);
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The row as one sentence. */
export function lineOfRow(row: Row): string {
  switch (row.kind) {
    case "say":
      return row.text;
    case "command":
      if (row.state === "running") return `Running ${row.cmd}`;
      if (row.state === "refused") return `Couldn't run ${row.cmd}`;
      if (row.stopped) return `Stopped ${row.cmd}`;
      return failed(row) ? `${row.cmd} failed, exit ${row.exit}` : `Ran ${row.cmd}`;
    case "poll":
      return "Checked a running command";
    case "look":
      return lookLine(row);
    case "edit":
      if (row.state === "refused") return `Couldn't edit ${baseName(row.path)}`;
      return `${row.output.includes("@@ -0,0") ? "Created" : "Edited"} ${baseName(row.path)}`;
    case "page":
      return row.text;
    case "find":
      return `Searched the web for ${row.query}`;
    case "fetch":
      return `Read ${row.urls.map(shortUrl).join(", ")}`;
    case "other":
      return row.name;
  }
}
