import { Dialog, Switch } from "@agentorg/kit";
import { useState } from "react";
import { AGENT_GRANTS, installAgent } from "./agent-bindings.ts";
import { api, go } from "./data.ts";

type Grant = (typeof AGENT_GRANTS)[number];
/** A grant off: switched off, or one it needs is. */
const isOff = (grant: Grant, off: ReadonlySet<string>) =>
  off.has(grant.slot) || ("needs" in grant && off.has(grant.needs));

/** The installer's refusal, plainly: the grants it named as the person's not to give, if any. */
function refusal(error: Error & { code?: string }): string {
  const beyond =
    error.code === "forbidden"
      ? AGENT_GRANTS.filter((grant) => error.message.includes(`logic.${grant.slot} → `))
      : [];
  if (!beyond.length) return error.message;
  const one = beyond.length === 1;
  return `You can't give it ${beyond.map((grant) => grant.what).join(", ")}: ${one ? "it isn't" : "they aren't"} yours to grant. Switch ${one ? "it" : "them"} off.`;
}

interface Made {
  actorId: string;
  name: string;
  /** Grants left on that weren't connected. */
  unbound: string[];
  unseeded: string[];
}

/**
 * New agent: a name, and what it gets. The installer installs the assistant package with those
 * connections (the switched-off ones left out) and starts it, all or nothing; then it opens. A
 * grant left on that the installer didn't connect, or a seed that didn't land, is said first.
 */
export function NewAgent({ assistant, onClose }: { assistant: string; onClose(): void }) {
  const [name, setName] = useState("");
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [made, setMade] = useState<Made>();

  const open = (actorId: string) => {
    onClose();
    go({ screen: "agent", agent: actorId });
  };
  const create = async () => {
    const left = new Set(AGENT_GRANTS.filter((grant) => isOff(grant, off)).map((g) => g.slot));
    const answer = await installAgent((slot, method, input) => api.call(slot, method, input), {
      assistant,
      name: name.trim(),
      off: left,
    });
    // The grants it was given that weren't connected; what was switched off is meant to stay so.
    const unbound = AGENT_GRANTS.filter((grant) => !left.has(grant.slot))
      .map((grant) => `logic.${grant.slot}`)
      .filter((slot) => answer.unbound.includes(slot));
    if (!unbound.length && !answer.unseeded.length) return open(answer.actorId);
    setMade({ actorId: answer.actorId, name: name.trim(), unbound, unseeded: answer.unseeded });
  };

  // The kit's dialog: it takes focus (the name, first), and Escape or a click outside closes it.
  return made ? (
    <Dialog title="New agent" onClose={onClose}>
      <div className="bar-row">
        <span className="done-mark">✓</span>
        <span>
          <b>{made.name}</b> is created and running.
        </span>
      </div>
      {made.unbound.length > 0 && (
        <div>
          <div className="group-head">Not connected</div>
          <ul className="list">
            {made.unbound.map((slot) => (
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
      {made.unseeded.length > 0 && (
        <div>
          <div className="group-head">Starts empty</div>
          <ul className="list">
            {made.unseeded.map((slot) => (
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
      <div className="actions">
        <button
          type="button"
          className="primary"
          style={{ height: 34 }}
          onClick={() => open(made.actorId)}
        >
          Open
        </button>
      </div>
    </Dialog>
  ) : (
    <Dialog
      title="New agent"
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim() || busy) return;
        setBusy(true);
        setProblem(undefined);
        create().catch((error: Error) => {
          setBusy(false);
          setProblem(refusal(error));
        });
      }}
    >
      <input
        className="field"
        aria-label="Name"
        placeholder="Name"
        required
        maxLength={128}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <ul className="grants">
        {AGENT_GRANTS.map((grant) => (
          <li key={grant.slot}>
            <Switch
              checked={!isOff(grant, off)}
              label={grant.what}
              // One it needs is off: so is this, until that one is back on.
              disabled={grant.fixed || ("needs" in grant && off.has(grant.needs))}
              onChange={() => {
                const next = new Set(off);
                if (!next.delete(grant.slot)) next.add(grant.slot);
                setOff(next);
              }}
            />
            <span>{grant.what}</span>
            <span className="mono">{grant.iface}</span>
          </li>
        ))}
      </ul>
      {/* Its room kept, so the buttons stay put when it says something. */}
      <p className="err-line" role="alert">
        {problem}
      </p>
      <div className="actions">
        <button type="button" className="ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="primary" style={{ height: 34 }} disabled={busy}>
          Create
        </button>
      </div>
    </Dialog>
  );
}
