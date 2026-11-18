import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plistPath, ServiceError, type ServiceSystem, stop } from "./service.js";

/** The one line's script, which also updates what it installed. */
export const INSTALL_SCRIPT = "https://raw.githubusercontent.com/uniac-ai/AgentOrg/main/install.sh";
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
 * `agentorg update`: fetch the line's script and run it with `--update` on `home`, with the
 * terminal's output. It updates the core and the Mac app together, or puts both back. Its exit
 * code is the script's.
 */
export async function update(from: string, home: string): Promise<number> {
  let script: string;
  try {
    const answer = await fetch(from, { signal: AbortSignal.timeout(30_000) });
    if (!answer.ok) throw new Error(`it answered ${answer.status}`);
    script = await answer.text();
  } catch (error) {
    throw new ServiceError(
      `Couldn't fetch the install script from ${from}: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
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
