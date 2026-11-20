import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plistPath, ServiceError, type ServiceSystem, stop } from "./service.js";

/** The npm dist-tag of @agentorg/cli whose release `agentorg update` moves to: next, until decided. */
export const CHANNEL = "next";
/**
 * Where `agentorg update` reads npm's dist-tags, `{"latest": …, "next": …}`, and fetches the
 * channel's release's install.sh and SHA256SUMS, at `<releases>/v<version>/`. get.sh, the line's
 * script, reads the same addresses: they change together.
 */
export const RELEASE = {
  tags: "https://registry.npmjs.org/-/package/@agentorg/cli/dist-tags",
  releases: "https://github.com/uniac-ai/AgentOrg/releases/download",
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
    /** Node, the core, its bundle and what an update keeps: all of it the line's own. */
    parts: ["app", "runtime", "AgentOrg Core.app", "update-backup"].map((name) => join(root, name)),
    launcher: join(userHome, ".local", "bin", "agentorg"),
    /** Where the line puts the Mac app: the one folder AGENTORG_APP_DIR names, as for the script. */
    macApps: (process.env.AGENTORG_APP_DIR
      ? [process.env.AGENTORG_APP_DIR]
      : ["/Applications", join(userHome, "Applications")]
    ).map((at) => join(at, "AgentOrg.app")),
    agents: join(userHome, "Agents"),
  };
}

/**
 * The body at `url`, or its status when that isn't 2xx. A redirect is followed only to the
 * address's own protocol, https for AgentOrg's, and five at most.
 */
async function body(url: string): Promise<Buffer | number> {
  let at = new URL(url);
  for (let hop = 0; hop <= 5; hop++) {
    const answer = await fetch(at, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
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

/**
 * `agentorg update`: read the version npm's `CHANNEL` names, fetch that release's install.sh and
 * SHA256SUMS from `from`, and run install.sh with `--update` on `home`, with the terminal's output,
 * once its SHA-256 is the one listed. It updates the core and the Mac app together, or puts both
 * back. Its exit code is the script's.
 */
export async function update(from: typeof RELEASE, home: string): Promise<number> {
  /** What `url` answers; a release's file that isn't there is its release not being up yet. */
  const fetched = async (what: string, url: string, release?: string) => {
    let got: Buffer | number;
    try {
      got = await body(url);
    } catch (error) {
      throw new ServiceError(
        `Couldn't fetch ${what} from ${url}: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
    if (got === 404 && release !== undefined)
      throw new ServiceError(
        `AgentOrg ${release} is on npm, but its release isn't up yet: try again in a few minutes.`,
      );
    if (typeof got === "number")
      throw new ServiceError(`Couldn't fetch ${what} from ${url}: it answered ${got}.`);
    return got;
  };
  const tags = await fetched("npm's dist-tags", from.tags);
  let version: unknown;
  try {
    version = JSON.parse(tags.toString())[CHANNEL];
  } catch {}
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new ServiceError(
      `npm names no version for AgentOrg's ${CHANNEL} channel, so nothing was run.`,
    );
  const at = `${from.releases}/v${version}`;
  const script = await fetched(`AgentOrg ${version}'s install.sh`, `${at}/install.sh`, version);
  const sums = (
    await fetched(`AgentOrg ${version}'s SHA256SUMS`, `${at}/SHA256SUMS`, version)
  ).toString();
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
      spawn("bash", [file, "--update"], {
        stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env, AGENTORG_HUB_HOME: home },
      })
        .once("error", failed)
        .once("exit", (code) => done(code ?? 1)),
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * `agentorg uninstall`: stop the service and delete its file, then delete what the line
 * installed. The home is kept unless `deleteHome`, and only a folder that is an AgentOrg home is
 * deleted. `~/Agents`, where agents work, and the Mac app are left as they are. It answers what
 * the person is told, line by line.
 */
export async function uninstall(
  system: ServiceSystem,
  home: string,
  { deleteHome = false } = {},
): Promise<string[]> {
  if (system.platform !== "darwin") throw new ServiceError(ELSEWHERE);
  const { root, parts, launcher, macApps, agents } = layout(system.userHome);
  // An update cut off before it put the home back leaves the only copy among what it kept.
  const leftHome = join(root, "update-backup", "home");
  if (!existsSync(home) && existsSync(leftHome))
    throw new ServiceError(
      `An update that didn't finish left AgentOrg's home at ${leftHome}. Move it back to ${home}, then run agentorg uninstall again.`,
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
  rmSync(plistPath(system.userHome), { force: true });
  if (was !== "none") said.push("Removed the service.");
  const installed = parts.filter((part) => existsSync(part));
  for (const part of installed) rmSync(part, { recursive: true, force: true });
  if (installed.length > 0) said.push(`Removed AgentOrg from ${root}.`);
  if (existsSync(launcher) && readFileSync(launcher, "utf8").includes(LAUNCHER_MARK)) {
    rmSync(launcher, { force: true });
    said.push(`Removed its launcher, ${launcher}.`);
  }
  if (deleteHome && existsSync(home)) {
    rmSync(home, { recursive: true, force: true });
    said.push(`Removed its home, ${home}.`);
  } else if (existsSync(home))
    said.push(
      `Its home stays at ${home}, with your agents, their chats and sign-ins. agentorg uninstall --delete-home removes it too.`,
    );
  try {
    if (readdirSync(root).length === 0) rmSync(root, { recursive: true });
  } catch {}
  if (existsSync(agents)) said.push(`${agents}, where your agents work, stays as it is.`);
  const macApp = macApps.find((app) => existsSync(app));
  if (macApp)
    said.push(
      `The AgentOrg app stays, still lending this Mac. To remove it too: "${macApp}/Contents/MacOS/AgentOrg" uninstall`,
    );
  if (said.length === 0) said.push("AgentOrg isn't installed here.");
  return said;
}
