/**
 * Connecting a project's sessions to AgentOrg, per client. A client's configuration in the project
 * names the launcher, and its skills folder links the package's `agentorg` skill, so both match the
 * installed command whatever the client's `PATH`. `connect` writes only entries it can find again:
 * connecting again replaces them, and `disconnect` removes them and nothing of the user's.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { PACKAGE } from "./launcher.ts";

export interface Client {
  /** Write the client's configuration and the skill link; return the paths written. */
  connect(project: string, launcher: string): string[];
  /** Remove them; return the paths changed. */
  disconnect(project: string): string[];
  /** Undefined when the project isn't connected, else what is wrong with its connection. */
  problems(project: string, launcher: string): string[] | undefined;
}

const SKILL = join(PACKAGE, "skills", "agentorg");

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readJson(path: string): Json {
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!isObject(value)) throw new Error(`${path} does not hold a JSON object`);
  return value;
}

/** Write a JSON object, or remove the file once nothing is left in it. */
function writeJson(path: string, value: Json): void {
  if (Object.keys(value).length === 0) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Remove the empty folders from `folder` up to, not including, the project. */
function prune(folder: string, project: string): void {
  for (let at = folder; at !== project && at.startsWith(project); at = dirname(at)) {
    if (!existsSync(at) || readdirSync(at).length > 0) return;
    rmdirSync(at);
  }
}

const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/** The skill as `<folder>/agentorg`, a link to the package's, replacing an earlier link. */
function linkSkill(folder: string): string {
  const link = join(folder, "agentorg");
  if (existsSync(link) && !isLink(link)) {
    throw new Error(`${link} is not a link to AgentOrg's skill; move it away first`);
  }
  mkdirSync(folder, { recursive: true });
  rmSync(link, { force: true });
  symlinkSync(SKILL, link);
  return link;
}

function unlinkSkill(folder: string, project: string): string[] {
  const link = join(folder, "agentorg");
  if (!isLink(link)) return [];
  rmSync(link);
  prune(folder, project);
  return [link];
}

function skillProblems(folder: string): string[] {
  const link = join(folder, "agentorg");
  if (!isLink(link)) return [`${link} is not a link to AgentOrg's skill`];
  const target = readlinkSync(link);
  if (target !== SKILL) return [`${link} links ${target}, not this package's skill`];
  return [];
}

const shellWord = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** The agent actor's arguments for a client. */
const agentArgs = (client: string) => ["agent", "--client", client];

// Claude Code: the server in `.mcp.json`, approved and hooked in `.claude/settings.local.json`, the
// user's own settings for the project, and the skill in `.claude/skills/`.

const CLAUDE_HOOK = / agent (context|prompt|wait) --client claude-code$/;

function claudeHooks(launcher: string): Record<string, Json[]> {
  const hook = (sub: string) => `${shellWord(launcher)} agent ${sub} --client claude-code`;
  const waiter = {
    type: "command",
    command: hook("wait"),
    asyncRewake: true,
    timeout: 604800,
    rewakeMessage: "From AgentOrg:",
    rewakeSummary: "AgentOrg message",
  };
  return {
    SessionStart: [{ type: "command", command: hook("context"), timeout: 10 }, waiter],
    UserPromptSubmit: [{ type: "command", command: hook("prompt"), timeout: 10 }],
    Stop: [waiter],
  };
}

const ours = (hook: unknown) =>
  isObject(hook) && typeof hook.command === "string" && CLAUDE_HOOK.test(hook.command);

/** Each event's matcher groups with AgentOrg's hooks taken out, and groups left empty dropped. */
function withoutOurHooks(hooks: Json): Json {
  const kept: Json = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      kept[event] = groups;
      continue;
    }
    const left = groups.flatMap((group) => {
      if (!isObject(group) || !Array.isArray(group.hooks)) return [group];
      const remaining = group.hooks.filter((hook) => !ours(hook));
      return remaining.length === 0 ? [] : [{ ...group, hooks: remaining }];
    });
    if (left.length > 0) kept[event] = left;
  }
  return kept;
}

