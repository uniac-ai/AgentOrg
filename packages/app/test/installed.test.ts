import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  ELSEWHERE,
  LAUNCHER_MARK,
  layout,
  recordedChannel,
  uninstall,
  update,
} from "../src/installed.ts";
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
  for (const part of where.parts.filter((part) => part !== where.channel)) {
    mkdirSync(part, { recursive: true });
    writeFileSync(join(part, "file"), "");
  }
  writeFileSync(where.channel, "latest\n");
  mkdirSync(join(userHome, ".local", "bin"), { recursive: true });
  writeFileSync(where.launcher, `#!/bin/sh\n${LAUNCHER_MARK}\nexec true\n`);
  const home = join(where.root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "hub.db"), "");
  mkdirSync(join(where.agents, "Assistant"), { recursive: true });
  mkdirSync(join(userHome, "Applications", "AgentOrg.app"), { recursive: true });
  return { ...where, home, macApp: join(userHome, "Applications", "AgentOrg.app") };
}

test("uninstall stops and removes the service, the Mac app and what the line installed, and keeps the home and the agents' folder", async (t) => {
  const userHome = folder(t, "agentorg-account-");
  const where = installedIn(t, userHome);
  setUpOn(userHome, where.home);
  const program = `${where.macApp}/Contents/MacOS/AgentOrg`;
  const heard: string[] = [];
  const { system, log, isLoaded } = machine(userHome, {
    loaded: true,
    apps: { [where.home]: { url: "http://127.0.0.1:7731", pid: 7 } },
    app(args) {
      // The app goes first, with what the line installed still there for another try.
      heard.push(
        `(the app's ${args.join(" ")}, the core's parts there: ${where.parts.every((part) => existsSync(part))})`,
      );
      rmSync(where.macApp, { recursive: true });
      return {
        code: 0,
        stdout: `the background item is unregistered; the driver's default removed\nmacOS's privacy entries for ai.uniac.agentorg reset\n${where.macApp} removed\n`,
        stderr: "",
      };
    },
  });
  const said = [
    "Removed the service.",
    "Removing the AgentOrg app. It waits up to 45 s for what it runs to stop.",
    "  the background item is unregistered; the driver's default removed",
    "  macOS's privacy entries for ai.uniac.agentorg reset",
    `  ${where.macApp} removed`,
    `Removed AgentOrg from ${where.root}.`,
    `Removed its launcher, ${where.launcher}.`,
    `Its home stays at ${where.home}, with your agents, their chats and sign-ins. agentorg uninstall --delete-home removes it too.`,
    `${where.agents}, where your agents work, stays as it is.`,
    'macOS still lists "AgentOrg" in Login Items, switched off. No app can remove that entry, and it starts nothing.',
  ];
  assert.deepEqual(await uninstall(system, where.home, { say: (line) => heard.push(line) }), said);
  // Each line is said as it happens: the app's wait comes after its first line.
  assert.deepEqual(heard, [
    ...said.slice(0, 2),
    "(the app's uninstall --reset-privacy, the core's parts there: true)",
    ...said.slice(2),
  ]);
  assert.deepEqual(log.slice(0, 3), [
    `print gui/501/${LABEL}`,
    `disable gui/501/${LABEL}`,
    `bootout gui/501/${LABEL}`,
  ]);
  // The app is asked once the service has stopped, and its privacy grants go with it.
  assert.equal(log.at(-1), `${program} uninstall --reset-privacy`);
  assert.ok(log.indexOf(`(${where.home} ended)`) < log.length - 1);
  assert.equal(isLoaded(), false);
  assert.equal(existsSync(plistPath(userHome)), false);
  for (const part of where.parts) assert.equal(existsSync(part), false, part);
  assert.equal(existsSync(where.launcher), false);
  assert.equal(existsSync(where.macApp), false);
  assert.ok(existsSync(join(where.home, "hub.db")));
  assert.ok(existsSync(join(where.agents, "Assistant")));
});

