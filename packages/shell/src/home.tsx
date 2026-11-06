import type { ReactNode } from "react";
import { Avatar } from "./app.tsx";
import { type Actor, api, type BindingRequest, go, useAction, useLoad } from "./data.ts";
import { MoreIcon } from "./icons.tsx";
import type { Placement } from "./rules.ts";
import { ViewFrame } from "./view-frame.tsx";

const nameOf = (actors: Actor[], id: string) => actors.find((a) => a.actorId === id)?.name ?? id;
/** The quiet line a control's failed call leaves. */
const FAILED = "That didn't work. Try again.";

/** Home: what waits on the person, then every placed view, in the layout's order. */
export function Home({
  requests,
  home,
  actors,
  placed,
}: {
  requests: BindingRequest[];
  home: Placement[];
  actors: Actor[];
  placed: (placement: Placement, kind: "placed", shown: Placement[]) => ReactNode;
}) {
  const exports =
    useLoad(
      () =>
        api
          .call<{ exports: { actor: string; export: string; interface: string }[] }>(
            "exports",
            "list",
          )
          .then((reply) => reply.exports),
      ["grants"],
    ).value ?? [];
  return (
    <div className="home scroll" style={{ flex: 1, minHeight: 0 }}>
      {requests.map((request) => {
        const from = nameOf(actors, request.requestedBy);
        const iface = exports.find(
          (e) => e.actor === request.provider && e.export === request.export,
        )?.interface;
        return (
          <Request
            key={request.requestId}
            request={request}
            from={from}
            to={`${request.slot} → ${nameOf(actors, request.provider)}${iface ? ` · ${iface}` : ""}`}
          />
        );
      })}
      {!home.length && (
        <div className="home-empty" style={{ gridColumn: "1/-1" }}>
          Ask an agent to place something here.
        </div>
      )}
      {home.map((placement) => placed(placement, "placed", home))}
    </div>
  );
}

/** A grant request: who asks, for what, and the person's Allow or Decline. */
function Request({ request, from, to }: { request: BindingRequest; from: string; to: string }) {
  const { busy, failed, run } = useAction();
  const wiring = {
    consumer: request.consumer,
    slot: request.slot,
    provider: request.provider,
    export: request.export,
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a card of its own, not a form's fieldset.
    <div className="request" role="group" aria-label={`Request from ${from}`}>
      <Avatar actor={request.requestedBy} name={from} />
      <div className="what">
        <b>{from}</b> {request.reason || "asks to connect"}
        <div className="mono" role={failed ? "alert" : undefined}>
          {failed ? FAILED : to}
        </div>
      </div>
      <button
        type="button"
        className="ghost small"
        disabled={busy}
        onClick={() => run(() => api.call("grants", "decline", { requestId: request.requestId }))}
      >
        Decline
      </button>
      <button
        type="button"
        className="primary small"
        disabled={busy}
        onClick={() => run(() => api.call("grants", "bind", wiring))}
      >
        Allow
      </button>
    </div>
  );
}

/**
 * A placed view: the shell's header (its title, and on home whose it is), its menu, then the
 * view's own frame. On home it's a card; beside an agent, a container. `shown` is the list it is
 * shown in, home's or the one beside an agent, which Move up moves it within.
 */
export function PlacedView({
  placement,
  kind,
  home,
  shown,
  actors,
  agents,
  menuOpen,
  onMenu,
}: {
  placement: Placement;
  kind: "placed" | "container";
  home: Placement[];
  shown: Placement[];
  actors: Actor[];
  agents: Actor[];
  menuOpen: boolean;
  onMenu(): void;
}) {
  const actor = actors.find((a) => a.actorId === placement.actor);
  // Until the Actors are read, no name rather than an id.
  const name = actor?.name ?? "";
  const title = placement.title ?? placement.module;
  // Whose it is: the agent that placed it, else the agent whose view it is.
  const agent =
    agents.find((a) => a.actorId === placement.by) ??
    agents.find((a) => a.actorId === placement.actor);
  const hash =
    actor && actor.package !== "external" && actor.package !== "builtin" ? actor.package : "";
  /** Before the one shown above it: after whatever precedes that one in the whole layout. */
  const moveUp = async () => {
    const above = shown[shown.findIndex((p) => p.id === placement.id) - 1];
    if (!above) return;
    const after = home[home.findIndex((p) => p.id === above.id) - 1]?.id;
    await api.call("layout", "move", { id: placement.id, ...(after ? { after } : {}) });
  };
  return (
    <section className={kind} aria-label={title} style={{ position: "relative" }}>
      <div className="view-head">
        {title}
        {kind === "placed" && (agent?.name ?? name) && (
          <span className="who">· {agent?.name ?? name}</span>
        )}
        <button
          type="button"
          className="icon-btn"
          data-menu
          aria-label={`${title} options`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={onMenu}
        >
          <MoreIcon />
        </button>
      </div>
      {menuOpen && (
        <Menu
          open={kind === "placed" ? agent : undefined}
          close={onMenu}
          moveUp={moveUp}
          remove={() => api.call("layout", "remove", { id: placement.id })}
        />
      )}
      <div className="view-body">
        {hash ? (
          <ViewFrame actor={placement.actor} module={placement.module} hash={hash} />
        ) : (
          actors.length > 0 && <div className="view-error">This view didn't load.</div>
        )}
      </div>
    </section>
  );
}

/** A placed view's menu. It stays open while its call runs, and says so if it fails. */
function Menu({
  open,
  close,
  moveUp,
  remove,
}: {
  open?: Actor;
  close(): void;
  moveUp(): Promise<unknown>;
  remove(): Promise<unknown>;
}) {
  const { busy, failed, run } = useAction();
  return (
    <div className="menu" role="menu">
      {open && (
        <button
          type="button"
          role="menuitem"
          onClick={() => go({ screen: "agent", agent: open.actorId })}
        >
          Open {open.name}
        </button>
      )}
      <button type="button" role="menuitem" disabled={busy} onClick={() => run(moveUp, close)}>
        Move up
      </button>
      <button type="button" role="menuitem" disabled={busy} onClick={() => run(remove, close)}>
        Remove
      </button>
      {failed && (
        <p className="quiet menu-note" role="alert">
          {FAILED}
        </p>
      )}
    </div>
  );
}
