import { closeSync, fstatSync, openSync, readSync } from "node:fs";
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

/** At most this much of each file is read: the newest lines are at its end. */
const TAIL = 1024 * 1024;

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
