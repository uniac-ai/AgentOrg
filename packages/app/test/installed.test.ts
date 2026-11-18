import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { ELSEWHERE, LAUNCHER_MARK, layout, uninstall, update } from "../src/installed.ts";
import { LABEL, plistPath, ServiceError } from "../src/service.ts";
import { folder, machine, setUpOn } from "./machine.ts";

/** An account as the Mac line leaves it: its parts, launcher, home, Mac app and agents' folder. */
function installedIn(t: test.TestContext, userHome: string) {
  const before = process.env.AGENTORG_APP_DIR;
  process.env.AGENTORG_APP_DIR = join(userHome, "Applications");
  t.after(() => {
    if (before === undefined) delete process.env.AGENTORG_APP_DIR;
    else process.env.AGENTORG_APP_DIR = before;
  });
  const where = layout(userHome);
  for (const part of where.parts) {
    mkdirSync(part, { recursive: true });
    writeFileSync(join(part, "file"), "");
  }
  mkdirSync(join(userHome, ".local", "bin"), { recursive: true });
  writeFileSync(where.launcher, `#!/bin/sh\n${LAUNCHER_MARK}\nexec true\n`);
  const home = join(where.root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "hub.db"), "");
  mkdirSync(join(where.agents, "Assistant"), { recursive: true });
  mkdirSync(join(userHome, "Applications", "AgentOrg.app"), { recursive: true });
  return { ...where, home, macApp: join(userHome, "Applications", "AgentOrg.app") };
}

test("uninstall stops and removes the service and what the line installed, and keeps the home, the agents' folder and the Mac app", async (t) => {
  const userHome = folder(t, "agentorg-account-");
  const where = installedIn(t, userHome);
  setUpOn(userHome, where.home);
  const { system, log, isLoaded } = machine(userHome, {
    loaded: true,
    apps: { [where.home]: { url: "http://127.0.0.1:7731", pid: 7 } },
  });
  assert.deepEqual(await uninstall(system, where.home), [
    "Removed the service.",
    `Removed AgentOrg from ${where.root}.`,
    `Removed its launcher, ${where.launcher}.`,
    `Its home stays at ${where.home}, with your agents, their chats and sign-ins. agentorg uninstall --delete-home removes it too.`,
    `${where.agents}, where your agents work, stays as it is.`,
    `The AgentOrg app stays, still lending this Mac. To remove it too: "${where.macApp}/Contents/MacOS/AgentOrg" uninstall`,
  ]);
  assert.deepEqual(log.slice(0, 3), [
    `print gui/501/${LABEL}`,
    `disable gui/501/${LABEL}`,
    `bootout gui/501/${LABEL}`,
  ]);
  assert.equal(isLoaded(), false);
  assert.equal(existsSync(plistPath(userHome)), false);
  for (const part of where.parts) assert.equal(existsSync(part), false, part);
  assert.equal(existsSync(where.launcher), false);
  assert.ok(existsSync(join(where.home, "hub.db")));
  assert.ok(existsSync(join(where.agents, "Assistant")));
  assert.ok(existsSync(where.macApp));
});

test("uninstall --delete-home removes the home too, but only a folder that is an AgentOrg home", async (t) => {
  const userHome = folder(t, "agentorg-account-");
  const where = installedIn(t, userHome);
  const notAHome = join(userHome, "Documents");
  mkdirSync(notAHome);
  const { system } = machine(userHome);
  await assert.rejects(uninstall(system, notAHome, { deleteHome: true }), (error: Error) => {
    assert.ok(error instanceof ServiceError);
    assert.equal(error.message, `${notAHome} isn't an AgentOrg home, so nothing was removed.`);
    return true;
  });
  assert.ok(existsSync(notAHome));
  assert.ok(where.parts.every((part) => existsSync(part)));
  const said = await uninstall(system, where.home, { deleteHome: true });
  assert.ok(said.includes(`Removed its home, ${where.home}.`));
  // Nothing of the line's is left, so its folder goes too.
  assert.equal(existsSync(where.root), false);
  assert.ok(existsSync(join(where.agents, "Assistant")));
});

test("uninstall leaves a launcher it didn't write, refuses while the app runs outside the service, and runs on a Mac only", async (t) => {
  const userHome = folder(t, "agentorg-account-");
  const where = installedIn(t, userHome);
  writeFileSync(where.launcher, "#!/bin/sh\necho someone else's\n");
  const running = machine(userHome, {
    apps: { [where.home]: { url: "http://127.0.0.1:7731", pid: 7 } },
  });
  await assert.rejects(uninstall(running.system, where.home), /Stop it where it was started/);
  assert.ok(where.parts.every((part) => existsSync(part)));
  const { system } = machine(userHome);
  const said = await uninstall(system, where.home);
  assert.ok(said.includes(`Removed AgentOrg from ${where.root}.`));
  assert.ok(!said.some((line) => line.includes("launcher")));
  assert.equal(readFileSync(where.launcher, "utf8"), "#!/bin/sh\necho someone else's\n");
  // An update cut off before it put the home back: what it kept is the only copy, and stays.
  const left = join(where.root, "update-backup", "home");
  mkdirSync(left, { recursive: true });
  writeFileSync(join(left, "hub.db"), "");
  rmSync(where.home, { recursive: true });
  await assert.rejects(
    uninstall(system, where.home),
    new RegExp(`left AgentOrg's home at ${left}\\. Move it back to`),
  );
  assert.ok(existsSync(join(left, "hub.db")));
  const elsewhere = machine(userHome, { platform: "linux" });
  await assert.rejects(uninstall(elsewhere.system, where.home), { message: ELSEWHERE });
  assert.deepEqual(elsewhere.log, []);
});

test("update runs the line's script with --update on the home, and answers its exit code", async (t) => {
  const scratch = folder(t, "agentorg-update-");
  const said = join(scratch, "said");
  let served = `printf '%s\\n' "$@" "$AGENTORG_HUB_HOME" > '${said}'\nexit 3\n`;
  const server = createServer((request, response) => {
    if (request.url === "/install.sh") response.end(served);
    else response.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal(await update(`${at}/install.sh`, "/the/home"), 3);
  assert.equal(readFileSync(said, "utf8"), "--update\n/the/home\n");
  served = "exit 0\n";
  assert.equal(await update(`${at}/install.sh`, "/the/home"), 0);
  await assert.rejects(update(`${at}/gone.sh`, "/the/home"), (error: Error) => {
    assert.ok(error instanceof ServiceError);
    assert.equal(
      error.message,
      `Couldn't fetch the install script from ${at}/gone.sh: it answered 404.`,
    );
    return true;
  });
});
