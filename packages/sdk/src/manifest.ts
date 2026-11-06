import { hashOf, sha256 } from "./canonical.js";
import { type DescribedInterface, hashInterface, type InterfaceSchemas } from "./interface.js";
import type { Placement } from "./module.js";
import { readTar } from "./tar.js";

export const FORMAT = "agentorg.package/1";

/** An interface as `agentorg.json` records it, keyed by its `name@major`. */
export type ManifestInterface = DescribedInterface extends infer D
  ? D extends unknown
    ? Omit<D, "id">
    : never
  : never;
export interface ManifestModule {
  placement: Placement;
  entry: string;
  slots: Record<string, string>;
  exports: Record<string, string>;
}
/** `agentorg.json`, generated from the package's code. */
export interface Manifest {
  format: typeof FORMAT;
  name: string;
  version: string;
  description?: string;
  modules: Record<string, ManifestModule>;
  interfaces: Record<string, ManifestInterface>;
  /** The package's own wiring: `[ "module.slot", "module.export" ]`. Other slots are the installer's. */
  connections: [string, string][];
  /** Optional initial state for state slots, the only runtime state a package may carry. */
  seed: unknown;
  signature: null;
}

const NAME = /^[a-z][A-Za-z0-9_]*$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const own = (record: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : undefined;

/** The canonical tree hash: SHA-256 over the sorted `[path, sha256(bytes)]` of every file. */
export function treeHash(files: Map<string, Uint8Array>): string {
  return hashOf(
    [...files.keys()].sort().map((path) => [path, sha256(files.get(path) as Uint8Array)]),
  );
}

/**
 * Everything wrong with a manifest, empty when it's sound: its shape, each module's entry and
 * interfaces, every interface's recorded hash against its schemas, and the package's connections,
 * each a slot joined to an export of the same interface, every slot at most once.
 */
export function checkManifest(value: unknown): string[] {
  if (!isRecord(value)) return ["The manifest isn't a JSON object."];
  const problems: string[] = [];
  if (value.format !== FORMAT) problems.push(`Unknown format ${JSON.stringify(value.format)}.`);
  for (const field of ["name", "version"])
    if (typeof value[field] !== "string" || !value[field])
      problems.push(`The manifest needs a ${field}.`);
  if (value.signature !== null) problems.push("signature must be null in this format.");
  const interfaces = isRecord(value.interfaces) ? value.interfaces : {};
  if (!isRecord(value.interfaces)) problems.push("interfaces must be an object.");
  for (const [id, entry] of Object.entries(interfaces)) {
    if (!isRecord(entry) || typeof entry.hash !== "string") {
      problems.push(`${id} has no recorded hash.`);
      continue;
    }
    const { hash, ...schemas } = entry;
    let recomputed: string | undefined;
    try {
      recomputed = hashInterface({ id, ...schemas } as InterfaceSchemas);
    } catch {
      recomputed = undefined;
    }
    if (recomputed !== hash) problems.push(`${id}'s recorded hash doesn't match its schemas.`);
  }
  const modules = isRecord(value.modules) ? value.modules : {};
  if (!isRecord(value.modules) || !Object.keys(modules).length)
    problems.push("The manifest needs at least one module.");
  const ids: Record<string, Record<string, string>> = {};
  for (const [name, module] of Object.entries(modules)) {
    if (!NAME.test(name)) problems.push(`${JSON.stringify(name)} isn't a valid module name.`);
    if (!isRecord(module)) {
      problems.push(`Module ${name} isn't an object.`);
      continue;
    }
    if (module.placement !== "host" && module.placement !== "view")
      problems.push(`Module ${name} has no placement of host or view.`);
    if (module.entry !== `dist/${name}.js`)
      problems.push(`Module ${name}'s entry must be dist/${name}.js.`);
    for (const side of ["slots", "exports"] as const) {
      const members = module[side];
      if (!isRecord(members)) {
        problems.push(`Module ${name} needs ${side}.`);
        continue;
      }
      for (const [member, id] of Object.entries(members)) {
        if (!NAME.test(member)) problems.push(`${name}.${member} isn't a valid name.`);
        if (typeof id !== "string" || !own(interfaces, id))
          problems.push(`${name}.${member} uses ${JSON.stringify(id)}, which isn't recorded.`);
        else {
          const recorded = ids[`${side}:${name}`] ?? {};
          recorded[member] = id;
          ids[`${side}:${name}`] = recorded;
        }
      }
    }
  }
  if (!Array.isArray(value.connections)) problems.push("connections must be a list.");
  const wired = new Set<string>();
  for (const connection of Array.isArray(value.connections) ? value.connections : []) {
    const label = JSON.stringify(connection);
    if (
      !Array.isArray(connection) ||
      connection.length !== 2 ||
      !connection.every((end) => typeof end === "string")
    ) {
      problems.push(`Connection ${label} must be ["module.slot", "module.export"].`);
      continue;
    }
    const [from, to] = connection as [string, string];
    const end = (path: string, side: "slots" | "exports") => {
      const parts = path.split(".");
      const id =
        parts.length === 2 ? own(ids[`${side}:${parts[0]}`] ?? {}, parts[1] as string) : undefined;
      if (typeof id !== "string")
        problems.push(
          `Connection ${label}: ${JSON.stringify(path)} isn't a${side === "slots" ? " slot" : "n export"} of a module here, as "module.${side === "slots" ? "slot" : "export"}".`,
        );
      return id as string | undefined;
    };
    const slot = end(from, "slots");
    const exported = end(to, "exports");
    if (slot && exported && slot !== exported)
      problems.push(`Connection ${label} joins ${slot} to ${exported}.`);
    if (wired.has(from)) problems.push(`${from} is connected twice.`);
    wired.add(from);
  }
  return problems;
}

export type Verified =
  | { ok: true; hash: string; manifest: Manifest; files: Map<string, Uint8Array> }
  | { ok: false; hash?: string; problems: string[] };

/**
 * Check a `.agentorg` archive's bytes: it reads as a package (exactly `agentorg.json` and each
 * module's entry), hashes to the expected hash, and its manifest is sound. Problems are returned,
 * never thrown, so a Hub can report them as they are.
 */
export function verifyArchive(bytes: Uint8Array, expected: string): Verified {
  let files: Map<string, Uint8Array>;
  try {
    files = readTar(bytes);
  } catch (error) {
    return { ok: false, problems: [error instanceof Error ? error.message : String(error)] };
  }
  const hash = treeHash(files);
  const problems: string[] = [];
  if (hash !== expected) problems.push(`The package hashes to ${hash}, not ${expected}.`);
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(files.get("agentorg.json")));
  } catch {
    return {
      ok: false,
      hash,
      problems: [...problems, "The package has no readable agentorg.json."],
    };
  }
  problems.push(...checkManifest(manifest));
  const expectedFiles = new Set([
    "agentorg.json",
    ...Object.keys(
      isRecord((manifest as Manifest)?.modules) ? (manifest as Manifest).modules : {},
    ).map((name) => `dist/${name}.js`),
  ]);
  for (const path of expectedFiles)
    if (!files.has(path)) problems.push(`${path} is missing from the package.`);
  for (const path of files.keys())
    if (!expectedFiles.has(path)) problems.push(`${path} doesn't belong in the package.`);
  return problems.length
    ? { ok: false, hash, problems }
    : { ok: true, hash, manifest: manifest as Manifest, files };
}
