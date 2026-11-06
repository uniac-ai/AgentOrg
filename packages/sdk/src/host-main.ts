// The program the Hub spawns for a package Actor: `runner.js <package dir> <actorId>`, with its
// channel to the Hub on fd 3. It is bundled into one file, so the process needs to read only
// that file and the package's folder.
import { Socket } from "node:net";
import { Duplex as NodeDuplex } from "node:stream";
import { runHost } from "./host.js";
import type { Duplex, Log } from "./module.js";

const [packageDir, actorId] = process.argv.slice(2);
if (!packageDir || !actorId) {
  process.stderr.write("Usage: runner.js <package dir> <actorId>\n");
  process.exit(2);
}

/** Anything as text, even what can't say itself (no prototype, a throwing `toString`). */
const text = (value: unknown): string => {
  try {
    return String(value);
  } catch {
    return "[unprintable]";
  }
};

/** What JSON can't hold, as text: an error by its name and message, a bigint by its digits. */
const plain = (_key: string, value: unknown) =>
  value instanceof Error
    ? `${text(value.name)}: ${text(value.message)}`
    : typeof value === "bigint"
      ? String(value)
      : value;

/**
 * One JSON line per log call, on stderr, which the Hub keeps as the Actor's log: a module's
 * `ctx.log`, or the runner's own (no module). Logging never throws: data JSON can't hold (a cycle)
 * is written as text.
 */
const logFor = (module?: string): Log => {
  const line =
    (level: "info" | "warn" | "error") => (message: string, data?: Record<string, unknown>) => {
      const entry = (fields: unknown) =>
        JSON.stringify(
          {
            level,
            message: text(message),
            ...(fields === undefined ? {} : { data: fields }),
            ...(module === undefined ? {} : { module }),
            at: new Date().toISOString(),
          },
          plain,
        );
      let written: string;
      try {
        written = entry(data);
      } catch {
        written = entry(text(data));
      }
      process.stderr.write(`${written}\n`);
    };
  return { info: line("info"), warn: line("warn"), error: line("error") };
};

const pipe = new Socket({ fd: 3, readable: true, writable: true });
const channel = NodeDuplex.toWeb(pipe) as unknown as Duplex;
const host = await runHost({ packageDir, actorId, channel, log: logFor });
// The Hub going away ends the process: there is nothing left to serve.
await host.channel.closed;
process.exit(0);
