// Whether a newer AgentOrg is out on the channel the line installed from, as `agentorg status`
// tells it. It is read only when the person runs `agentorg status`, at most once a day, and kept
// in the line's folder; running the agent reads nothing. Nothing updates by itself.
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Channel,
  type ChannelRelease,
  channelRelease,
  layout,
  type RELEASE,
  recordedChannel,
} from "./installed.js";

/** How old the fact may be before it is read again. */
export const DAY_MS = 24 * 60 * 60 * 1000;
/** How long `agentorg status` waits for npm before it says what it has. */
export const STATUS_WAIT_MS = 5_000;

/**
 * What was last asked, for which channel and when; and the channel's release, as the last read
 * that answered gave it. A read that failed is a time asked too, so it waits a day like any other.
 */
export interface UpdateFact extends Partial<ChannelRelease> {
  channel: Channel;
  askedAt: string;
}

/** Where the fact is kept: the line's own folder, beside the channel it was read for. */
export const factPath = (userHome: string) => join(layout(userHome).root, "update.json");

/**
 * Whether the one-line install put AgentOrg here, as install.sh tells: its channel recorded, or its
 * core's `current` link there. Only then does `agentorg update` move it.
 */
export function byTheLine(userHome: string): boolean {
  if (existsSync(layout(userHome).channel)) return true;
  try {
    return lstatSync(join(layout(userHome).root, "app", "current")).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The fact as it was last kept, if it is one. */
export function keptFact(userHome: string): UpdateFact | undefined {
  try {
    const fact = JSON.parse(readFileSync(factPath(userHome), "utf8")) as UpdateFact;
    const known = (field: unknown) => field === undefined || typeof field === "string";
    return typeof fact.channel === "string" &&
      typeof fact.askedAt === "string" &&
      known(fact.version) &&
      known(fact.notes)
      ? fact
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where the line installed AgentOrg, ask for the recorded channel's release once the fact kept was
 * asked a day ago or more, or for another channel, or there is none; keep what it answers, or the
 * release as it was where the read fails, with the time asked. What it answers is the fact as it
 * now stands.
 */
export async function checkForUpdate(
  userHome: string,
  from: typeof RELEASE,
  now = () => new Date(),
): Promise<UpdateFact | undefined> {
  if (!byTheLine(userHome)) return undefined;
  const channel = recordedChannel(userHome);
  const kept = keptFact(userHome)?.channel === channel ? keptFact(userHome) : undefined;
  if (kept && now().getTime() - new Date(kept.askedAt).getTime() < DAY_MS) return kept;
  let release: Partial<ChannelRelease> = { version: kept?.version, notes: kept?.notes };
  try {
    release = await channelRelease(from, channel, STATUS_WAIT_MS);
  } catch {}
  const fact: UpdateFact = { channel, ...release, askedAt: now().toISOString() };
  const file = factPath(userHome);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(fact, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return fact;
}

/** Whether version `a` comes after `b`, by their numbers; a pre-release before its release. */
export function newer(a: string, b: string): boolean {
  const parts = (version: string) => {
    const [core = "", pre] = version.split("-", 2);
    return { numbers: core.split(".").map(Number), pre };
  };
  const [x, y] = [parts(a), parts(b)];
  for (let at = 0; at < 3; at++) {
    const [p = 0, q = 0] = [x.numbers[at], y.numbers[at]];
    if (p !== q) return p > q;
  }
  if (x.pre === y.pre) return false;
  if (x.pre === undefined) return true;
  if (y.pre === undefined) return false;
  return x.pre > y.pre;
}

/**
 * What `agentorg status` says of an update, from the fact kept: one line when the channel the line
 * now follows has a release newer than `current`, else nothing.
 */
export function updateLine(userHome: string, current: string): string | undefined {
  const fact = keptFact(userHome);
  if (!fact?.version || !byTheLine(userHome) || fact.channel !== recordedChannel(userHome))
    return undefined;
  if (!newer(fact.version, current)) return undefined;
  return `Update available: ${current} → ${fact.version}. Run agentorg update. Release notes: ${fact.notes}`;
}
