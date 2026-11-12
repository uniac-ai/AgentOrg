/**
 * The control log: one line for each control-unit call that changed something, for each of the
 * person's changes to an agent, and for each refusal of either.
 * Append-only, and kept to a size: past it, the older half goes. It holds no message an agent
 * sent, and no secret.
 */
import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { Activity } from "./control.js";

interface Entry extends Activity {
  seq: number;
  at: string;
}
/** Past this, the older half of the log goes. */
const MAX_BYTES = 4 * 1024 * 1024;

export function createActivity(path: string, maxBytes = MAX_BYTES) {
  const read = (): Entry[] => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    return text.split("\n").flatMap((line) => {
      try {
        const entry = line ? (JSON.parse(line) as Entry) : undefined;
        return entry && Number.isInteger(entry.seq) ? [entry] : [];
      } catch {
        return [];
      }
    });
  };
  const sizeOf = () => {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  };
  const kept = read();
  let next = Math.max(-1, ...kept.map((one) => one.seq)) + 1;
  let bytes = sizeOf();
  // A line cut off by a crash ends here, so the next doesn't join it.
  let torn = bytes > 0 && !readFileSync(path, "utf8").endsWith("\n");
  return {
    add(entry: Activity) {
      const line = `${JSON.stringify({ seq: next++, at: new Date().toISOString(), ...entry })}\n`;
      appendFileSync(path, torn ? `\n${line}` : line, { mode: 0o600 });
      torn = false;
      bytes += Buffer.byteLength(line);
      if (bytes <= maxBytes) return;
      const all = read();
      const newer = all.slice(Math.floor(all.length / 2));
      const text = newer.map((one) => `${JSON.stringify(one)}\n`).join("");
      writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
      bytes = Buffer.byteLength(text);
    },
    /** Newest first; with `agent`, those it made or that were about it. */
    read({ agent, before, limit = 50 }: { agent?: string; before?: number; limit?: number }) {
      const matching = read()
        .filter((one) => before === undefined || one.seq < before)
        .filter((one) => agent === undefined || one.caller === agent || one.target === agent)
        .reverse();
      return { entries: matching.slice(0, limit), more: matching.length > limit };
    },
  };
}
