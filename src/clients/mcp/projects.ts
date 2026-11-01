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
import { basename, dirname, join } from "node:path";
import { type AST, getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import type { Level } from "../../domain/model/index.ts";
import { PACKAGE } from "../../runtime/launcher.ts";

export interface Client {
  /** Write the client's configuration and the skill link; return the paths written. */
  connect(project: string, launcher: string, level?: Level): string[];
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

const agentArgs = (client: string, level: Level | undefined) => [
  "--client",
  client,
  ...(level === undefined ? [] : ["--level", level]),
];

// Claude Code: the server in `.mcp.json`, approved and hooked in `.claude/settings.local.json`, the
// user's own settings for the project, and the skill in `.claude/skills/`.

const HOOK_COMMAND = /\/agentorg-mcp' (context|prompt|wait) --client (claude-code|codex)$/;

function clientHooks(client: string, launcher: string): Record<string, Json[]> {
  const hook = (sub: string) => `${shellWord(launcher)} ${sub} --client ${client}`;
  const hooks: Record<string, Json[]> = {
    SessionStart: [{ type: "command", command: hook("context"), timeout: 10 }],
  };
  if (client === "codex") return hooks;
  const waiter = {
    type: "command",
    command: hook("wait"),
    asyncRewake: true,
    timeout: 604800,
    rewakeMessage: "From AgentOrg:",
    rewakeSummary: "AgentOrg message",
  };
  hooks.SessionStart?.push(waiter);
  hooks.Stop = [waiter];
  return hooks;
}

const ours = (hook: unknown, client: string) =>
  isObject(hook) &&
  typeof hook.command === "string" &&
  HOOK_COMMAND.exec(hook.command)?.[2] === client;

/** Each event's matcher groups with AgentOrg's hooks taken out, and groups left empty dropped. */
function withoutOurHooks(hooks: Json, client: string): Json {
  const kept: Json = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      kept[event] = groups;
      continue;
    }
    const left = groups.flatMap((group) => {
      if (!isObject(group) || !Array.isArray(group.hooks)) return [group];
      const remaining = group.hooks.filter((hook) => !ours(hook, client));
      return remaining.length === 0 ? [] : [{ ...group, hooks: remaining }];
    });
    if (left.length > 0) kept[event] = left;
  }
  return kept;
}

function withOurHooks(settings: Json, client: string, launcher: string): void {
  const hooks = withoutOurHooks(isObject(settings.hooks) ? settings.hooks : {}, client);
  for (const [event, added] of Object.entries(clientHooks(client, launcher))) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [...groups, { hooks: added }];
  }
  settings.hooks = hooks;
}

function removeOurHooks(settings: Json, client: string): void {
  if (!isObject(settings.hooks)) return;
  const hooks = withoutOurHooks(settings.hooks, client);
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;
  else delete settings.hooks;
}

function hookProblems(settings: Json, path: string, client: string, launcher: string): string[] {
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  return Object.entries(clientHooks(client, launcher)).flatMap(([event, added]) => {
    const present = (Array.isArray(hooks[event]) ? hooks[event] : []).flatMap((group) =>
      isObject(group) && Array.isArray(group.hooks)
        ? group.hooks.filter((hook) => ours(hook, client))
        : [],
    );
    return JSON.stringify(present) === JSON.stringify(added)
      ? []
      : [`${path} lacks AgentOrg's ${event} hooks for this launcher`];
  });
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
  if (
    !isObject(org) ||
    typeof org.command !== "string" ||
    basename(org.command) !== "agentorg-mcp"
  ) {
    throw new Error(`${path} already has an MCP server named org that isn't AgentOrg's`);
  }
  return org;
}

const claudeCode: Client = {
  connect(project, launcher, level) {
    const files = claudeFiles(project);
    claudeServer(files.servers);
    const config = readJson(files.servers);
    const servers = isObject(config.mcpServers) ? config.mcpServers : {};
    config.mcpServers = {
      ...servers,
      org: { command: launcher, args: agentArgs("claude-code", level) },
    };
    writeJson(files.servers, config);

    const settings = readJson(files.settings);
    const approved = Array.isArray(settings.enabledMcpjsonServers)
      ? settings.enabledMcpjsonServers
      : [];
    if (!approved.includes("org")) settings.enabledMcpjsonServers = [...approved, "org"];
    withOurHooks(settings, "claude-code", launcher);
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
      removeOurHooks(settings, "claude-code");
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
    found.push(...hookProblems(settings, files.settings, "claude-code", launcher));
    return [...found, ...skillProblems(files.skills)];
  },
};

// Codex: the server in `.codex/config.toml`, hooks in `.codex/hooks.json` and the skill in
// `.agents/skills/`. Project configuration and hook definitions require Codex trust.

