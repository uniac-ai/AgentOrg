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

test("the domain imports no protocol, network, web framework, WebSocket, database or Node built-in", (t) => {
  const forbidden = [MCP, "hono", "@hono/", "ws", "node:"];
  const outer = ["src/network/", "src/bindings/", "src/storage/", "src/actor/", "src/core/"];
  assert.deepEqual(breaches("src/domain/", [...forbidden, ...outer, "src/cli/", "src/human/"]), []);
  t.diagnostic(`${FILES.filter(({ file }) => file.startsWith("src/domain/")).length} files`);
});

test("the domain, whose model the web app type-checks through, uses no Node globals", () => {
  const domain = FILES.filter(({ file }) => file.startsWith("src/domain/"));
  assert.deepEqual(
    domain.filter(({ text }) => /\b(process|Buffer)\b/.test(text)).map(({ file }) => file),
    [],
  );
});

test("the network knows no domain, protocol binding, storage or actor", () => {
  const forbidden = [
    MCP,
    "src/domain/",
    "src/bindings/",
    "src/storage/",
    "src/actor/",
    "src/core/",
  ];
  assert.deepEqual(breaches("src/network/", forbidden), []);
});

test("storage implements the domain's store, and knows no protocol or network", () => {
  const forbidden = [MCP, "hono", "@hono/", "ws", "src/network/", "src/bindings/"];
  assert.deepEqual(breaches("src/storage/", forbidden), []);
});

test("the actor library's API names no protocol or network", () => {
  assert.deepEqual(breaches("src/actor/api.ts", [MCP, "src/bindings/", "src/network/"]), []);
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
