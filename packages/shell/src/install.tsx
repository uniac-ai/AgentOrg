import { useEffect, useRef, useState } from "react";
import { transfer } from "./api.ts";
import { type Actor, api, go } from "./data.ts";

type Target = { actor: string; export: string };
interface Plan {
  slots: { slot: string; interface: string; candidates: Target[] }[];
  views: string[];
}
interface Added {
  hash: string;
  manifest: { name: string; version: string; description?: string };
}
interface Installed {
  actorId: string;
  name: string;
  started: boolean;
  unbound: string[];
  unseeded: string[];
  views: string[];
}

const short = (hash: string) => `${hash.slice(0, 11)}…${hash.slice(-4)}`;
const key = (target: Target) => `${target.actor}\0${target.export}`;
const title = (name: string) => (name ? name[0]?.toUpperCase() + name.slice(1) : name);

/**
 * Install a package from a file: it's uploaded to `POST /packages` (the Hub verifies it), then
 * `installer.plan` proposes each slot's candidates. The person picks (a slot's only candidate is
 * preselected), and `installer.install` makes it, all or nothing. Then its views can be placed.
 */
export function Install({
  file,
  actors,
  onClose,
}: {
  file: File;
  actors: Actor[];
  onClose(): void;
}) {
  const [added, setAdded] = useState<{ added: Added; plan: Plan }>();
  const [problem, setProblem] = useState<string>();
  const [installed, setInstalled] = useState<Installed>();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close.current();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    let live = true;
    (async () => {
      const added = (await (await transfer("/packages", file)).json()) as Added;
      const plan = await api.call<Plan>("installer", "plan", { package: added.hash });
      if (live) setAdded({ added, plan });
    })().catch((error: Error) => live && setProblem(error.message));
    return () => {
      live = false;
    };
  }, [file]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the scrim closes on a click; Escape does too.
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled on the document.
    <div className="scrim" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="install">
        <h2 id="install">Install a package</h2>
        {installed ? (
          <Place installed={installed} onClose={onClose} />
        ) : added ? (
          <Choose
            added={added.added}
            plan={added.plan}
            actors={actors}
            onClose={onClose}
            onInstalled={setInstalled}
          />
        ) : problem ? (
          <>
            <p className="err-line" role="alert">
              {file.name} wasn't installed: {problem}
            </p>
            <div className="actions">
              <button type="button" className="ghost" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <div className="bar-row checking">
            <span className="spin" aria-hidden="true" /> Checking {file.name}…
          </div>
        )}
      </div>
    </div>
  );
}