const OUR_TABLE = "mcp_servers.org";

/** The parsed AgentOrg table and its source, with unrelated configuration kept verbatim. */
function codexConfig(path: string) {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  let ast: AST.TOMLProgram;
  try {
    ast = parseTOML(text, { tomlVersion: "1.0" });
  } catch {
    throw new Error(`${path} is not valid TOML`);
  }
  const tables = ast.body[0].body.filter(
    (node): node is AST.TOMLTable =>
      node.type === "TOMLTable" &&
      node.resolvedKey[0] === "mcp_servers" &&
      node.resolvedKey[1] === "org",
  );
  const table = tables.find((node) => node.kind === "standard" && node.resolvedKey.length === 2);
  const values = getStaticTOMLValue(ast);
  const configured = isObject(values.mcp_servers) ? values.mcp_servers.org : undefined;
  const command = isObject(configured) ? configured.command : undefined;
  if (
    configured !== undefined &&
    (typeof command !== "string" || basename(command) !== "agentorg-mcp")
  ) {
    throw new Error(`${path} already has an MCP server named org that isn't AgentOrg's`);
  }
  if (configured !== undefined && table === undefined) {
    throw new Error(`${path} must declare AgentOrg in a [${OUR_TABLE}] table`);
  }
  return { text, tables, table, command: typeof command === "string" ? command : undefined };
}

/** Apply parsed source ranges from right to left, preserving text outside the edits. */
function replaceRanges(text: string, edits: { range: [number, number]; text: string }[]): string {
  return edits
    .sort((a, b) => b.range[0] - a.range[0])
    .reduce(
      (source, edit) => source.slice(0, edit.range[0]) + edit.text + source.slice(edit.range[1]),
      text,
    );
}

const codexFiles = (project: string) => ({
  config: join(project, ".codex", "config.toml"),
  hooks: join(project, ".codex", "hooks.json"),
  skills: join(project, ".agents", "skills"),
});

const codex: Client = {
  connect(project, launcher, level) {
    const files = codexFiles(project);
    const config = codexConfig(files.config);
    const hooks = readJson(files.hooks);
    withOurHooks(hooks, "codex", launcher);
    const settings = {
      command: JSON.stringify(launcher),
      args: JSON.stringify(agentArgs("codex", level)),
    };
    let text: string;
    if (config.table === undefined) {
      const table = [
        `[${OUR_TABLE}]`,
        ...Object.entries(settings).map(([key, value]) => `${key} = ${value}`),
      ].join("\n");
      text = `${[config.text.trimEnd(), table].filter(Boolean).join("\n\n")}\n`;
    } else {
      const table = config.table;
      const edits = Object.entries(settings).map(([key, value]) => {
        const field = table.body.find((entry) => {
          const names = getStaticTOMLValue(entry.key);
          return names.length === 1 && names[0] === key;
        });
        const afterHeader = config.text.indexOf("\n", table.key.range[1]) + 1;
        return field === undefined
          ? { range: [afterHeader, afterHeader] as [number, number], text: `${key} = ${value}\n` }
          : { range: field.value.range, text: value };
      });
      text = replaceRanges(config.text, edits);
    }
    mkdirSync(dirname(files.config), { recursive: true });
    writeFileSync(files.config, text);
    writeJson(files.hooks, hooks);
    return [files.config, files.hooks, linkSkill(files.skills)];
  },

  disconnect(project) {
    const files = codexFiles(project);
    const changed: string[] = [];
    const config = codexConfig(files.config);
    if (config.table !== undefined) {
      const left = replaceRanges(
        config.text,
        config.tables.map((table) => ({ range: table.range, text: "" })),
      ).trimEnd();
      if (left === "") rmSync(files.config);
      else writeFileSync(files.config, `${left}\n`);
      prune(dirname(files.config), project);
      changed.push(files.config);
    }
    if (existsSync(files.hooks)) {
      const hooks = readJson(files.hooks);
      const before = JSON.stringify(hooks);
      removeOurHooks(hooks, "codex");
      if (JSON.stringify(hooks) !== before) {
        writeJson(files.hooks, hooks);
        prune(dirname(files.hooks), project);
        changed.push(files.hooks);
      }
    }
    return [...changed, ...unlinkSkill(files.skills, project)];
  },

  problems(project, launcher) {
    const files = codexFiles(project);
    const config = codexConfig(files.config);
    if (config.table === undefined) return undefined;
    const found = config.command === launcher ? [] : [`${files.config} names ${config.command}`];
    return [
      ...found,
      ...hookProblems(readJson(files.hooks), files.hooks, "codex", launcher),
      ...skillProblems(files.skills),
    ];
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