const claudeFiles = (project: string) => ({
  servers: join(project, ".mcp.json"),
  settings: join(project, ".claude", "settings.local.json"),
  skills: join(project, ".claude", "skills"),
});

/** The project's `org` server, when it is the agent actor. */
function claudeServer(path: string): Json | undefined {
  const servers = readJson(path).mcpServers;
  const org = isObject(servers) ? servers.org : undefined;
  if (org === undefined) return undefined;
  if (!isObject(org) || !Array.isArray(org.args) || org.args[0] !== "agent") {
    throw new Error(`${path} already has an MCP server named org that isn't AgentOrg's`);
  }
  return org;
}

const claudeCode: Client = {
  connect(project, launcher) {
    const files = claudeFiles(project);
    claudeServer(files.servers);
    const config = readJson(files.servers);
    const servers = isObject(config.mcpServers) ? config.mcpServers : {};
    config.mcpServers = { ...servers, org: { command: launcher, args: agentArgs("claude-code") } };
    writeJson(files.servers, config);

    const settings = readJson(files.settings);
    const approved = Array.isArray(settings.enabledMcpjsonServers)
      ? settings.enabledMcpjsonServers
      : [];
    if (!approved.includes("org")) settings.enabledMcpjsonServers = [...approved, "org"];
    const hooks = withoutOurHooks(isObject(settings.hooks) ? settings.hooks : {});
    for (const [event, added] of Object.entries(claudeHooks(launcher))) {
      const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
      hooks[event] = [...groups, { hooks: added }];
    }
    settings.hooks = hooks;
    writeJson(files.settings, settings);

    return [files.servers, files.settings, linkSkill(files.skills)];
  },

  disconnect(project) {
    const files = claudeFiles(project);
    const changed: string[] = [];
    if (claudeServer(files.servers) !== undefined) {
      const config = readJson(files.servers);
      const { org: _, ...servers } = config.mcpServers as Json;
      if (Object.keys(servers).length > 0) config.mcpServers = servers;
      else delete config.mcpServers;
      writeJson(files.servers, config);
      changed.push(files.servers);
    }
    if (existsSync(files.settings)) {
      const settings = readJson(files.settings);
      const before = JSON.stringify(settings);
      if (Array.isArray(settings.enabledMcpjsonServers)) {
        const approved = settings.enabledMcpjsonServers.filter((name) => name !== "org");
        if (approved.length > 0) settings.enabledMcpjsonServers = approved;
        else delete settings.enabledMcpjsonServers;
      }
      if (isObject(settings.hooks)) {
        const hooks = withoutOurHooks(settings.hooks);
        if (Object.keys(hooks).length > 0) settings.hooks = hooks;
        else delete settings.hooks;
      }
      if (JSON.stringify(settings) !== before) {
        writeJson(files.settings, settings);
        prune(dirname(files.settings), project);
        changed.push(files.settings);
      }
    }
    return [...changed, ...unlinkSkill(files.skills, project)];
  },

  problems(project, launcher) {
    const files = claudeFiles(project);
    const org = claudeServer(files.servers);
    if (org === undefined) return undefined;
    const found: string[] = [];
    if (org.command !== launcher) found.push(`${files.servers} names ${org.command}`);
    const settings = readJson(files.settings);
    const approved = settings.enabledMcpjsonServers;
    if (!Array.isArray(approved) || !approved.includes("org")) {
      found.push(`${files.settings} doesn't approve the org server`);
    }
    const expected = claudeHooks(launcher);
    const hooks = isObject(settings.hooks) ? settings.hooks : {};
    for (const [event, added] of Object.entries(expected)) {
      const present = (Array.isArray(hooks[event]) ? hooks[event] : []).flatMap((group) =>
        isObject(group) && Array.isArray(group.hooks) ? group.hooks.filter(ours) : [],
      );
      const commands = (list: Json[]) => list.map((hook) => hook.command).join("\n");
      if (commands(present) !== commands(added)) {
        found.push(`${files.settings} lacks AgentOrg's ${event} hooks for this launcher`);
      }
    }
    return [...found, ...skillProblems(files.skills)];
  },
};

