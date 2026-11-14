// The app's assembly, over stand-ins for the two releases, in their real layouts, and the
// workspace: what it fetches and checks, what it takes of each, and what it refuses. No network,
// and nothing of macOS's own.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assemble } from "../scripts/assemble.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const config = JSON.parse(
  readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);
const real = JSON.parse(readFileSync(new URL("../assembly.json", import.meta.url), "utf8"));

/** Writes files into a folder: their paths, and what each holds. */
const files = (folder, held) => {
  for (const [path, body] of Object.entries(held)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), body);
  }
};

/** A tarball of these files, as a release's. */
const tarball = (root, name, held) => {
  const folder = join(root, `${name}.files`);
  files(folder, held);
  execFileSync("tar", ["-czf", join(root, name), "-C", folder, "."]);
  return readFileSync(join(root, name));
};

/** Stand-ins for both releases, a workspace, and what a run is answered. */
function standIns(t) {
  const root = mkdtempSync(join(tmpdir(), "assembly-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const node = tarball(root, "node", {
    "node-v24.22.1-darwin-arm64/bin/node": "node program",
    "node-v24.22.1-darwin-arm64/LICENSE": "Node's licence",
    "node-v24.22.1-darwin-arm64/lib/node_modules/npm/LICENSE": "npm's licence",
  });
  const driver = tarball(root, "driver", {
    "cua-driver-rs-0.49.7-darwin-universal/CuaDriver.app/Contents/MacOS/cua-driver": "the app's",
    "cua-driver-rs-0.49.7-darwin-universal/cua-driver": "the bare driver",
    "cua-driver-rs-0.49.7-darwin-universal/LICENSE": "the driver's licence",
    "cua-driver-rs-0.49.7-darwin-universal/THIRD_PARTY_NOTICES.md": "what the driver bundles",
    "cua-driver-rs-0.49.7-darwin-universal/perception/cua-perception": "the AGPL extension",
  });
  // The real pins' names and what to take, with the stand-ins' sums and addresses.
  const pins = {
    node: {
      ...real.node,
      take: { ...real.node.take },
      url: "https://node/file",
      sums: "https://node/sums",
      sha256: sha256(node),
    },
    driver: {
      ...real.driver,
      url: "https://driver/file",
      sums: "https://driver/sums",
      release: "https://driver/release",
      sha256: sha256(driver),
    },
  };
  const served = {
    "https://node/file": node,
    // Both formats of a sums line, and a name that ends with the wanted one.
    "https://node/sums": `${"0".repeat(64)}  x${pins.node.file}\n${sha256(node)}  ${pins.node.file}\n`,
    "https://driver/file": driver,
    "https://driver/sums": `${sha256(driver)} *${pins.driver.file}\n`,
    "https://driver/release": JSON.stringify({
      assets: [{ name: pins.driver.file, digest: `sha256:${sha256(driver)}` }],
    }),
  };
  const asked = [];
  const get = async (url) => {
    asked.push(url);
    const body = served[url];
    return body === undefined
      ? { ok: false, status: 404 }
      : {
          ok: true,
          status: 200,
          arrayBuffer: async () => Buffer.from(body),
          text: async () => String(body),
          json: async () => JSON.parse(String(body)),
        };
  };
  const workspace = join(root, "workspace/packages/mac");
  files(join(root, "workspace"), {
    "packages/mac/package.json": "{}",
    "node_modules/@agentorg/computer/package.json": JSON.stringify({
      version: "0.0.20",
      type: "module",
      dependencies: { "playwright-core": "1.65.0-alpha" },
      optionalDependencies: { "node-pty": "1.1.0" },
    }),
    "node_modules/@agentorg/computer/LICENSE": "Apache-2.0",
    "node_modules/@agentorg/computer/NOTICE": "notice",
    "node_modules/@agentorg/computer/dist/agentcomputer.js": "the service",
    "node_modules/@agentorg/computer/dist/sdk.js": "the SDK",
    "node_modules/@agentorg/computer/dist/THIRD_PARTY_LICENSES.txt": "its licences",
    "node_modules/@agentorg/computer/node_modules/playwright-core/package.json": JSON.stringify({
      version: "1.65.0-alpha",
    }),
    "node_modules/@agentorg/computer/node_modules/playwright-core/index.js": "playwright",
    "node_modules/playwright-core/package.json": JSON.stringify({ version: "1.64.1" }),
    "node_modules/node-pty/package.json": JSON.stringify({ version: "1.1.0" }),
    "node_modules/node-pty/LICENSE": "MIT",
    "node_modules/node-pty/lib/index.js": "pty",
    "node_modules/node-pty/prebuilds/darwin-arm64/pty.node": "native",
    "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper": "helper",
    "node_modules/node-pty/prebuilds/linux-x64/pty.node": "linux native",
    "node_modules/node-pty/src/unix/pty.cc": "source",
  });
  const signed = [];
  const target = join(root, "target");
  const run = (service = "0.0.20") =>
    assemble({
      pins,
      target,
      workspace,
      service,
      get,
      signing: (path, entitlements) => signed.push([path, entitlements]),
    });
  return { pins, served, asked, signed, target, run };
}

