import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plistPath, ServiceError, type ServiceSystem, stop } from "./service.js";

/** AgentOrg's channels: npm's dist-tags of @agentorg/cli, each naming one release. */
export const CHANNELS = ["latest", "next"] as const;
export type Channel = (typeof CHANNELS)[number];
/**
 * The channel an install made before channels were recorded follows: every line until then
 * installed `next`, as get.sh does by default.
 */
export const UNRECORDED: Channel = "next";
/**
 * Where `agentorg update` reads npm's dist-tags, `{"latest": …, "next": …}`, and fetches the
 * channel's release's install.sh and SHA256SUMS, at `<releases>/v<version>/`.
 */
export const RELEASE = {
  tags: "https://registry.npmjs.org/-/package/@agentorg/cli/dist-tags",
  releases: "https://github.com/uniac-ai/AgentOrg/releases/download",
  /** A release's notes, at `<notes>/v<version>`. */
  notes: "https://github.com/uniac-ai/AgentOrg/releases/tag",
};
/** The line its launcher carries, so only a launcher the script wrote is removed. */
export const LAUNCHER_MARK = "# AgentOrg's launcher, written by its install script.";

/** Why `update` and `uninstall` don't run here: only the Mac line installs what they change. */
export const ELSEWHERE =
  "AgentOrg is installed by its one line on a Mac only. Here it comes from npm: update or remove it there.";

/** What the Mac line puts in an account, as install.sh lays it out. */
export function layout(userHome: string) {
  const root = join(userHome, ".agentorg");
  return {
    root,
    /**
     * Node, the core, its bundle, what an update keeps while it runs and once it is done, what
     * going back keeps while it runs, the channel and the update last read for it: all of it the
     * line's own.
     */
    parts: [
      "app",
      "runtime",
      "AgentOrg Core.app",
      "update-backup",
      "previous",
      "back-ahead",
      "channel",
      "update.json",
    ].map((name) => join(root, name)),
    /** What the last update kept: the release before it, with the home as it was just before. */
    previous: join(root, "previous"),
    /** The channel the line installed from, as install.sh records it: `latest` or `next`. */
    channel: join(root, "channel"),
    launcher: join(userHome, ".local", "bin", "agentorg"),
    /** Where the line puts the Mac app: the one folder AGENTORG_APP_DIR names, as for the script. */
    macApps: (process.env.AGENTORG_APP_DIR
      ? [process.env.AGENTORG_APP_DIR]
      : ["/Applications", join(userHome, "Applications")]
    ).map((at) => join(at, "AgentOrg.app")),
    agents: join(userHome, "Agents"),
  };
}

/** The channel `agentorg update` follows: the one the line recorded, else `UNRECORDED`. */
export function recordedChannel(userHome: string): Channel {
  let recorded: string | undefined;
  try {
    recorded = readFileSync(layout(userHome).channel, "utf8").trim();
  } catch {}
  return CHANNELS.find((channel) => channel === recorded) ?? UNRECORDED;
}

/**
 * What every request of AgentOrg's own says of who asks: a plain client name and this core's
 * version, and nothing of the person, the home or the install.
 */
export const CLIENT = `agentorg/${
  (
    JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version: string;
    }
  ).version
}`;

/**
 * The body at `url`, or its status when that isn't 2xx, within `ms`. A redirect is followed only
 * to the address's own protocol, https for AgentOrg's, and five at most. It sends no header but
 * `CLIENT`, beside what fetch itself sends.
 */
async function body(url: string, ms = 30_000): Promise<Buffer | number> {
  let at = new URL(url);
  const signal = AbortSignal.timeout(ms);
  for (let hop = 0; hop <= 5; hop++) {
    const answer = await fetch(at, {
      redirect: "manual",
      signal,
      headers: { "user-agent": CLIENT },
    });
    const to = answer.headers.get("location");
    if (answer.status >= 300 && answer.status < 400 && to !== null) {
      await answer.body?.cancel();
      at = new URL(to, at);
      if (at.protocol !== new URL(url).protocol) throw new Error(`it redirected to ${at.origin}`);
      continue;
    }
    if (answer.ok) return Buffer.from(await answer.arrayBuffer());
    await answer.body?.cancel();
    return answer.status;
  }
  throw new Error("it redirected more than five times");
}

/** A refusal's words with "so nothing was run" at its end, before its full stop. */
const nothingRun = (said: string) => `${said.replace(/\.$/, "")}, so nothing was run.`;

/** A channel's release: its version, and the page of its notes. */
export interface ChannelRelease {
  version: string;
  notes: string;
}

/**
 * The release npm's `channel` names, read from `from` within `ms`: what `agentorg update` moves to
 * and what `agentorg status` tells of, so the two never disagree. It is one GET of npm's dist-tags,
 * which says nothing of the person but `CLIENT`. Its source moves to the install page's channel
 * files once the page serves them for releases that passed their check.
 */
