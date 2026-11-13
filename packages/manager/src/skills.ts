import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { SKILL_FILE_MAX, SkillEntry, SkillName, SkillPath } from "@agentorg/interfaces";
import { Refused } from "@agentorg/sdk";
import { parse } from "yaml";
import type { z } from "zod";

type Entry = z.infer<typeof SkillEntry>;
export type SkillFiles = Record<string, string>;

const MANIFEST = "SKILL.md";
const MAX_FILES = 256;
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** What a `SKILL.md` says of itself, from its front matter, or refused. */
function entryOf(text: string): Entry {
  const matter = FRONT_MATTER.exec(text)?.[1];
  let fields: unknown;
  try {
    fields = matter === undefined ? undefined : parse(matter);
  } catch {
    fields = undefined;
  }
  const entry = SkillEntry.safeParse(
    fields && typeof fields === "object"
      ? {
          name: (fields as Record<string, unknown>).name,
          description: (fields as Record<string, unknown>).description,
        }
      : undefined,
  );
  if (!entry.success || entry.data.description.trim() === "")
    throw new Refused(
      "invalid",
      `${MANIFEST} needs front matter with a name (lowercase words joined by hyphens) and a description.`,
    );
  return entry.data;
}

/** Every file under `root`, by its path inside it; a link is refused, since it could leave it. */
function walk(root: string, each: (file: string, path: string) => void) {
  for (const found of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (found.isDirectory()) continue;
    const file = join(found.parentPath, found.name);
    if (!found.isFile())
      throw new Refused("invalid", `${relative(root, file)} isn't a plain file.`);
    each(file, relative(root, file).split(sep).join("/"));
  }
}

/** A skill's folder on this machine, as files; each must be text within a skill's limits. */
export function readSkillFolder(folder: string): SkillFiles {
  const files: SkillFiles = {};
  try {
    if (!statSync(folder).isDirectory()) throw new Error("not a folder");
  } catch {
    throw new Refused("invalid", `${folder} isn't a folder here.`);
  }
  walk(folder, (file, path) => {
    if (basename(path) === ".DS_Store") return;
    if (Object.keys(files).length >= MAX_FILES)
      throw new Refused("invalid", `A skill holds at most ${MAX_FILES} files.`);
    if (!SkillPath.safeParse(path).success)
      throw new Refused("invalid", `${path} isn't a name a skill's file can have.`);
    const bytes = readFileSync(file);
    if (bytes.length > SKILL_FILE_MAX)
      throw new Refused("invalid", `${path} is over ${SKILL_FILE_MAX} bytes.`);
    try {
      files[path] = utf8.decode(bytes);
    } catch {
      throw new Refused("invalid", `${path} isn't text.`);
    }
  });
  return files;
}

/** The skills, each a `SKILL.md` folder under `dir`. What each says of itself is read from it. */
export function createSkills(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const folderOf = (name: string) => join(dir, name);
  const read = (name: string, path = MANIFEST) => {
    try {
      return readFileSync(join(folderOf(name), path), "utf8");
    } catch {
      return undefined;
    }
  };
  const entry = (name: string): Entry | undefined => {
    const text = read(name);
    return text === undefined ? undefined : entryOf(text);
  };
  return {
    has: (name: string) => read(name) !== undefined,
    /** The name a skill's files give themselves; refused as `add` would refuse them. */
    nameOf(files: SkillFiles) {
      const manifest = files[MANIFEST];
      if (manifest === undefined) throw new Refused("invalid", `A skill needs a ${MANIFEST}.`);
      return entryOf(manifest).name;
    },
    entry,
    read,
    list() {
      return readdirSync(dir, { withFileTypes: true })
        .filter((found) => found.isDirectory() && SkillName.safeParse(found.name).success)
        .map((found) => entry(found.name))
        .filter((found): found is Entry => found !== undefined)
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    /** Its files' paths, leaving out what a folder on a Mac gathers, as `readSkillFolder` does. */
    paths(name: string) {
      const paths: string[] = [];
      walk(folderOf(name), (_, path) => {
        if (basename(path) !== ".DS_Store") paths.push(path);
      });
      return paths.sort();
    },
    /**
     * Add a skill, or replace the one of its name, whole: it is never seen half written. With
     * `expected`, a skill that calls itself anything else is refused before anything is touched.
     */
    add(files: SkillFiles, expected?: string): Entry {
      const manifest = files[MANIFEST];
      if (manifest === undefined) throw new Refused("invalid", `A skill needs a ${MANIFEST}.`);
      const found = entryOf(manifest);
      if (expected !== undefined && found.name !== expected)
        throw new Refused("invalid", `The skill ${expected} names itself ${found.name}.`);
      // Named so `list` passes it by: a skill's name can't start with a dot.
      const adding = join(dir, `.adding-${crypto.randomUUID()}`);
      try {
        for (const [path, text] of Object.entries(files)) {
          const file = join(adding, path);
          mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
          writeFileSync(file, text, { mode: 0o600 });
        }
        const final = folderOf(found.name);
        const aside = join(dir, `.replaced-${crypto.randomUUID()}`);
        const replacing = existsSync(final);
        if (replacing) renameSync(final, aside);
        try {
          renameSync(adding, final);
        } catch (error) {
          if (replacing) renameSync(aside, final);
          throw error;
        }
        rmSync(aside, { recursive: true, force: true });
      } finally {
        rmSync(adding, { recursive: true, force: true });
      }
      return found;
    },
    remove(name: string) {
      rmSync(folderOf(name), { recursive: true, force: true });
    },
  };
}
export type Skills = ReturnType<typeof createSkills>;