test("uninstall takes the Mac app only where the line installed AgentOrg, and where the app can't go, the rest stays for another try", async (t) => {
  const userHome = folder(t, "agentorg-account-");
  const where = installedIn(t, userHome);
  const program = `${where.macApp}/Contents/MacOS/AgentOrg`;
  // The app refuses: it removed nothing, and neither does uninstall, past the service.
  const refused = machine(userHome, {
    app: () => ({
      code: 1,
      stdout: "",
      stderr:
        "the background item couldn't be unregistered: Operation not permitted; nothing removed\n",
    }),
  });
  await assert.rejects(uninstall(refused.system, where.home), (error: Error) => {
    assert.ok(error instanceof ServiceError);
    assert.equal(
      error.message,
      "The AgentOrg app couldn't be removed: the background item couldn't be unregistered: Operation not permitted; nothing removed. The rest of AgentOrg stays, so agentorg uninstall can try again.",
    );
    return true;
  });
  assert.deepEqual(refused.log.at(-1), `${program} uninstall --reset-privacy`);
  assert.ok(where.parts.every((part) => existsSync(part)));
  assert.ok(existsSync(where.launcher));
  assert.ok(existsSync(where.macApp));
  // Run again, it all goes.
  const again = machine(userHome);
  const said = await uninstall(again.system, where.home);
  assert.ok(said.includes(`  ${where.macApp} removed`));
  assert.ok(said.includes(`Removed AgentOrg from ${where.root}.`));
  assert.equal(existsSync(where.macApp), false);
  // AgentOrg from npm, with the app put here another way: the app isn't the line's, and stays.
  mkdirSync(where.macApp, { recursive: true });
  const npm = machine(userHome);
  assert.deepEqual(await uninstall(npm.system, where.home), [
    `Its home stays at ${where.home}, with your agents, their chats and sign-ins. agentorg uninstall --delete-home removes it too.`,
    `${where.agents}, where your agents work, stays as it is.`,
    `The AgentOrg app stays, still lending this Mac. To remove it too: "${program}" uninstall`,
  ]);
  assert.ok(!npm.log.some((call) => call.startsWith(program)));
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

test("update runs the install.sh of the release npm's channel names, with --update on the home and the channel, once its sum is listed, and answers its exit code", async (t) => {
  const scratch = folder(t, "agentorg-update-");
  const said = join(scratch, "said");
  const script = `printf '%s\\n' "$@" "$AGENTORG_HUB_HOME" "$AGENTORG_CHANNEL" > '${said}'\nexit 3\n`;
  const other = sha256("the core's archive");
  const files: Record<string, string> = {
    "/dist-tags": '{"latest":"0.0.30","next":"0.0.31"}',
    "/releases/v0.0.31/install.sh": script,
    "/releases/v0.0.31/SHA256SUMS": `${other}  agentorg-core-0.0.31.tgz\n${sha256(script)}  install.sh\n`,
  };
  const { asked, from } = await releases(t, files);
  assert.equal(await update(from, "/the/home", "next"), 3);
  // install.sh is told the channel, so it keeps the record as it is.
  assert.equal(readFileSync(said, "utf8"), "--update\n/the/home\nnext\n");
  assert.deepEqual(asked, [
    "/dist-tags",
    "/releases/v0.0.31/install.sh",
    "/releases/v0.0.31/SHA256SUMS",
  ]);
  // The form shasum writes for a file read as binary is taken too.
  files["/releases/v0.0.31/install.sh"] = "exit 0\n";
  files["/releases/v0.0.31/SHA256SUMS"] = `${sha256("exit 0\n")} *install.sh\n`;
  assert.equal(await update(from, "/the/home", "next"), 0);
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
    assert.rejects(update(release, "/the/home", "next"), (error: Error) => {
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

test("update follows the channel the line recorded, and next for an install from before channels were recorded", async (t) => {
  const scratch = folder(t, "agentorg-update-");
  const said = join(scratch, "said");
  const script = (version: string) =>
    `printf '%s\\n' ${version} "$AGENTORG_CHANNEL" > '${said}'\nexit 0\n`;
  const files: Record<string, string> = { "/dist-tags": '{"latest":"0.0.30","next":"0.0.31"}' };
  for (const version of ["0.0.30", "0.0.31"]) {
    files[`/releases/v${version}/install.sh`] = script(version);
    files[`/releases/v${version}/SHA256SUMS`] = `${sha256(script(version))}  install.sh\n`;
  }
  const { from } = await releases(t, files);
  const userHome = folder(t, "agentorg-account-");
  const { channel } = layout(userHome);
  for (const [recorded, follows, version] of [
    [undefined, "next", "0.0.31"],
    ["latest\n", "latest", "0.0.30"],
    ["next\n", "next", "0.0.31"],
    ["beta\n", "next", "0.0.31"],
  ] as const) {
    rmSync(channel, { force: true });
    if (recorded !== undefined) {
      mkdirSync(dirname(channel), { recursive: true });
      writeFileSync(channel, recorded);
    }
    assert.equal(recordedChannel(userHome), follows, recorded);
    assert.equal(await update(from, "/the/home", recordedChannel(userHome)), 0);
    assert.equal(readFileSync(said, "utf8"), `${version}\n${follows}\n`);
  }
});
