import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hubPackages } from "@agentorg/interfaces";
import type { Refused } from "@agentorg/sdk";
import { buildPackage } from "@agentorg/sdk/build";
import { connect } from "@agentorg/sdk/client";
import { Hub, listen, PERSON } from "../src/index.ts";
import { defaultSandbox, rootFolder } from "../src/processes.ts";

// dist/test/build.test.js → the fixture's source, beside the test sources.
/** The hub package's folder, from which a Hub build finds the packages it allows. */
const hubFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "fixtures",
  "counter",
);
/** The counter package's source, as data. */
const source = (): Record<string, string> => ({
  "package.json": readFileSync(join(fixture, "package.json"), "utf8"),
  "src/counter.ts": readFileSync(join(fixture, "src", "counter.ts"), "utf8"),
  "src/interface.ts": readFileSync(join(fixture, "src", "interface.ts"), "utf8"),
});

async function setup(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "agentorg-build-"));
  const home = join(dir, "home");
  const hub = Hub.open(home);
  const server = await listen(hub);
  const person = await connect({
    hubUrl: server.url,
    actorId: PERSON,
    credential: readFileSync(join(home, "person-credential"), "utf8").trim(),
    slots: { packages: hubPackages },
    declare: false,
  });
  t.after(async () => {
    person.close();
    await server.close();
    hub.close();
    rmSync(dir, { recursive: true, force: true });
  });
  /** Nothing of a build is left in the home. */
  const leftovers = () => readdirSync(home).filter((name) => name.startsWith("build-"));
  return { hub, dir, person, leftovers };
}

const refusedWith = (code: string, match?: RegExp) => (error: Refused) =>
  error.code === code && (!match || match.test(error.message));

test("source given as data builds to the same package as agentorg build, and is added", async (t) => {
  const { hub, dir, person, leftovers } = await setup(t);
  const expected = await buildPackage(fixture, { out: join(dir, "out") });
  const built = await person.slots.packages.call.build({ files: source() });
  assert.equal(built.hash, expected.hash);
  assert.deepEqual(built.manifest, JSON.parse(JSON.stringify(expected.manifest)));
  assert.equal(hub.state.package(built.hash).manifest.name, "counter");
  assert.ok(
    hub.state.audit(0, 1000).entries.some((e) => e.kind === "package.build" && e.actor === PERSON),
  );
  assert.deepEqual(leftovers(), []);
});

