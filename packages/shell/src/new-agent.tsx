import { useEffect, useRef, useState } from "react";
import { AGENT_GRANTS, installAgent } from "./agent-bindings.ts";
import { api, go } from "./data.ts";

/**
 * New agent: a name, and what it gets. The installer installs the assistant package with those
 * connections (the switched-off ones left out) and starts it, all or nothing; then it opens.
 */
export function NewAgent({ assistant, onClose }: { assistant: string; onClose(): void }) {
  const [name, setName] = useState("");
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    input.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close.current();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const create = async () => {
    const actorId = await installAgent((slot, method, input) => api.call(slot, method, input), {
      assistant,
      name: name.trim(),
      off,
    });
    onClose();
    go({ screen: "agent", agent: actorId });
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the scrim closes on a click; Escape does too.
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled on the document.
    <div className="scrim" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-agent"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim() || busy) return;
          setBusy(true);
          create().catch((error: Error) => {
            setBusy(false);
            setProblem(error.message);
          });
        }}
      >
        <h2 id="new-agent">New agent</h2>
        <input
          ref={input}
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
              <button
                type="button"
                className="toggle"
                role="switch"
                aria-checked={!off.has(grant.slot)}
                aria-label={grant.what}
                disabled={grant.fixed}
                onClick={() => {
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
        {problem && (
          <p className="quiet" role="alert">
            {problem}
          </p>
        )}
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" style={{ height: 34 }} disabled={busy}>
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
