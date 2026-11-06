import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

/** One line of an Actor's log, as `hub.actors.logs` returns it. */
export interface LogLine {
  level: "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
  module?: string;
  at: string;
}

/** Where an Actor's log is kept in the home; the previous file, rotated once, is `<file>.1`. */
export const logFile = (home: string, actorId: string) => join(home, "logs", `${actorId}.log`);

/** A log file is rotated once it would pass this; each read takes at most this of a file's end. */
const MAX_FILE = 1024 * 1024;
const TAIL = MAX_FILE;

/** A line's text is cut to this. */
const MAX_MESSAGE = 4096;
/** A line's data: this many keys at most, each value a primitive or JSON text, cut to this. */
const MAX_FIELDS = 16;
const MAX_FIELD = 1024;

function tail(path: string): string[] {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return []; // Not written yet.
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    // Cut mid-file, the first line is a fragment.
    return size > length ? lines.slice(1) : lines;
  } finally {
    closeSync(fd);
  }
}

const LEVELS = new Set(["info", "warn", "error"]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A line as a log entry, built from its known fields only; anything else isn't one. */
function entryOf(line: string): LogLine | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined; // A partial line from a crash, or not ours.
  }
  if (!isRecord(raw) || typeof raw.message !== "string" || typeof raw.at !== "string")
    return undefined;
  return {
    level: LEVELS.has(raw.level as string) ? (raw.level as LogLine["level"]) : "info",
    message: raw.message,
    ...(isRecord(raw.data) ? { data: raw.data } : {}),
    ...(typeof raw.module === "string" ? { module: raw.module } : {}),
    at: raw.at,
  };
}

/**
 * The newest `limit` entries of an Actor's log, oldest first, across its file and the one rotated
 * before it. Lines that aren't a log entry are skipped and don't count.
 */
export function readLogs(home: string, actorId: string, limit: number): LogLine[] {
  const file = logFile(home, actorId);
  const lines = [...tail(`${file}.1`), ...tail(file)];
  const entries: LogLine[] = [];
  for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
    const entry = entryOf(lines[i] as string);
    if (entry) entries.push(entry);
  }
  return entries.reverse();
}

/** Anything as text, even what can't say itself (no prototype, a throwing `toString`). */
function textOf(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[unprintable]";
  }
}

/** One field's value as it is kept: a number, boolean or null as is, anything else as text, cut. */
function fieldOf(read: () => unknown): unknown {
  try {
    const value = read();
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    const text = typeof value === "string" ? value : textOf(JSON.stringify(value));
    return text.slice(0, MAX_FIELD);
  } catch {
    return "[unreadable]"; // A getter, toJSON or bigint that throws.
  }
}

/**
 * An entry as it is written, whoever gave it: a known level, the text cut, and the data rebuilt
 * as a fresh object of at most `MAX_FIELDS` keys, each value a primitive or JSON text, cut.
 */
export function boundedEntry(
  level: unknown,
  message: unknown,
  data: unknown,
  module: string | undefined,
): LogLine {
  let fields: Record<string, unknown> | undefined;
  try {
    if (isRecord(data)) {
      // No prototype: a `__proto__` key is a key like any other.
      fields = Object.create(null) as Record<string, unknown>;
      let kept = 0;
      // Only the first keys are read: the rest are never touched.
      for (const key in data) {
        if (!Object.hasOwn(data, key)) continue;
        if (kept++ >= MAX_FIELDS) break;
        fields[key.slice(0, MAX_FIELD)] = fieldOf(() => data[key]);
      }
    }
  } catch {
    fields = undefined; // Data that can't even list its keys (a hostile proxy) is left out.
  }
  return {
    level: LEVELS.has(level as string) ? (level as LogLine["level"]) : "info",
    message: textOf(message).slice(0, MAX_MESSAGE),
    ...(fields ? { data: fields } : {}),
    ...(module === undefined ? {} : { module }),
    at: new Date().toISOString(),
  };
}

/**
 * Add an entry to an Actor's log (0600). A file that would pass 1 MiB is rotated to `<file>.1`
 * first, replacing the one before, so an Actor's logs never hold more than two files.
 */
export function appendLog(home: string, actorId: string, entry: LogLine): void {
  const file = logFile(home, actorId);
  const line = `${JSON.stringify(entry)}\n`;
  // Past what a reader takes of a file, a line could never be read back.
  if (Buffer.byteLength(line) > MAX_FILE) return;
  mkdirSync(join(home, "logs"), { recursive: true, mode: 0o700 });
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    // Not written yet.
  }
  if (size > 0 && size + Buffer.byteLength(line) > MAX_FILE) renameSync(file, `${file}.1`);
  appendFileSync(file, line, { mode: 0o600 });
}