// Codex: the `[mcp_servers.org]` table in `.codex/config.toml`, and the skill in
// `.agents/skills/`. Codex reads the project's file once the user trusts the project.

const TABLE_HEADER = /^\s*\[{1,2}([^\]]*)\]{1,2}\s*(#.*)?$/;
const OUR_TABLE = "mcp_servers.org";

/** The line ranges of `[mcp_servers.org]` and its subtables, each up to the next header. */
function ourTables(lines: string[]): [number, number][] {
  const ranges: [number, number][] = [];
  let start: number | undefined;
  lines.forEach((line, index) => {
    const header = TABLE_HEADER.exec(line);
    if (!header) return;
    if (start !== undefined) ranges.push([start, index]);
    const key = (header[1] ?? "").replace(/["'\s]/g, "");
    start = key === OUR_TABLE || key.startsWith(`${OUR_TABLE}.`) ? index : undefined;
  });
  if (start !== undefined) ranges.push([start, lines.length]);
  return ranges;
}

function codexTable(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, "utf8").split("\n");
  const ranges = ourTables(lines);
  if (ranges.length === 0) return undefined;
  const text = ranges.flatMap(([start, end]) => lines.slice(start, end)).join("\n");
  if (!/^\s*args\s*=\s*\[\s*"agent"/m.test(text)) {
    throw new Error(`${path} already has an MCP server named org that isn't AgentOrg's`);
  }
  return text;
}

/** The file's lines with our tables replaced by `table`, where the first of them was. */
function replaceTables(path: string, table: string[]): string {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const ranges = ourTables(lines);
  const at = ranges[0]?.[0] ?? lines.length;
  const kept = lines.filter((_, index) => !ranges.some(([s, e]) => index >= s && index < e));
  const before = kept.slice(0, at).join("\n").trimEnd();
  const after = kept.slice(at).join("\n").trim();
  const body = table.join("\n");
  return [before, body, after].filter((part) => part !== "").join("\n\n");
}

const codexFiles = (project: string) => ({
  config: join(project, ".codex", "config.toml"),
  skills: join(project, ".agents", "skills"),
});

const codex: Client = {
  connect(project, launcher) {
    const files = codexFiles(project);
    codexTable(files.config);
    const table = [
      `[${OUR_TABLE}]`,
      `command = ${JSON.stringify(launcher)}`,
      `args = ${JSON.stringify(agentArgs("codex")).replaceAll(",", ", ")}`,
    ];
    mkdirSync(dirname(files.config), { recursive: true });
    writeFileSync(files.config, `${replaceTables(files.config, table)}\n`);
    return [files.config, linkSkill(files.skills)];
  },

  disconnect(project) {
    const files = codexFiles(project);
    const changed: string[] = [];
    if (codexTable(files.config) !== undefined) {
      const left = replaceTables(files.config, []);
      if (left === "") rmSync(files.config);
      else writeFileSync(files.config, `${left}\n`);
      prune(dirname(files.config), project);
      changed.push(files.config);
    }
    return [...changed, ...unlinkSkill(files.skills, project)];
  },

  problems(project, launcher) {
    const files = codexFiles(project);
    const table = codexTable(files.config);
    if (table === undefined) return undefined;
    const command = /^\s*command\s*=\s*(".*")\s*$/m.exec(table)?.[1];
    const named = command === undefined ? undefined : JSON.parse(command);
    const found = named === launcher ? [] : [`${files.config} names ${named ?? "no command"}`];
    return [...found, ...skillProblems(files.skills)];
  },
};

export const CLIENTS: Record<string, Client> = { "claude-code": claudeCode, codex };

export function clientOf(name: string | undefined): Client {
  const found = name !== undefined && Object.hasOwn(CLIENTS, name) ? CLIENTS[name] : undefined;
  if (found === undefined) {
    throw new Error(`name a client: ${Object.keys(CLIENTS).join(" or ")}`);
  }
  return found;
}
