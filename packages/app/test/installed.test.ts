import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { CHANNEL, ELSEWHERE, LAUNCHER_MARK, layout, uninstall, update } from "../src/installed.ts";
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

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * npm's dist-tags and the releases on 127.0.0.1, answering `files` by path. A release's download
 * answers with a redirect elsewhere, as GitHub's does; one under /away/ with a redirect to https.
 * `asked` is each file asked for, once.
 */
async function releases(t: test.TestContext, files: Record<string, string>) {
  const asked: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    if (path.startsWith("/releases/"))
      return void response.writeHead(302, { location: `/assets${path}` }).end();
    if (path.startsWith("/away/"))
      return void response.writeHead(302, { location: `https://127.0.0.1:1${path}` }).end();
    const file = path.startsWith("/assets/") ? path.slice("/assets".length) : path;
    asked.push(file);
    if (files[file] === undefined) response.writeHead(404).end();
    else response.end(files[file]);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { at, asked, from: { tags: `${at}/dist-tags`, releases: `${at}/releases` } };
}

test("update runs the install.sh of the release npm's next names, with --update on the home, once its sum is listed, and answers its exit code", async (t) => {
  const scratch = folder(t, "agentorg-update-");
  const said = join(scratch, "said");
  const script = `printf '%s\\n' "$@" "$AGENTORG_HUB_HOME" > '${said}'\nexit 3\n`;
  const other = sha256("the core's archive");
  const files: Record<string, string> = {
    "/dist-tags": '{"latest":"0.0.30","next":"0.0.31"}',
    "/releases/v0.0.31/install.sh": script,
    "/releases/v0.0.31/SHA256SUMS": `${other}  agentorg-core-0.0.31.tgz\n${sha256(script)}  install.sh\n`,
  };
  const { asked, from } = await releases(t, files);
  assert.equal(CHANNEL, "next");
  assert.equal(await update(from, "/the/home"), 3);
  assert.equal(readFileSync(said, "utf8"), "--update\n/the/home\n");
  assert.deepEqual(asked, [
    "/dist-tags",
    "/releases/v0.0.31/install.sh",
    "/releases/v0.0.31/SHA256SUMS",
  ]);
  // The form shasum writes for a file read as binary is taken too.
  files["/releases/v0.0.31/install.sh"] = "exit 0\n";
  files["/releases/v0.0.31/SHA256SUMS"] = `${sha256("exit 0\n")} *install.sh\n`;
  assert.equal(await update(from, "/the/home"), 0);
});

test("update refuses an install.sh whose sum differs or isn't listed, a version that isn't one, and a fetch that fails or leaves https, and runs nothing", async (t) => {
  const scratch = folder(t, "agentorg-update-");
  const said = join(scratch, "said");
  const script = `touch '${said}'\n`;
  const files: Record<string, string> = {
    "/dist-tags": '{"next":"0.0.31"}',
    "/releases/v0.0.31/install.sh": script,
  };
  const { at, from } = await releases(t, files);
  const refused = async (message: string, release = from) =>
    assert.rejects(update(release, "/the/home"), (error: Error) => {
      assert.ok(error instanceof ServiceError);
      assert.equal(error.message, message);
      return true;
    });
  files["/releases/v0.0.31/SHA256SUMS"] = `${sha256("another script")}  install.sh\n`;
  await refused(
    `install.sh of AgentOrg 0.0.31 isn't the one its SHA256SUMS lists (its SHA-256 is ${sha256(script)}), so nothing was run.`,
  );
  // A line for another file, with install.sh's own sum, isn't install.sh's.
  files["/releases/v0.0.31/SHA256SUMS"] = `${sha256(script)}  install.sh.old\n`;
  await refused(
    "The SHA256SUMS of AgentOrg 0.0.31 has no line for install.sh, so nothing was run.",
  );
  await refused(
    `Couldn't fetch AgentOrg 0.0.31's install.sh from ${at}/away/v0.0.31/install.sh: it redirected to https://127.0.0.1:1.`,
    { ...from, releases: `${at}/away` },
  );
  // npm has a version whose release isn't up: none before this change carries install.sh.
  files["/dist-tags"] = '{"next":"0.0.30"}';
  await refused(
    "AgentOrg 0.0.30 is on npm, but its release isn't up yet: try again in a few minutes.",
  );
  for (const tags of ['{"next":"0.0.31/../x"}', '{"next":"../0.0.31"}', '{"latest":"0.0.31"}']) {
    files["/dist-tags"] = tags;
    await refused("npm names no version for AgentOrg's next channel, so nothing was run.");
  }
  delete files["/dist-tags"];
  await refused(`Couldn't fetch npm's dist-tags from ${at}/dist-tags: it answered 404.`);
  assert.equal(existsSync(said), false);
});
