import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  homeOf,
  LABEL,
  logPath,
  plistFor,
  plistPath,
  ServiceError,
  start,
  status,
  stop,
} from "../src/service.ts";
import { folder, machine, run, setUpOn } from "./machine.ts";

test("the service's file runs the app on its home, at login and again whenever it ends", () => {
  const home = "/Users/x/Agent & Org <home>";
  const text = plistFor(run(home, { PATH: "/a b:/usr/bin", AGENTCOMPUTER_DATA: "/d&e" }));
  assert.match(text, new RegExp(`<key>Label</key>\\s*<string>${LABEL}</string>`));
  // The program, the app's command, the home and no browser, in that order, escaped.
  assert.match(
    text,
    /<array>\s*<string>\/opt\/node\/bin\/node<\/string>\s*<string>\/opt\/agentorg\/dist\/src\/cli\.js<\/string>\s*<string>--home<\/string>\s*<string>\/Users\/x\/Agent &amp; Org &lt;home&gt;<\/string>\s*<string>--no-open<\/string>\s*<\/array>/,
  );
  assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(text, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(text, /<key>ProcessType<\/key>\s*<string>Interactive<\/string>/);
  // What it writes goes to the home's log; its environment is the one given.
  assert.equal(logPath("/h"), "/h/logs/core.log");
  assert.match(
    text,
    /<key>StandardErrorPath<\/key>\s*<string>\/Users\/x\/Agent &amp; Org &lt;home&gt;\/logs\/core\.log<\/string>/,
  );
  assert.match(
    text,
    /<key>PATH<\/key>\s*<string>\/a b:\/usr\/bin<\/string>\s*<key>AGENTCOMPUTER_DATA<\/key>\s*<string>\/d&amp;e<\/string>/,
  );
  // The home is read back as it was given.
  assert.equal(homeOf(text), home);
  assert.equal(homeOf("<plist/>"), undefined);
});

test("macOS reads the service's file as a property list", {
  skip: process.platform !== "darwin",
}, (t) => {
  const file = join(folder(t, "agentorg-plist-"), `${LABEL}.plist`);
  writeFileSync(file, plistFor(run("/Users/x/Agent & Org <home>", { PATH: "/usr/bin", X: "a&b" })));
  // plutil only reads the file it is given.
  assert.match(execFileSync("plutil", ["-lint", file], { encoding: "utf8" }), /OK/);
  const read = JSON.parse(
    execFileSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }),
  );
  assert.deepEqual(read.ProgramArguments.slice(2), [
    "--home",
    "/Users/x/Agent & Org <home>",
    "--no-open",
  ]);
  assert.deepEqual(read.EnvironmentVariables, { PATH: "/usr/bin", X: "a&b" });
});

test("off macOS, the service commands say so and touch nothing", async (t) => {
  const { system, log } = machine(folder(t, "agentorg-account-"), { platform: "linux" });
  await assert.rejects(start(system, run("/h")), (error: Error) => {
    assert.ok(error instanceof ServiceError);
    assert.match(error.message, /macOS only for now\. Here, run agentorg in a terminal\./);
    return true;
  });
  await assert.rejects(stop(system, "/h"), ServiceError);
  assert.deepEqual(log, []);
  // Status still says whether the app runs.
  assert.deepEqual(await status(system, "/h"), {
    lines: ["AgentOrg isn't running on /h."],
    running: false,
  });
});