export async function channelRelease(
  from: typeof RELEASE,
  channel: Channel,
  ms?: number,
): Promise<ChannelRelease> {
  let tags: Buffer | number;
  try {
    tags = await body(from.tags, ms);
  } catch (error) {
    throw new ServiceError(
      `Couldn't fetch npm's dist-tags from ${from.tags}: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (typeof tags === "number")
    throw new ServiceError(
      `Couldn't fetch npm's dist-tags from ${from.tags}: it answered ${tags}.`,
    );
  let version: unknown;
  try {
    version = JSON.parse(tags.toString())[channel];
  } catch {}
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new ServiceError(`npm names no version for AgentOrg's ${channel} channel.`);
  return { version, notes: `${from.notes}/v${version}` };
}

/**
 * `agentorg update`: read the version npm's `channel` names, the one the line recorded, fetch that
 * release's install.sh and SHA256SUMS from `from`, and run install.sh with `--update` on `home`,
 * with the terminal's output, once its SHA-256 is the one listed. install.sh is given the channel
 * in AGENTORG_CHANNEL, so it keeps that record. It updates the core and the Mac app together, or
 * puts both back. Its exit code is the script's.
 */
export async function update(
  from: typeof RELEASE,
  home: string,
  channel: Channel,
): Promise<number> {
  let version: string;
  try {
    ({ version } = await channelRelease(from, channel));
  } catch (error) {
    if (error instanceof ServiceError) throw new ServiceError(nothingRun(error.message));
    throw error;
  }
  return runRelease(from, version, ["--update"], home, {
    env: { AGENTORG_CHANNEL: channel },
    upYet: true,
  });
}

/**
 * Fetch release `version`'s install.sh and SHA256SUMS from `from`, and run install.sh with `args`
 * on `home`, with the terminal's output, once its SHA-256 is the one listed. Its exit code is the
 * script's. With `upYet`, a file that isn't there is the release not being up yet, as npm names a
 * version a few minutes before its release has its files.
 */
async function runRelease(
  from: typeof RELEASE,
  version: string,
  args: string[],
  home: string,
  { upYet = false, env = {} }: { upYet?: boolean; env?: Record<string, string> },
): Promise<number> {
  /** What `url` answers. */
  const fetched = async (what: string, url: string) => {
    let got: Buffer | number;
    try {
      got = await body(url);
    } catch (error) {
      throw new ServiceError(
        nothingRun(
          `Couldn't fetch ${what} from ${url}: ${error instanceof Error ? error.message : String(error)}.`,
        ),
      );
    }
    if (got === 404 && upYet)
      throw new ServiceError(
        `AgentOrg ${version} is on npm, but its release isn't up yet: try again in a few minutes.`,
      );
    if (typeof got === "number")
      throw new ServiceError(nothingRun(`Couldn't fetch ${what} from ${url}: it answered ${got}.`));
    return got;
  };
  const at = `${from.releases}/v${version}`;
  const script = await fetched(`AgentOrg ${version}'s install.sh`, `${at}/install.sh`);
  const sums = (await fetched(`AgentOrg ${version}'s SHA256SUMS`, `${at}/SHA256SUMS`)).toString();
  const listed = sums.match(/^([0-9a-f]{64}) [ *]install\.sh$/m)?.[1];
  if (listed === undefined)
    throw new ServiceError(
      `The SHA256SUMS of AgentOrg ${version} has no line for install.sh, so nothing was run.`,
    );
  const got = createHash("sha256").update(script).digest("hex");
  if (got !== listed)
    throw new ServiceError(
      `install.sh of AgentOrg ${version} isn't the one its SHA256SUMS lists (its SHA-256 is ${got}), so nothing was run.`,
    );
  const folder = mkdtempSync(join(tmpdir(), "agentorg-update-"));
  try {
    const file = join(folder, "install.sh");
    writeFileSync(file, script, { mode: 0o700 });
    return await new Promise((done, failed) =>
      spawn("bash", [file, ...args], {
        stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env, ...env, AGENTORG_HUB_HOME: home },
      })
        .once("error", failed)
        .once("exit", (code) => done(code ?? 1)),
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** The step `agentorg update --back` takes: from the release running now to the one before it. */
export interface BackStep {
  now: string;
  to: string;
}

/** The one step back the line's last update kept, if there is one. */
export function backStep(userHome: string): BackStep | undefined {
  const { root, previous } = layout(userHome);
  try {
    const now = readlinkSync(join(root, "app", "current"));
    const to = readFileSync(join(previous, "version"), "utf8").trim();
    return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(to) && to !== now ? { now, to } : undefined;
  } catch {
    return undefined;
  }
}

/** Why `agentorg update --back` doesn't run: no update kept a step back. */
export const NO_STEP_BACK =
  "There is no release to go back to: AgentOrg keeps the one before its last update, and has none.";

/** What `agentorg update --back` says before it goes: what goes back, and what is lost. */
export const backWarning = ({ now, to }: BackStep) =>
  `This puts back AgentOrg ${to} (current: ${now}), with its home as it was just before the update to ${now}. Everything since that update is lost: chats, agents and settings made or changed after it. It goes one step back only.`;

/**
 * `agentorg update --back`: run release `step.now`'s own install.sh, fetched and checked as
 * `update` does, with `--back` on `home`. That script made the step back when it updated, and
 * puts it back. Its exit code is the script's.
 */
export async function back(from: typeof RELEASE, home: string, step: BackStep): Promise<number> {
  return runRelease(from, step.now, ["--back"], home, {});
}

/** The Mac app's own uninstall, as `agentorg uninstall` runs it: its privacy grants go with it. */
export const APP_UNINSTALL = ["uninstall", "--reset-privacy"];

/**
 * `agentorg uninstall`: stop the service and delete its file; where the line installed AgentOrg
 * here, run the Mac app's own uninstall, which takes the app, its privacy grants and what it keeps;
 * then delete what the line installed. The line treats the app where it puts it as its own, as an
 * update replaces it, so the app goes when the line's core or launcher is here. The home is kept
 * unless `deleteHome`, and only a folder that is an AgentOrg home is deleted. `~/Agents`, where
 * agents work, is left as it is. Each line for the person is given to `say` as it happens, before
 * the app's wait for what it runs to end, and all of them are answered.
 */
export async function uninstall(
  system: ServiceSystem,
  home: string,
  {
    deleteHome = false,
    say = () => {},
  }: { deleteHome?: boolean; say?: (line: string) => void } = {},
): Promise<string[]> {
  if (system.platform !== "darwin") throw new ServiceError(ELSEWHERE);
  const { root, parts, launcher, macApps, agents } = layout(system.userHome);
  // An update, or a going back, cut off before it put a home in place leaves the only copy among
  // what it kept.
  const leftHome = ["update-backup", "back-ahead"]
    .map((kept) => join(root, kept, "home"))
    .find((kept) => existsSync(kept));
  if (!existsSync(home) && leftHome)
    throw new ServiceError(
      `${leftHome.includes("back-ahead") ? "Going back a release" : "An update"} that didn't finish left AgentOrg's home at ${leftHome}. Move it back to ${home}, then run agentorg uninstall again.`,
    );
  if (deleteHome && existsSync(home) && !existsSync(join(home, "hub.db")))
    throw new ServiceError(`${home} isn't an AgentOrg home, so nothing was removed.`);
  const { was } = await stop(system, home);
  // The service's on another home, or none: one still on this home runs where it was started.
  if (await system.running(home))
    throw new ServiceError(
      `AgentOrg is running on ${home}, but not as the service. Stop it where it was started, then run agentorg uninstall again.`,
    );
  const said: string[] = [];
  const tell = (line: string) => {
    said.push(line);
    say(line);
  };
  const installed = parts.filter((part) => existsSync(part));
  const ours = existsSync(launcher) && readFileSync(launcher, "utf8").includes(LAUNCHER_MARK);
  const macApp = macApps.find((app) => existsSync(app));
  const appToo = macApp !== undefined && (installed.length > 0 || ours);
  rmSync(plistPath(system.userHome), { force: true });
  if (was !== "none") tell("Removed the service.");
  // The app first: where it can't be removed, what the line installed stays for another try.
  if (appToo) {
    tell("Removing the AgentOrg app. It waits up to 45 s for what it runs to stop.");
    const program = join(macApp, "Contents", "MacOS", "AgentOrg");
    const ended = await system.command(program, APP_UNINSTALL);
    if (ended.code !== 0) {
      const why = (ended.stderr.trim() || ended.stdout.trim()).split("\n").at(-1);
      throw new ServiceError(
        `The AgentOrg app couldn't be removed${why ? `: ${why}` : ""}. The rest of AgentOrg stays, so agentorg uninstall can try again.`,
      );
    }
    for (const line of ended.stdout.split("\n")) if (line.trim()) tell(`  ${line.trim()}`);
  }
  for (const part of installed) rmSync(part, { recursive: true, force: true });
  if (installed.length > 0) tell(`Removed AgentOrg from ${root}.`);
  if (ours) {
    rmSync(launcher, { force: true });
    tell(`Removed its launcher, ${launcher}.`);
  }
  if (deleteHome && existsSync(home)) {
    rmSync(home, { recursive: true, force: true });
    tell(`Removed its home, ${home}.`);
  } else if (existsSync(home))
    tell(
      `Its home stays at ${home}, with your agents, their chats and sign-ins. agentorg uninstall --delete-home removes it too.`,
    );
  try {
    if (readdirSync(root).length === 0) rmSync(root, { recursive: true });
  } catch {}
  if (existsSync(agents)) tell(`${agents}, where your agents work, stays as it is.`);
  if (macApp && !appToo)
    tell(
      `The AgentOrg app stays, still lending this Mac. To remove it too: "${macApp}/Contents/MacOS/AgentOrg" uninstall`,
    );
  else if (macApp && !existsSync(macApp))
    tell(
      'macOS still lists "AgentOrg" in Login Items, switched off. No app can remove that entry, and it starts nothing.',
    );
  if (said.length === 0) tell("AgentOrg isn't installed here.");
  return said;
}