/** The package, its name here, and each slot's connection; refusals said in place. */
function Choose({
  added,
  plan,
  actors,
  onClose,
  onInstalled,
}: {
  added: Added;
  plan: Plan;
  actors: Actor[];
  onClose(): void;
  onInstalled(installed: Installed): void;
}) {
  const { manifest } = added;
  const [name, setName] = useState(title(manifest.name));
  const [start, setStart] = useState(true);
  // Each slot's pick, by its candidate's key; a slot's only candidate is preselected.
  const [picks, setPicks] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      plan.slots.flatMap(({ slot, candidates }) =>
        candidates.length === 1 && candidates[0] ? [[slot, key(candidates[0])]] : [],
      ),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const nameOf = (id: string) => actors.find((a) => a.actorId === id)?.name ?? id;

  const install = async () => {
    const connections: Record<string, Target> = {};
    for (const { slot, candidates } of plan.slots) {
      const target = candidates.find((candidate) => key(candidate) === picks[slot]);
      if (target) connections[slot] = target;
    }
    try {
      const { actorId, unbound, unseeded } = await api.call<{
        actorId: string;
        unbound: string[];
        unseeded: string[];
      }>("installer", "install", { package: added.hash, name: name.trim(), connections, start });
      onInstalled({
        actorId,
        name: name.trim(),
        started: start,
        unbound,
        unseeded,
        views: plan.views,
      });
    } catch (error) {
      const refused = error as Error & { code?: string };
      // The installer grants nothing the person couldn't; it names each connection it refused.
      const beyond =
        refused.code === "forbidden"
          ? Object.entries(connections).filter(([slot]) => refused.message.includes(`${slot} → `))
          : [];
      setProblem(
        beyond.length
          ? `You can't connect ${beyond
              .map(([slot, t]) => `${slot} → ${nameOf(t.actor)} · ${t.export}`)
              .join(
                ", ",
              )}: ${beyond.length === 1 ? "it isn't" : "they aren't"} yours to grant. Leave ${beyond.length === 1 ? "it" : "them"} unconnected.`
          : refused.message,
      );
      setBusy(false);
    }
  };

  return (
    <form
      className="steps"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim() || busy) return;
        setBusy(true);
        setProblem(undefined);
        void install();
      }}
    >
      <div>
        <div className="pkg-head">
          <b>{manifest.name}</b>
          <span className="mono">{manifest.version}</span>
        </div>
        <div className="mono" style={{ marginTop: 2 }} title={added.hash}>
          {short(added.hash)}
        </div>
        {manifest.description && (
          <div className="quiet" style={{ textAlign: "left", marginTop: 6 }}>
            {manifest.description}
          </div>
        )}
      </div>
      <input
        className="field"
        aria-label="Name"
        required
        maxLength={128}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      {plan.slots.length > 0 && (
        <div>
          {plan.slots.map(({ slot, interface: iface, candidates }) => (
            <div className="slot-row" key={slot}>
              <div>
                <div className="mono" style={{ color: "var(--fg)" }}>
                  {slot}
                </div>
                <div className="mono">{iface}</div>
              </div>
              {candidates.length ? (
                <select
                  aria-label={slot}
                  value={picks[slot] ?? ""}
                  onChange={(event) => setPicks({ ...picks, [slot]: event.target.value })}
                >
                  <option value="">Not connected</option>
                  {candidates.map((candidate) => (
                    <option key={key(candidate)} value={key(candidate)}>
                      {nameOf(candidate.actor)} · {candidate.export}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="none">Nothing offers this yet</span>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="bar-row" style={{ fontSize: 13 }}>
        <button
          type="button"
          className="toggle"
          role="switch"
          aria-checked={start}
          aria-label="Start it"
          onClick={() => setStart(!start)}
        />
        Start it
      </div>
      <p className="err-line" role="alert">
        {problem}
      </p>
      <div className="actions">
        <button type="button" className="ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="primary" style={{ height: 34 }} disabled={busy}>
          Install
        </button>
      </div>
    </form>
  );
}

/** Installed: what was left unconnected or unseeded, and its views to place on home. */
function Place({ installed, onClose }: { installed: Installed; onClose(): void }) {
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const place = async () => {
    try {
      for (const module of installed.views)
        if (!off.has(module))
          await api.call("layout", "place", {
            actor: installed.actorId,
            module,
            title: installed.views.length === 1 ? installed.name : `${installed.name} ${module}`,
          });
      onClose();
      go({ screen: "home" });
    } catch (error) {
      setProblem((error as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="steps">
      <div className="bar-row">
        <span className="done-mark">✓</span>
        <span>
          <b>{installed.name}</b>{" "}
          {installed.started ? "is installed and running." : "is installed."}
        </span>
      </div>
      {installed.unbound.length > 0 && (
        <div>
          <div className="group-head">Not connected</div>
          <ul className="list">
            {installed.unbound.map((slot) => (
              <li key={slot}>
                <span className="mono" style={{ color: "var(--fg)" }}>
                  {slot}
                </span>
                <span className="why">connect it later in Connections</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {installed.unseeded.length > 0 && (
        <div>
          <div className="group-head">Starts empty</div>
          <ul className="list">
            {installed.unseeded.map((slot) => (
              <li key={slot}>
                <span className="mono" style={{ color: "var(--fg)" }}>
                  {slot}
                </span>
                <span className="why">its store isn't connected, so its seed didn't land</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {installed.views.length > 0 ? (
        <>
          <div>
            <div className="group-head">Place its views</div>
            <ul className="list">
              {installed.views.map((module) => (
                <li key={module}>
                  <button
                    type="button"
                    className="toggle"
                    role="switch"
                    aria-checked={!off.has(module)}
                    aria-label={`Place ${module}`}
                    onClick={() => {
                      const next = new Set(off);
                      if (!next.delete(module)) next.add(module);
                      setOff(next);
                    }}
                  />
                  <span>{module}</span>
                  <span className="why">on your home</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="err-line" role="alert">
            {problem}
          </p>
          <div className="actions">
            <button type="button" className="ghost" onClick={onClose}>
              Not now
            </button>
            <button
              type="button"
              className="primary"
              style={{ height: 34 }}
              disabled={busy || off.size === installed.views.length}
              onClick={() => {
                setBusy(true);
                setProblem(undefined);
                void place();
              }}
            >
              Place
            </button>
          </div>
        </>
      ) : (
        <div className="actions">
          <button type="button" className="primary" style={{ height: 34 }} onClick={onClose}>
            Done
          </button>
        </div>
      )}
    </div>
  );
}