test("start sets the service up, makes its log's folder and waits for the app to answer", async (t) => {
  const userHome = folder(t, "agentorg-account-");
  const home = join(userHome, "home");
  const { system, log, isLoaded } = machine(userHome);
  assert.deepEqual(await start(system, run(home)), { url: "http://127.0.0.1:7731" });
  assert.equal(readFileSync(plistPath(userHome), "utf8"), plistFor(run(home)));
  assert.ok(existsSync(join(home, "logs")));
  assert.deepEqual(log, [
    `print gui/501/${LABEL}`,
    `enable gui/501/${LABEL}`,
    `bootstrap gui/501 ${plistPath(userHome)}`,
    `(${home} answers)`,
  ]);
  assert.ok(isLoaded());
  // Started again as it is, it changes nothing in launchd; a log folder that went is made again.
  rmSync(join(home, "logs"), { recursive: true });
  log.length = 0;
  assert.deepEqual(await start(system, run(home)), { url: "http://127.0.0.1:7731" });
  assert.deepEqual(log, [`print gui/501/${LABEL}`, `enable gui/501/${LABEL}`]);
  assert.ok(existsSync(join(home, "logs")));
});

test("start on a service that is loaded but whose app has ended starts the app again", async (t) => {
  const userHome = folder(t, "agentorg-account-");
  const home = join(userHome, "home");
  setUpOn(userHome, home);
  const { system, log } = machine(userHome, { loaded: true });
  await start(system, run(home));
  assert.deepEqual(log.slice(-2), [`kickstart gui/501/${LABEL}`, `(${home} answers)`]);
});

test("start for another home takes the service over once launchd has let it go and its app has ended", async (t) => {
  const userHome = folder(t, "agentorg-account-");
  const fresh = join(userHome, "new-home");
  setUpOn(userHome, "/old");
  const { system, log } = machine(userHome, {
    loaded: true,
    apps: { "/old": { url: "http://127.0.0.1:7731", pid: 7 } },
    unloadsAfter: 2,
    endsAfter: 4,
  });
  assert.deepEqual(await start(system, run(fresh)), {
    url: "http://127.0.0.1:7731",
    note: "It ran on /old before.",
  });
  assert.equal(homeOf(readFileSync(plistPath(userHome), "utf8")), fresh);
  // Handed over only once the old one is gone, so the new app finds its port and home free.
  assert.deepEqual(
    log.filter((line) => !line.startsWith("print")),
    [
      `bootout gui/501/${LABEL}`,
      "(unloaded)",
      "(/old ended)",
      `enable gui/501/${LABEL}`,
      `bootstrap gui/501 ${plistPath(userHome)}`,
      `(${fresh} answers)`,
    ],
  );
});

test("start refuses while the app runs on its home outside the service, wherever the service runs", async (t) => {
  const userHome = folder(t, "agentorg-account-");
  const terminal = { url: "http://127.0.0.1:5000", pid: 9 };
  // No service.
  const alone = machine(userHome, { apps: { "/h": terminal } });
  await assert.rejects(
    start(alone.system, run("/h")),
    /^Error: AgentOrg is already running on \/h \(process 9\), but not as the service\. Stop it where it was started, then run agentorg start\.$/,
  );
  assert.deepEqual(alone.log, [`print gui/501/${LABEL}`]);
  // The service on another home: that one is left running, and nothing is waited for.
  setUpOn(userHome, "/other");
  const beside = machine(userHome, {
    loaded: true,
    apps: { "/h": terminal, "/other": { url: "http://127.0.0.1:7731", pid: 7 } },
  });
  await assert.rejects(start(beside.system, run("/h")), /but not as the service/);
  assert.deepEqual(beside.log, [`print gui/501/${LABEL}`]);
  assert.ok(beside.isLoaded());
});

test("start asks launchd again when it refuses at first, and says where to look when it keeps refusing", async (t) => {
  const userHome = folder(t, "agentorg-account-");
  const home = join(userHome, "home");
  const late = machine(userHome, { refuses: { verb: "bootstrap", times: 2 } });
  await start(late.system, run(home));
  assert.equal(late.log.filter((line) => line.startsWith("bootstrap")).length, 3);

  const other = folder(t, "agentorg-account-");
  const refused = machine(other, { refuses: { verb: "bootstrap" } });
  await assert.rejects(start(refused.system, run(join(other, "home"))), (error: Error) => {
    assert.equal(
      error.message,
      "Starting the service didn't work: launchctl bootstrap said Bootstrap failed: 5: Input/output error. If AgentOrg is switched off under System Settings, General, Login Items, switch it on and run agentorg start again.",
    );
    return true;
  });
  const silent = machine(folder(t, "agentorg-account-"), { answersAfter: 1_000_000 });
  await assert.rejects(start(silent.system, run(home)), (error: Error) => {
    assert.equal(
      error.message,
      `The service started, but AgentOrg didn't answer within 60 seconds. What it said is in ${logPath(home)}.`,
    );
    return true;
  });
});

