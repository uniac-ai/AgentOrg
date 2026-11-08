import { DownloadIcon, Tabs, UploadIcon } from "@agentorg/kit";
import { useRef, useState } from "react";
import type { LoginStatus } from "./app.tsx";
import {
  type Actor,
  api,
  type Binding,
  manifestOf,
  type Package,
  type Topic,
  useAction,
  useLoad,
} from "./data.ts";
import { Install } from "./install.tsx";
import { signIn, useSigningIn } from "./sign-in.ts";
import { System, save } from "./system.tsx";

const TABS = ["actors", "packages", "connections", "system"] as const;
/** The person's own Actor, shown as "you". */
const PERSON = "person";
type Tab = (typeof TABS)[number];

const read =
  <T,>(slot: string, key: string) =>
  () =>
    api.call<Record<string, T[]>>(slot, "list").then((reply) => reply[key] ?? []);
const short = (hash: string) => `${hash.slice(0, 11)}…${hash.slice(-4)}`;

/** Settings: the ChatGPT account, then everything the person holds, read through `hub.*`. */
export function Settings({ login }: { login?: LoginStatus }) {
  const [tab, setTab] = useState<Tab>("actors");
  return (
    <div className="settings">
      {login && <Account login={login} />}
      <Tabs<Tab>
        className="kit-fill"
        label="Settings"
        tabs={TABS.map((name) => [name, name[0]?.toUpperCase() + name.slice(1)] as const)}
        value={tab}
        onChange={setTab}
      >
        {tab === "actors" && <Actors />}
        {tab === "packages" && <Packages />}
        {tab === "connections" && <Connections />}
        {tab === "system" && <System />}
      </Tabs>
    </div>
  );
}

/** The person's binding to the model's `login`: who's signed in, and the way out or in. */
function Account({ login }: { login: LoginStatus }) {
  const signingIn = useSigningIn();
  const signedIn = login.state === "signed_in";
  const { busy, failed, run } = useAction();
  if (login.state === "ineligible")
    return (
      <div className="account">
        <div className="who">
          <b>ChatGPT</b> <span className="mono">This ChatGPT plan isn't eligible.</span>
        </div>
      </div>
    );
  return (
    <div className="account">
      <div className="who">
        <b>ChatGPT</b>{" "}
        <span className="mono" role={failed ? "alert" : undefined}>
          {failed
            ? "That didn't work. Try again."
            : signedIn
              ? (login.account?.plan ?? "signed in")
              : "signed out"}
        </span>
      </div>
      {signedIn ? (
        <button
          type="button"
          className="ghost small"
          disabled={busy}
          onClick={() => run(() => api.call("login", "logout"))}
        >
          Sign out
        </button>
      ) : (
        <button
          type="button"
          className="primary small"
          disabled={signingIn || busy}
          onClick={() => run(signIn)}
        >
          {signingIn ? "Waiting for ChatGPT…" : "Continue with ChatGPT"}
        </button>
      )}
    </div>
  );
}

function useNames() {
  const actors = (useLoad(read<Actor>("actors", "actors"), ["actors"]).value ?? []).map((actor) =>
    actor.actorId === PERSON ? { ...actor, name: "you" } : actor,
  );
  const packages = useLoad(read<Package>("packages", "packages"), ["packages"]).value ?? [];
  return { actors, packages };
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <table>
      <thead>
        <tr>
          {head.map((name, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: columns are fixed.
            <th key={i}>{name}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((cells, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are read whole each time.
          <tr key={i}>{cells}</tr>
        ))}
      </tbody>
    </table>
  );
}

function Actors() {
  const { actors, packages } = useNames();
  return (
    <Table
      head={["Actor", "Package", "State", "Restarts"]}
      rows={actors
        .filter((actor) => actor.state !== "closed")
        .map((actor) => {
          const own = actor.package !== "builtin" && actor.package !== "external";
          const pkg = own
            ? (packages.find((p) => p.hash === actor.package)?.name ?? short(actor.package))
            : actor.actorId === PERSON
              ? "person"
              : actor.package === "builtin"
                ? "built in"
                : "external";
          // An external Actor, the person included, has no process: whether it's connected is its
          // state. A built-in one runs inside the Hub, with no channel of its own.
          const external = actor.package === "external";
          const state = external ? (actor.connected ? "connected" : "not connected") : actor.state;
          const live = external ? actor.connected : actor.state === "running";
          return [
            <td key="n">{actor.name}</td>,
            <td key="p" className="mono">
              {pkg}
            </td>,
            <td key="s">
              <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                <span className={`glyph${live ? "" : " idle"}`} />
                {state}
              </span>
            </td>,
            <td key="r" className="mono">
              {own ? actor.restarts : "–"}
            </td>,
          ];
        })}
    />
  );
}

function Packages() {
  const { actors, packages } = useNames();
  const [file, setFile] = useState<File>();
  const picker = useRef<HTMLInputElement>(null);
  const [failed, setFailed] = useState<string>();
  const topics: Topic[] = ["packages"];
  const modules =
    useLoad(
      () =>
        Promise.all(
          packages.map(async (p) => [p.hash, Object.keys((await manifestOf(p.hash)).modules)]),
        ).then((entries) => new Map(entries as [string, string[]][])),
      topics,
      [packages.map((p) => p.hash).join()],
    ).value ?? new Map<string, string[]>();
  return (
    <>
      <div className="bar-row" style={{ marginBottom: 8 }}>
        <span className="grow" role="alert">
          {failed && <span className="err-line">{failed} wasn't downloaded. Try again.</span>}
        </span>
        <input
          ref={picker}
          type="file"
          accept=".agentorg"
          hidden
          aria-label="Package file"
          onChange={(event) => {
            const picked = event.target.files?.[0];
            event.target.value = "";
            if (picked) setFile(picked);
          }}
        />
        <button type="button" className="ghost small" onClick={() => picker.current?.click()}>
          <UploadIcon />
          Install from a file
        </button>
      </div>
      <Table
        head={["Package", "Version", "Hash", "Modules", ""]}
        rows={packages.map((p) => [
          <td key="n">{p.name}</td>,
          <td key="v" className="mono">
            {p.version}
          </td>,
          <td key="h" className="mono" title={p.hash}>
            {short(p.hash)}
          </td>,
          <td key="m" className="mono">
            {(modules.get(p.hash) ?? []).join(", ")}
          </td>,
          <td key="d" style={{ width: 40 }}>
            <button
              type="button"
              className="icon-link"
              aria-label={`Download ${p.name}`}
              title="Download"
              onClick={() => {
                setFailed(undefined);
                save(`/packages/${p.hash}.agentorg`).catch(() => setFailed(p.name));
              }}
            >
              <DownloadIcon />
            </button>
          </td>,
        ])}
      />
      {file && <Install file={file} actors={actors} onClose={() => setFile(undefined)} />}
    </>
  );
}

function Connections() {
  const { actors } = useNames();
  const bindings = useLoad(read<Binding>("bindings", "bindings"), ["bindings"]).value ?? [];
  const name = (id: string) => actors.find((a) => a.actorId === id)?.name ?? id;
  return (
    <Table
      head={["Slot", "", "Served by", "Interface"]}
      rows={bindings.map((b) => [
        <td key="c" className="mono" style={{ color: "var(--fg)" }}>
          {name(b.consumer)}.{b.slot}
        </td>,
        <td key="a" className="mono">
          →
        </td>,
        <td key="p" className="mono" style={{ color: "var(--fg)" }}>
          {name(b.provider)}.{b.export}
        </td>,
        <td key="i" className="mono">
          {b.interface}
        </td>,
      ])}
    />
  );
}