test("a build that fails says why, so the source can be fixed", async (t) => {
  const { person, leftovers } = await setup(t);
  const broken = (counter: string) =>
    person.slots.packages.call.build({ files: { ...source(), "src/counter.ts": counter } });
  // A syntax error, with its place.
  await assert.rejects(
    broken("export default defineActor({ start( }"),
    refusedWith("build", /src\/counter\.ts:\d+/),
  );
  // A missing import.
  await assert.rejects(
    broken('import { nope } from "./missing.ts";\nexport default nope;'),
    refusedWith("build", /missing\.ts/),
  );
  // A package the Hub has but doesn't allow, and a path out of the package's folder.
  await assert.rejects(
    broken('import ws from "ws";\nexport default ws;'),
    refusedWith("build", /imports only @agentorg\/sdk, @agentorg\/interfaces, zod/),
  );
  await assert.rejects(
    broken('import x from "../../../person-credential";\nexport default x;'),
    refusedWith("build", /leaves the package's folder/),
  );
  // A module entry outside the folder.
  const manifest = JSON.parse(source()["package.json"] as string);
  manifest.agentorg.modules.counter = "../../person-credential";
  await assert.rejects(
    person.slots.packages.call.build({
      files: { ...source(), "package.json": JSON.stringify(manifest) },
    }),
    refusedWith("build", /outside the package's folder/),
  );
  // Nothing in a message names a path outside the package: the home, an install, the describer.
  for (const counter of [
    'import { defineActor } from "@agentorg/sdk/build";\nexport default defineActor;',
    'import x from "/etc/passwd";\nexport default x;',
    'import x from "/no/such/file";\nexport default x;',
  ])
    await assert.rejects(broken(counter), (error: Refused) => {
      assert.equal(error.code, "build");
      assert.doesNotMatch(error.message, /\/(Users|home|private|tmp|var)\/|\.\.\//, error.message);
      return true;
    });
  // An absolute path outside is refused as text: whether it exists isn't told.
  const told: string[] = [];
  for (const path of ["/etc/passwd", "/no/such/file"])
    told.push(
      await broken(`import x from "${path}";\nexport default x;`).then(
        () => "built",
        (error: Refused) => error.message.replace(path, "<path>"),
      ),
    );
  const [present, absent] = told;
  assert.equal(present, absent);
  const missing = JSON.parse(source()["package.json"] as string);
  missing.agentorg.modules.counter = "src/nope.ts";
  await assert.rejects(
    person.slots.packages.call.build({
      files: { ...source(), "package.json": JSON.stringify(missing) },
    }),
    (error: Refused) => !/\/(Users|home|private|tmp|var)\//.test(error.message),
  );
  assert.deepEqual(leftovers(), []);
});

test("source is refused before anything is written unless it is package.json and src/, within the size", async (t) => {
  const { person, leftovers } = await setup(t);
  for (const path of [
    "../escape.ts",
    "/abs.ts",
    "src/../x.ts",
    "src//x.ts",
    "src/",
    "README.md",
    "src/.hidden/x.ts",
    "src\\x.ts",
    // A tsconfig or jsconfig can name any file for the build to read and quote.
    "src/tsconfig.json",
    "src/jsconfig.json",
    "src/lib/package.json",
    "src/notes.txt",
  ])
    await assert.rejects(
      person.slots.packages.call.build({ files: { ...source(), [path]: "x" } }),
      refusedWith("invalid"),
      path,
    );
  await assert.rejects(
    person.slots.packages.call.build({ files: { "src/counter.ts": "x" } }),
    refusedWith("invalid", /package\.json/),
  );
  await assert.rejects(
    person.slots.packages.call.build({
      files: { ...source(), "src/big.ts": "x".repeat(800 * 1024) },
    }),
    (error: Refused) => error.code === "invalid",
  );
  assert.deepEqual(leftovers(), []);
});

test("a build keeps to its limits: 16 modules, one build per caller at a time", async (t) => {
  const { person, leftovers } = await setup(t);
  const many = JSON.parse(source()["package.json"] as string);
  many.agentorg.modules = Object.fromEntries(
    Array.from({ length: 17 }, (_, i) => [`m${i}`, "src/counter.ts"]),
  );
  await assert.rejects(
    person.slots.packages.call.build({
      files: { ...source(), "package.json": JSON.stringify(many) },
    }),
    refusedWith("build", /at most 16 modules/),
  );
  // Two at once from one caller: whichever the Hub takes second is refused, the other goes on.
  const both = await Promise.allSettled([
    person.slots.packages.call.build({ files: source() }),
    person.slots.packages.call.build({ files: source() }),
  ]);
  assert.equal(both.filter((r) => r.status === "fulfilled").length, 1);
  const refused = both.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.equal((refused.reason as Refused).code, "busy");
  // Names that clash but for case, and a path that is both a file and a folder.
  const clashes: Record<string, string>[] = [
    { "src/Counter.ts": "export {};" },
    { "src/q.ts": "x", "src/q.ts/r.ts": "y" },
  ];
  for (const extra of clashes)
    await assert.rejects(
      person.slots.packages.call.build({ files: { ...source(), ...extra } }),
      refusedWith("invalid"),
    );
  assert.deepEqual(leftovers(), []);
});

test("folders a crashed build left are removed when the Hub opens", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agentorg-build-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  Hub.open(home).close();
  mkdirSync(join(home, "build-crashed", "source"), { recursive: true });
  Hub.open(home).close();
  assert.deepEqual(
    readdirSync(home).filter((name) => name.startsWith("build-")),
    [],
  );
});

test("nothing outside the package gets in: pattern imports, the host's details, memory", async (t) => {
  const { person, leftovers } = await setup(t);
  const broken = (counter: string, extra: Record<string, string> = {}) =>
    person.slots.packages.call.build({
      files: { ...source(), "src/counter.ts": counter, ...extra },
    });
  // A template string in import() or require() is a pattern esbuild would fill with every file it
  // matches, the Hub's home among them.
  for (const pattern of [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source under test, with a template string.
    'const n = globalThis.x;\nexport default () => import(`../../../${n}`, { with: { type: "text" } });',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source under test, with a template string.
    "const n = globalThis.x;\nexport default () => require(`../../../../${n}.json`);",
  ])
    await assert.rejects(broken(pattern), (error: Refused) => {
      assert.equal(error.code, "build");
      assert.match(error.message, /pattern import/);
      assert.doesNotMatch(error.message, /SQLite|person-credential/);
      return true;
    });
  // The describer tells nothing of the host: its report, paths and command line are closed.
  await assert.rejects(
    broken(
      "export default (() => { throw new Error([typeof process.report, process.execPath].join()); })();",
    ),
    (error: Refused) =>
      !error.message.includes(process.execPath) && /not available/.test(error.message),
  );
  // Memory outside its heap (ArrayBuffers) is watched: past the cap, the describer stops.
  await assert.rejects(
    broken(
      "const kept = [];\nfor (let i = 0; i < 12; i++) kept.push(new Uint8Array(256 * 1024 * 1024).fill(1));\nexport default kept;",
    ),
    refusedWith("build", /MiB of memory/),
  );
  // A file of the package keeps its own path in a message, however deep.
  await assert.rejects(
    broken('import "./lib/deep/x.ts";\nexport default 1;', { "src/lib/deep/x.ts": "const x = ;" }),
    refusedWith("build", /src\/lib\/deep\/x\.ts:1/),
  );
  assert.deepEqual(leftovers(), []);
});

/** The OS sandbox host processes run in, as the Hub builds it for a process reading `paths`. */
const hostSandbox = (paths: string[]) => {
  const root = rootFolder();
  const command = defaultSandbox("path" in root ? root.path : "", paths);
  if (!command) throw new Error("no sandbox on this platform");
  return command;
};

test("a build runs its modules' code in the OS sandbox: no socket, no TCP, no fetch even without the preload", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-describer-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A Unix socket and a TCP port the Hub's user has open, as a session bus or a local service.
  const socketPath = join(dir, "s.sock");
  // The probe drops each connection at once: a reply it never reads is no error here.
  const unix = createServer((c) => c.on("error", () => {}).end("hi"));
  await new Promise<void>((done) => unix.listen(socketPath, done));
  const tcp = createServer((c) =>
    c.on("error", () => {}).end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nhi"),
  );
  await new Promise<void>((done) => tcp.listen(0, "127.0.0.1", done));
  t.after(() => {
    unix.close();
    tcp.close();
  });
  const port = (tcp.address() as { port: number }).port;
  // Its top level tries each, with the built-ins the preload would otherwise close, and throws
  // what happened, which comes back in the build's message.
  const probe = `
const net = process.getBuiltinModule("node:net");
const tried = {};
const attempt = (name, connect) => new Promise((done) => {
  const socket = connect();
  socket.once("connect", () => { tried[name] = "open"; socket.destroy(); done(); });
  socket.once("error", (e) => { tried[name] = e.code; done(); });
  setTimeout(() => { tried[name] ??= "timeout"; done(); }, 3000);
});
await attempt("unix", () => net.connect(${JSON.stringify(socketPath)}));
await attempt("tcp", () => net.connect(${port}, "127.0.0.1"));
try { await fetch("http://127.0.0.1:${port}/"); tried.fetch = "open"; } catch (e) { tried.fetch = e.cause?.code ?? e.name; }
throw new Error("TRIED " + JSON.stringify(tried));
export default {};
`;
  const source = join(dir, "pkg");
  mkdirSync(join(source, "src"), { recursive: true });
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({
      name: "probe",
      version: "0.1.0",
      agentorg: { modules: { main: "src/main.ts" } },
    }),
  );
  writeFileSync(join(source, "src", "main.ts"), probe);
  const tried = async (sandbox?: (paths: string[]) => string[]) => {
    const error = await buildPackage(source, {
      out: join(dir, "out"),
      packages: { allowed: ["@agentorg/sdk", "@agentorg/interfaces", "zod"], from: hubFolder },
      describer: { preload: false, ...(sandbox ? { sandbox } : {}) },
    }).then(
      () => undefined,
      (e: Error) => e.message,
    );
    return JSON.parse(/TRIED (\{[^}]*\})/.exec(error ?? "")?.[1] ?? "{}") as Record<string, string>;
  };
  // Without the sandbox (and without the preload), the module reaches all three: the test can see.
  assert.deepEqual(await tried(), { unix: "open", tcp: "open", fetch: "open" });
  // In the Hub's sandbox, none.
  const inside = await tried(hostSandbox);
  for (const name of ["unix", "tcp", "fetch"])
    assert.ok(inside[name] && inside[name] !== "open", `${name}: ${inside[name]}`);
});

test("where the sandbox can't run, the Hub doesn't build either, and says why", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agentorg-build-"));
  const home = join(dir, "home");
  const hub = Hub.open(home, {
    processes: { sandbox: ["/bin/sh", "-c", "echo 'no namespaces here' >&2; exit 1", "sandbox"] },
  });
  const server = await listen(hub);
  const person = await connect({
    hubUrl: server.url,
    actorId: PERSON,
    credential: readFileSync(join(home, "person-credential"), "utf8").trim(),
    slots: { packages: hubPackages },
    declare: false,
  });
  t.after(async () => {
    person.close();
    await server.close();
    hub.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(
    person.slots.packages.call.build({ files: source() }),
    refusedWith("unsupported", /no namespaces here/),
  );
});