test("stop keeps the service from starting at login, and waits for launchd and its app", async (t) => {
  const userHome = folder(t, "agentorg-account-");
  setUpOn(userHome, "/h");
  const { system, log, isLoaded, apps } = machine(userHome, {
    loaded: true,
    apps: { "/h": { url: "http://127.0.0.1:7731", pid: 7 } },
    unloadsAfter: 2,
    endsAfter: 3,
  });
  assert.deepEqual(await stop(system, "/h"), { was: "running", on: "/h" });
  // Disabled before it is taken out, so nothing starts it in between.
  assert.deepEqual(
    log.filter((line) => !line.startsWith("print")),
    [`disable gui/501/${LABEL}`, `bootout gui/501/${LABEL}`, "(unloaded)", "(/h ended)"],
  );
  assert.equal(isLoaded(), false);
  assert.equal(apps.size, 0);
  // Set up but not running, it is still kept from starting at the next login.
  log.length = 0;
  assert.deepEqual(await stop(system, "/h"), { was: "set-up", on: "/h" });
  assert.deepEqual(log, [`print gui/501/${LABEL}`, `disable gui/501/${LABEL}`]);
});

test("stop with no service set up leaves any app alone", async (t) => {
  const none = machine(folder(t, "agentorg-account-"));
  assert.deepEqual(await stop(none.system, "/h"), { was: "none" });
  const terminal = machine(folder(t, "agentorg-account-"), {
    apps: { "/h": { url: "http://127.0.0.1:5000", pid: 9 } },
  });
  await assert.rejects(
    stop(terminal.system, "/h"),
    /running on \/h, but not as the service\. Stop it where it was started\./,
  );
  assert.deepEqual(terminal.log, [`print gui/501/${LABEL}`]);
});

test("stop says when the app outlasts the service", async (t) => {
  const userHome = folder(t, "agentorg-account-");
  setUpOn(userHome, "/h");
  const { system } = machine(userHome, {
    loaded: true,
    apps: { "/h": { url: "http://127.0.0.1:7731", pid: 7 } },
    endsAfter: 1_000_000,
  });
  await assert.rejects(
    stop(system, "/h"),
    /The service was told to stop, but AgentOrg on \/h hasn't ended after 15 seconds\./,
  );
});

test("status says whether the app runs, where, and whether it is the service", async (t) => {
  const userHome = folder(t, "agentorg-account-");
  assert.deepEqual(await status(machine(userHome).system, "/h"), {
    lines: [
      "AgentOrg isn't running on /h.",
      "It isn't set up as a service. agentorg start sets it up.",
    ],
    running: false,
  });
  setUpOn(userHome, "/h");
  const on = machine(userHome, {
    loaded: true,
    apps: { "/h": { url: "http://127.0.0.1:7731", pid: 7, version: "0.0.22" } },
  });
  assert.deepEqual(await status(on.system, "/h"), {
    lines: [
      "AgentOrg 0.0.22 is running at http://127.0.0.1:7731, on /h.",
      "The service is on: it starts at login and again if it ends.",
    ],
    running: true,
  });
  // A stopped service for another home is named.
  assert.deepEqual((await status(machine(userHome).system, "/other")).lines, [
    "AgentOrg isn't running on /other.",
    "The service is stopped, for /h. agentorg start starts it.",
  ]);
});
