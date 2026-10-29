/**
 * The layering rules, read from the source: each layer imports only what it may, so that any one
 * of them can be replaced without touching the others. MCP is today's protocol binding, and only
 * the binding speaks it.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function sources(directory: string): string[] {
  return readdirSync(join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const IMPORT =
  /(?:^|\s)(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|(?:^|\s)import\s*["']([^"']+)["']/g;

/** Each file's imports: package names as written, and relative ones as paths from the root. */
const FILES = sources("src").map((file) => {
  const text = readFileSync(join(ROOT, file), "utf8");
  const imports = [...text.matchAll(IMPORT)].map((match) => {
    const specifier = (match[1] ?? match[2] ?? match[3]) as string;
    return specifier.startsWith(".")
      ? relative(ROOT, resolve(dirname(join(ROOT, file)), specifier))
      : specifier;
  });
  return { file, text, imports };
});

/** A package matches its name and its subpaths; a folder or a scheme such as `node:`, anything in it. */
const matches = (imported: string, pattern: string) =>
  pattern.endsWith("/") || pattern.endsWith(":")
    ? imported.startsWith(pattern)
    : imported === pattern || imported.startsWith(`${pattern}/`);

function breaches(layer: string, forbidden: string[]): string[] {
  return FILES.filter(({ file }) => file.startsWith(layer)).flatMap(({ file, imports }) =>
    imports
      .filter((imported) => forbidden.some((pattern) => matches(imported, pattern)))
      .map((imported) => `${file} imports ${imported}`),
  );
}

const MCP = "@modelcontextprotocol/";
const CLIENTS = ["src/clients/cli/", "src/clients/mcp/", "src/clients/web/"];
const PROTOCOLS = [MCP, "hono", "@hono/", "ws"];
const APPLICATIONS = ["src/server/", "src/clients/"];
const ADAPTERS = ["src/network/", "src/bindings/", "src/storage/", "src/actor/"];

const DOMAIN_BOUNDARIES: Record<string, string[]> = {
  registry: ["connections", "calls", "capabilities", "views", "application"],
  connections: ["registry", "calls"],
  capabilities: ["application", "calls", "views"],
  communication: ["progress", "claims", "capabilities", "views", "application"],
  progress: ["communication", "claims", "views"],
  views: ["application"],
};

// The forbidden dependencies are the architecture's contract, independent of implementation.
const RULES: Record<string, string[]> = {
  ...Object.fromEntries(
    Object.entries(DOMAIN_BOUNDARIES).map(([owner, forbidden]) => [
      `src/domain/${owner}.ts`,
      forbidden.map((name) => `src/domain/${name}.ts`),
    ]),
  ),
  "src/domain/": [
    ...PROTOCOLS,
    "node:",
    ...ADAPTERS,
    ...APPLICATIONS,
    "src/runtime/",
    "src/home.ts",
  ],
  "src/network/": [
    MCP,
    "src/domain/",
    "src/bindings/",
    "src/storage/",
    "src/actor/",
    ...APPLICATIONS,
    "src/runtime/",
  ],
  "src/storage/": [...PROTOCOLS, "src/network/", "src/bindings/", ...APPLICATIONS, "src/runtime/"],
  "src/actor/api.ts": [MCP, "src/bindings/", "src/network/"],
  "src/actor/": ["src/server/", "src/clients/", "src/storage/", "src/runtime/"],
  "src/server/": ["src/clients/", "web/"],
  "src/runtime/": ["src/domain/", ...ADAPTERS, ...APPLICATIONS],
  "src/bindings/": [...APPLICATIONS, "src/runtime/"],
  "src/home.ts": [...APPLICATIONS],
  ...Object.fromEntries(
    CLIENTS.map((client) => [
      client,
      ["src/server/", "src/storage/", ...CLIENTS.filter((sibling) => sibling !== client)],
    ]),
  ),
};

test("the domain import graph is acyclic, including types", () => {
  const domain = new Map(
    FILES.filter(({ file }) => file.startsWith("src/domain/")).map(({ file, imports }) => [
      file,
      imports,
    ]),
  );
  const checked = new Set<string>();
  function visit(file: string, path: string[]) {
    assert.ok(!path.includes(file), [...path, file].join(" -> "));
    if (checked.has(file)) return;
    for (const imported of domain.get(file) ?? []) {
      if (domain.has(imported)) visit(imported, [...path, file]);
    }
    checked.add(file);
  }
  for (const file of domain.keys()) visit(file, []);
});

for (const [layer, forbidden] of Object.entries(RULES)) {
  test(`${layer} obeys its dependency boundary`, () => {
    assert.deepEqual(breaches(layer, forbidden), []);
  });
}

test("the domain uses no Node globals", () => {
  assert.deepEqual(
    FILES.filter(
      ({ file, text }) => file.startsWith("src/domain/") && /\b(process|Buffer)\b/.test(text),
    ).map(({ file }) => file),
    [],
  );
});

test("only the MCP binding imports MCP", (t) => {
  const others = FILES.filter(({ file }) => !file.startsWith("src/bindings/mcp/"));
  const found = others.flatMap(({ file, imports }) =>
    imports
      .filter((imported) => matches(imported, MCP))
      .map((imported) => `${file} imports ${imported}`),
  );
  assert.deepEqual(found, []);
  t.diagnostic(
    `${FILES.length} files, ${FILES.reduce((n, { imports }) => n + imports.length, 0)} imports`,
  );
});
