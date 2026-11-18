import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type test from "node:test";
import {
  homeOf,
  plistFor,
  plistPath,
  type RunningApp,
  type ServiceSystem,
} from "../src/service.ts";

export const folder = (t: test.TestContext, prefix: string) => {
  const made = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(made, { recursive: true, force: true }));
  return made;
};

export const run = (
  home: string,
  env: Record<string, string> = { PATH: "/opt/node/bin:/usr/bin:/bin" },
) => ({
  program: "/opt/node/bin/node",
  cli: "/opt/agentorg/dist/src/cli.js",
  home,
  env,
});

/**
 * A stand-in for launchd and the apps on one account: `launchctl` is recorded and acted out, never
 * run, and each home has its own app. What launchd does takes time: a service handed over starts
 * its home's app `answersAfter` waits later; one taken out is let go `unloadsAfter` waits later,
 * and its app ends `endsAfter` waits later. `log` records the calls and, in brackets, those events,
 * in the order they happen.
 */
export function machine(
  userHome: string,
  options: {
    platform?: NodeJS.Platform;
    loaded?: boolean;
    apps?: Record<string, RunningApp>;
    answersAfter?: number;
    unloadsAfter?: number;
    endsAfter?: number;
    /** A verb launchctl refuses, `times` times (every time with none). */
    refuses?: { verb: string; times?: number };
  } = {},
) {
  const log: string[] = [];
  const apps = new Map(Object.entries(options.apps ?? {}));
  let loaded = options.loaded ?? false;
  let refusals = options.refuses?.times ?? Number.POSITIVE_INFINITY;
  let tick = 0;
  let pid = 100;
  const events: { at: number; what: string; then: () => void }[] = [];
  const later = (after: number, what: string, then: () => void) =>
    events.push({ at: tick + after, what, then });
  const serviceHome = () => {
    const file = plistPath(userHome);
    return existsSync(file) ? homeOf(readFileSync(file, "utf8")) : undefined;
  };
  const startApp = () => {
    const home = serviceHome() as string;
    later(options.answersAfter ?? 2, `${home} answers`, () =>
      apps.set(home, { url: "http://127.0.0.1:7731", pid: pid++ }),
    );
  };
  const refusal = { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error\n" };
  const system: ServiceSystem = {
    platform: options.platform ?? "darwin",
    uid: 501,
    userHome,
    async launchctl(args) {
      const [verb] = args;
      log.push(args.join(" "));
      if (verb === options.refuses?.verb && refusals-- > 0) return refusal;
      if (verb === "print") return { code: loaded ? 0 : 113, stdout: "", stderr: "" };
      if (verb === "bootstrap") {
        // launchd takes nothing it already has.
        if (loaded) return refusal;
        loaded = true;
        startApp();
      } else if (verb === "kickstart") startApp();
      else if (verb === "bootout") {
        const home = serviceHome();
        later(options.unloadsAfter ?? 1, "unloaded", () => {
          loaded = false;
        });
        if (home && apps.has(home))
          later(options.endsAfter ?? 1, `${home} ended`, () => apps.delete(home));
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    running: async (home) => apps.get(home),
    alive: (pid) => [...apps.values()].some((app) => app.pid === pid),
    async sleep() {
      tick++;
      for (const due of events.filter((one) => one.at <= tick)) {
        events.splice(events.indexOf(due), 1);
        log.push(`(${due.what})`);
        due.then();
      }
    },
  };
  return { system, log, isLoaded: () => loaded, apps };
}

/** A service already set up on `home` in this account. */
export function setUpOn(userHome: string, home: string) {
  mkdirSync(join(userHome, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plistPath(userHome), plistFor(run(home)));
}