const listed = (folder) =>
  readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((one) => one.isFile())
    .map((one) => join(one.parentPath, one.name).slice(folder.length + 1))
    .sort();

test("the bundle carries Node, the driver and the service, and their licences, each signed", async (t) => {
  const { pins, signed, target, run } = standIns(t);
  const said = await run();
  const bundle = join(target, "bundle");
  const pty = "Resources/agentcomputer/node_modules/node-pty";
  assert.deepEqual(listed(bundle), [
    "MacOS/cua-driver",
    "MacOS/node",
    "Resources/agentcomputer/LICENSE",
    "Resources/agentcomputer/NOTICE",
    "Resources/agentcomputer/dist/THIRD_PARTY_LICENSES.txt",
    "Resources/agentcomputer/dist/agentcomputer.js",
    `${pty}/LICENSE`,
    `${pty}/lib/index.js`,
    `${pty}/package.json`,
    `${pty}/prebuilds/darwin-arm64/pty.node`,
    `${pty}/prebuilds/darwin-arm64/spawn-helper`,
    "Resources/agentcomputer/node_modules/playwright-core/index.js",
    "Resources/agentcomputer/node_modules/playwright-core/package.json",
    "Resources/agentcomputer/package.json",
    "Resources/licenses/cua-driver/LICENSE",
    "Resources/licenses/cua-driver/THIRD_PARTY_NOTICES.md",
    "Resources/licenses/node/LICENSE",
  ]);
  // The release's own licence, not one it bundles; the bare driver, not the one in its app, which
  // can't be signed as ours.
  const read = (path) => readFileSync(join(bundle, path), "utf8");
  assert.equal(read("Resources/licenses/node/LICENSE"), "Node's licence");
  assert.equal(read("MacOS/cua-driver"), "the bare driver");
  // Each program can run, node-pty's helper too, which it ships unmarked.
  const helper = `${pty}/prebuilds/darwin-arm64/spawn-helper`;
  for (const program of ["MacOS/node", "MacOS/cua-driver", helper])
    assert.equal(statSync(join(bundle, program)).mode & 0o111, 0o111, program);
  assert.deepEqual(
    signed.map(([path, entitlements]) => [path.slice(bundle.length + 1), entitlements]),
    [
      ["MacOS/node", "node.plist"],
      ["MacOS/cua-driver", "cua-driver.plist"],
      [`${pty}/prebuilds/darwin-arm64/pty.node`, undefined],
      [helper, undefined],
    ],
  );
  // Every file the bundle takes from the assembly is there.
  for (const source of Object.values(config.bundle.macOS.files))
    if (source.startsWith("target/assembly/"))
      assert.ok(existsSync(join(target, source.slice("target/assembly/".length))), source);
  // What was fetched, for the person to be told: each file's name, address, size and sha256.
  assert.deepEqual(
    said.fetched.map(({ name, url, sha256: sum }) => [name, url, sum]),
    [
      [pins.node.file, pins.node.url, pins.node.sha256],
      [pins.driver.file, pins.driver.url, pins.driver.sha256],
    ],
  );
  assert.ok(said.fetched.every((one) => one.size > 0 && existsSync(one.at)));
  assert.equal(said.service, "0.0.20");
  assert.deepEqual(JSON.parse(readFileSync(join(target, "fetched.json"), "utf8")), said);
});

test("a download that checks isn't fetched again, and is checked again", async (t) => {
  const { pins, served, asked, run } = standIns(t);
  await run();
  asked.length = 0;
  await run();
  assert.ok(!asked.includes(pins.node.url) && !asked.includes(pins.driver.url), asked.join(", "));
  served[pins.driver.sums] = `${"0".repeat(64)}  ${pins.driver.file}\n`;
  await assert.rejects(run(), /The release's sums give \S+ 0+, not the pinned one\./);
});

test("a download whose sha256 isn't the pin's is refused, in words, removed, and nothing is bundled", async (t) => {
  const { pins, served, target, run } = standIns(t);
  served[pins.driver.url] = Buffer.from("something else");
  await assert.rejects(run(), /darwin-universal\.tar\.gz's sha256 is \w+, not the pinned \w+\./);
  assert.ok(!existsSync(join(target, "downloads/cua-driver-rs-0.49.7-darwin-universal")));
  assert.ok(!existsSync(join(target, "bundle")));
});

test("a driver whose digest on GitHub disagrees with the pin is refused", async (t) => {
  const { pins, served, run } = standIns(t);
  served[pins.driver.release] = JSON.stringify({
    assets: [{ name: pins.driver.file, digest: "sha256:0000" }],
  });
  await assert.rejects(run(), /GitHub's digest of \S+ is sha256:0000, not the pinned one\./);
});

test("a release without a file its pin names, or a service at another version, is refused", async (t) => {
  const { pins, run } = standIns(t);
  pins.node.take["node-v24.22.1-darwin-arm64/bin/npx"] = "MacOS/npx";
  await assert.rejects(run(), /\.tar\.xz has no file node-v24\.22\.1-darwin-arm64\/bin\/npx\./);
  delete pins.node.take["node-v24.22.1-darwin-arm64/bin/npx"];
  await assert.rejects(run("0.0.21"), /@agentorg\/computer is 0\.0\.20 here, not 0\.0\.21\./);
});
