import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { CLIENT, layout, recordedChannel, update } from "../src/installed.ts";
import { checkForUpdate, DAY_MS, factPath, newer, updateLine } from "../src/updates.ts";
import { folder } from "./machine.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** npm's dist-tags and the releases on 127.0.0.1, answering `files` by path; each request kept. */
async function releases(t: test.TestContext, files: Record<string, string>) {
  const asked: { method?: string; url?: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((request, response) => {
    asked.push({ method: request.method, url: request.url, headers: request.headers });
    const file = files[request.url ?? ""];
    if (file === undefined) response.writeHead(404).end();
    else response.end(file);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    at,
    asked,
    from: { tags: `${at}/dist-tags`, releases: `${at}/releases`, notes: `${at}/notes` },
  };
}

/** An account the one line installed AgentOrg in, on `channel`, or before channels were recorded. */
function installedOn(t: test.TestContext, channel?: string) {
  const userHome = folder(t, "agentorg-account-");
  const { root, channel: record } = layout(userHome);
  mkdirSync(join(root, "app"), { recursive: true });
  symlinkSync("0.0.40", join(root, "app", "current"));
  if (channel !== undefined) writeFileSync(record, `${channel}\n`);
  return { userHome, record };
}

test("what agentorg status tells of is the release agentorg update moves to, on the channel the line recorded", async (t) => {
  const scratch = folder(t, "agentorg-update-");
  const ran = join(scratch, "ran");
  const files: Record<string, string> = { "/dist-tags": '{"latest":"0.0.40","next":"0.0.41"}' };
  for (const version of ["0.0.40", "0.0.41"]) {
    const script = `printf '%s\\n' ${version} > '${ran}'\n`;
    files[`/releases/v${version}/install.sh`] = script;
    files[`/releases/v${version}/SHA256SUMS`] = `${sha256(script)}  install.sh\n`;
  }
  const { at, from } = await releases(t, files);
  const { userHome, record } = installedOn(t, "next");
  const fact = await checkForUpdate(userHome, from);
  assert.equal(fact?.version, "0.0.41");
  assert.equal(
    updateLine(userHome, "0.0.40"),
    `Update available: 0.0.40 → 0.0.41. Run agentorg update. Release notes: ${at}/notes/v0.0.41`,
  );
  assert.equal(await update(from, "/the/home", recordedChannel(userHome)), 0);
  assert.equal(readFileSync(ran, "utf8"), "0.0.41\n");
  // Moved to latest, what was read for next is no longer told, and the next check reads latest's.
  writeFileSync(record, "latest\n");
  assert.equal(updateLine(userHome, "0.0.39"), undefined);
  assert.equal((await checkForUpdate(userHome, from))?.version, "0.0.40");
  assert.match(updateLine(userHome, "0.0.39") ?? "", /^Update available: 0\.0\.39 → 0\.0\.40\./);
  assert.equal(await update(from, "/the/home", recordedChannel(userHome)), 0);
  assert.equal(readFileSync(ran, "utf8"), "0.0.40\n");
});

test("the check reads at most once a day, sends nothing about the person, and keeps what it had when a read fails", async (t) => {
  const files: Record<string, string> = { "/dist-tags": '{"next":"0.0.41"}' };
  const { asked, from } = await releases(t, files);
  const { userHome } = installedOn(t);
  let now = new Date("2026-11-24T10:00:00Z");
  const clock = () => now;
  assert.equal((await checkForUpdate(userHome, from, clock))?.version, "0.0.41");
  assert.equal(asked.length, 1);
  // A plain GET of npm's dist-tags: no query, and of who asks only a client name and version.
  const [read] = asked;
  assert.equal(read?.method, "GET");
  assert.equal(read?.url, "/dist-tags");
  assert.equal(read?.headers["user-agent"], CLIENT);
  assert.match(CLIENT, /^agentorg\/\d+\.\d+\.\d+(-[\w.]+)?$/);
  // What fetch sends of itself, and nothing else.
  assert.deepEqual(Object.keys(read?.headers ?? {}).sort(), [
    "accept",
    "accept-encoding",
    "accept-language",
    "connection",
    "host",
    "sec-fetch-mode",
    "user-agent",
  ]);
  // Within the day, nothing is read.
  files["/dist-tags"] = '{"next":"0.0.42"}';
  now = new Date(now.getTime() + DAY_MS - 1);
  assert.equal((await checkForUpdate(userHome, from, clock))?.version, "0.0.41");
  assert.equal(asked.length, 1);
  now = new Date(now.getTime() + 1);
  assert.equal((await checkForUpdate(userHome, from, clock))?.version, "0.0.42");
  assert.equal(asked.length, 2);
  // A read that fails a day later keeps the release as it was, and counts as the day's ask.
  delete files["/dist-tags"];
  now = new Date(now.getTime() + DAY_MS);
  assert.equal((await checkForUpdate(userHome, from, clock))?.version, "0.0.42");
  assert.equal(asked.length, 3);
  files["/dist-tags"] = '{"next":"0.0.43"}';
  now = new Date(now.getTime() + DAY_MS - 1);
  assert.equal((await checkForUpdate(userHome, from, clock))?.version, "0.0.42");
  assert.equal(asked.length, 3);
  files["/dist-tags"] = '{"next":"not a version"}';
  now = new Date(now.getTime() + 1);
  assert.equal((await checkForUpdate(userHome, from, clock))?.version, "0.0.42");
  assert.equal(asked.length, 4);
  assert.equal(JSON.parse(readFileSync(factPath(userHome), "utf8")).askedAt, now.toISOString());
});

test("nothing is read or told where the line didn't install AgentOrg, or for a release no newer than this one", async (t) => {
  const { asked, from } = await releases(t, { "/dist-tags": '{"next":"0.0.41"}' });
  const elsewhere = folder(t, "agentorg-account-");
  assert.equal(await checkForUpdate(elsewhere, from), undefined);
  assert.equal(updateLine(elsewhere, "0.0.40"), undefined);
  assert.deepEqual(asked, []);
  assert.equal(existsSync(factPath(elsewhere)), false);
  const { userHome } = installedOn(t, "next");
  await checkForUpdate(userHome, from);
  for (const current of ["0.0.41", "0.0.42", "0.1.0"])
    assert.equal(updateLine(userHome, current), undefined, current);
  assert.ok(updateLine(userHome, "0.0.41-rc.1"));
  assert.ok(newer("0.0.10", "0.0.9"));
  assert.ok(!newer("0.0.9", "0.0.10"));
  assert.ok(newer("0.0.41-rc.2", "0.0.41-rc.1"));
  assert.ok(!newer("0.0.41-rc.1", "0.0.41"));
});
