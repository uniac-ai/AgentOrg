import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Composition } from "@agentorg/interfaces";
import { Refused } from "@agentorg/sdk";
import { readTar, writeTar } from "@agentorg/sdk/manifest";
import type { z } from "zod";

/** A package's or a system's file, sent or received: 64 MiB at most. */
export const MAX_TRANSFER = 64 * 1024 * 1024;
const HASH = /^sha256-[0-9a-f]{64}$/;
/** A system file's package entries: exactly `packages/<hash>.agentorg`. */
const PACKAGE_ENTRY = /^packages\/(sha256-[0-9a-f]{64})\.agentorg$/;

/**
 * A stored package as its archive. The Hub keeps a package as its verified tree, so the archive is
 * made again from it, in the SDK's deterministic tar: the same bytes `agentorg build` writes, and
 * so the same hash. `undefined` for a package the store doesn't hold.
 */
export function packageArchive(home: string, hash: string): Uint8Array | undefined {
  if (!HASH.test(hash)) return undefined;
  const root = join(home, "packages", hash);
  const files = new Map<string, Uint8Array>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile())
        files.set(relative(root, path).split(sep).join("/"), readFileSync(path));
    }
  };
  try {
    walk(root);
  } catch {
    return undefined;
  }
  return files.size ? writeTar(files) : undefined;
}

/**
 * Run `use` with `bytes` in a private temporary file in the home, named `name`, then delete it,
 * whatever happens: the Hub adds packages from a path.
 */
export async function withTemporaryFile<T>(
  home: string,
  name: string,
  bytes: Uint8Array,
  use: (path: string) => Promise<T>,
): Promise<T> {
  const dir = join(home, "tmp", randomBytes(9).toString("base64url"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const path = join(dir, name);
    writeFileSync(path, bytes, { mode: 0o600 });
    return await use(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export type SystemComposition = z.output<typeof Composition>;

/** The hash each of a composition's Actors pins: its package is `name@version#hash`. */
export function pinnedHashes(composition: SystemComposition): string[] {
  const hashes = new Set<string>();
  for (const { package: pinned } of Object.values(composition.actors)) {
    const hash = pinned.slice(pinned.lastIndexOf("#") + 1);
    if (HASH.test(hash)) hashes.add(hash);
  }
  return [...hashes];
}

/** A system file: `composition.json`, and each pinned package's archive under `packages/`. */
export function writeSystem(
  composition: SystemComposition,
  archives: Map<string, Uint8Array>,
): Uint8Array {
  const files = new Map<string, Uint8Array>([
    ["composition.json", new TextEncoder().encode(`${JSON.stringify(composition, null, 2)}\n`)],
  ]);
  for (const [hash, archive] of archives) files.set(`packages/${hash}.agentorg`, archive);
  return writeTar(files);
}

/**
 * A system file, read strictly: a tar of regular files whose entries are exactly
 * `composition.json` and `packages/sha256-<64 hex>.agentorg`, nothing else. A composition may
 * come from anyone, so anything else is refused (`invalid`). Each archive's hash is checked
 * against its name when it is added.
 */
export function readSystem(bytes: Uint8Array): {
  composition: SystemComposition;
  packages: Map<string, Uint8Array>;
} {
  let files: Map<string, Uint8Array>;
  try {
    files = readTar(bytes);
  } catch (error) {
    throw new Refused("invalid", `This isn't a system file: ${(error as Error).message}`);
  }
  const packages = new Map<string, Uint8Array>();
  let composition: unknown;
  for (const [path, data] of files) {
    const entry = PACKAGE_ENTRY.exec(path);
    if (entry) packages.set(entry[1] as string, data);
    else if (path === "composition.json")
      try {
        composition = JSON.parse(new TextDecoder().decode(data));
      } catch {
        throw new Refused("invalid", "composition.json isn't JSON.");
      }
    else throw new Refused("invalid", `A system file holds no ${JSON.stringify(path)}.`);
  }
  if (composition === undefined)
    throw new Refused("invalid", "A system file has a composition.json.");
  const parsed = Composition.safeParse(composition);
  if (!parsed.success)
    throw new Refused(
      "invalid",
      `composition.json doesn't fit: ${parsed.error.issues[0]?.message}`,
    );
  return { composition: parsed.data, packages };
}
