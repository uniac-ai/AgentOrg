import { useRef, useState } from "react";
import { transfer } from "./api.ts";
import { api } from "./data.ts";

type Unresolved = { what: string; why: string }[];
type Connection = { consumer: string; slot: string; provider: string; export: string };
interface Exported {
  file: string;
  actors: number;
  packages: number;
  unresolved: Unresolved;
}
interface Imported {
  created: Record<string, string>;
  unresolved: Unresolved;
  ungranted: Connection[];
}

/** Save a gateway file under the name it gives, from the click that asked for it. */
export async function save(path: string): Promise<string> {
  const response = await transfer(path);
  const name =
    /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? "download";
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // The link has started its download; the bytes can go once it has read them.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return name;
}

const and = (names: string[]) =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * Settings → System: export the system as one `.agentorg-system` file (the composition and every
 * package it pins), or import one. What either can't carry is listed, never guessed; an import's
 * management connections are the person's to grant, one by one.
 */
export function System() {
  const [exported, setExported] = useState<Exported>();
  const [imported, setImported] = useState<Imported>();
  const [granted, setGranted] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState<"export" | "import">();
  const [problem, setProblem] = useState<{ on: "export" | "import"; message: string }>();
  const picker = useRef<HTMLInputElement>(null);

  const run = (on: "export" | "import", work: () => Promise<void>) => {
    setBusy(on);
    setProblem(undefined);
    work()
      .catch((error: Error) => setProblem({ on, message: error.message }))
      .finally(() => setBusy(undefined));
  };
  const exportSystem = () =>
    run("export", async () => {
      // What it leaves out, then the file itself, which the gateway packs from the same export.
      const { composition, unresolved } = await api.call<{
        composition: { actors: Record<string, { package: string }> };
        unresolved: Unresolved;
      }>("installer", "exportSystem");
      const file = await save("/system");
      const pinned = Object.values(composition.actors).map((actor) => actor.package);
      setExported({
        file,
        actors: pinned.length,
        packages: new Set(pinned).size,
        unresolved,
      });
    });
  const importSystem = (file: File) =>
    run("import", async () => {
      setImported(undefined);
      setGranted(new Set());
      setImported((await (await transfer("/system", file)).json()) as Imported);
    });
  /** An Actor of the import by its name here: one it made, else a built-in, named by its id. */
  const idOf = (name: string) => imported?.created[name] ?? name;

  return (
    <div className="blocks">
      <section className="block" aria-label="Export">
        <div className="line">
          <span className="grow">
            Your agents, programs, connections and home, with every package they run. Never your
            sign-ins, tokens or stored data.
          </span>
          <button
            type="button"
            className="primary small"
            disabled={busy !== undefined}
            onClick={exportSystem}
          >
            Export system
          </button>
        </div>
        {problem?.on === "export" && (
          <p className="err-line" role="alert">
            The system wasn't exported: {problem.message}
          </p>
        )}
        {exported && (
          <div>
            <div className="bar-row" style={{ fontSize: 13 }}>
              <span className="done-mark">✓</span>Saved {exported.file} · {exported.actors}{" "}
              {exported.actors === 1 ? "Actor" : "Actors"}, {exported.packages}{" "}
              {exported.packages === 1 ? "package" : "packages"}
            </div>
            {exported.unresolved.length > 0 && (
              <>
                <div className="group-head" style={{ marginTop: 8 }}>
                  Left out
                </div>
                <ul className="list">
                  {exported.unresolved.map(({ what, why }) => (
                    <li key={what}>
                      <span>{what}</span>
                      <span className="why">{why}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </section>
      <section className="block" aria-label="Import">
        <div className="line">
          <span className="grow">A system someone shared: an .agentorg-system file.</span>
          <input
            ref={picker}
            type="file"
            accept=".agentorg-system"
            hidden
            aria-label="System file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) importSystem(file);
            }}
          />
          <button
            type="button"
            className="ghost small"
            disabled={busy !== undefined}
            onClick={() => picker.current?.click()}
          >
            Import a system
          </button>
        </div>
        {problem?.on === "import" && (
          <p className="err-line" role="alert">
            The system wasn't imported: {problem.message}
          </p>
        )}
        {imported && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="bar-row" style={{ fontSize: 13 }}>
              <span className="done-mark">✓</span>
              {Object.keys(imported.created).length
                ? `Made ${and(Object.keys(imported.created))}`
                : "Nothing new to make"}
            </div>
            {imported.unresolved.length > 0 && (
              <div>
                <div className="group-head">Not as it was</div>
                <ul className="list">
                  {imported.unresolved.map(({ what, why }) => (
                    <li key={what}>
                      <span>{what}</span>
                      <span className="why">{why}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {imported.ungranted.length > 0 && (
              <div>
                <div className="group-head">Needs your grant</div>
                <ul className="list">
                  {imported.ungranted.map((c, i) => (
                    <li key={`${c.consumer}.${c.slot}`}>
                      <span className="mono" style={{ color: "var(--fg)" }}>
                        {c.consumer}.{c.slot} → {c.provider}.{c.export}
                      </span>
                      <span className="why">
                        {granted.has(i) ? (
                          // In the button's box, so nothing beside it moves.
                          <span className="ghost small done-mark granted">Granted</span>
                        ) : (
                          <Grant
                            onGrant={() =>
                              api
                                .call("grants", "bind", {
                                  consumer: idOf(c.consumer),
                                  slot: c.slot,
                                  provider: idOf(c.provider),
                                  export: c.export,
                                })
                                .then(() => setGranted((done) => new Set(done).add(i)))
                            }
                          />
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

/** One grant's button: it says so in place if the grant fails. */
function Grant({ onGrant }: { onGrant(): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      className="ghost small"
      disabled={busy}
      aria-label={failed ? "Grant failed. Try again." : undefined}
      onClick={() => {
        setBusy(true);
        setFailed(false);
        onGrant().catch(() => {
          setFailed(true);
          setBusy(false);
        });
      }}
    >
      {failed ? "Try again" : "Grant"}
    </button>
  );
}
