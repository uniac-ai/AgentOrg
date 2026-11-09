import { LoaderCircleIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { api, useLoad } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { ConnectDialog } from "./connect.tsx";
import {
  type ConnectionEntry,
  listConnections,
  listDetails,
  listMcpProviders,
  REFRESH_MS,
  useEvery,
} from "./data.ts";
import { DeleteButton } from "./delete-dialog.tsx";
import { Nothing, rowClass, Scroll, StateDot, UsedBy, WhereIcon } from "./parts.tsx";
import { SettingsFrame } from "./settings-page.tsx";

/** Each connection with how many tools it offers; a server's state has no event, so it's reread. */
const readConnections = async () => {
  const connections = await listConnections();
  return Promise.all(
    connections.map(async (entry) => ({
      entry,
      tools: await api
        .call<{ status: { tools: unknown[] } }>("connections", "get", {
          connection: entry.connection,
        })
        .then(
          (reply) => reply.status.tools.length,
          () => undefined,
        ),
    })),
  );
};

export function McpsPage({ focus, adding }: { focus?: string; adding?: boolean }) {
  const tick = useEvery(REFRESH_MS);
  const [changed, setChanged] = useState(0);
  const list = useLoad(readConnections, ["actors", "bindings"], [tick, changed]);
  const details = useLoad(listDetails, ["actors", "bindings"], [changed]).value ?? [];
  const providers = useLoad(listMcpProviders, ["actors"]).value ?? [];
  const [open, setOpen] = useState(!!adding);
  useEffect(() => setOpen(!!adding), [adding]);
  const rows = list.value ?? [];
  const using = (connection: string) =>
    details.filter((a) => a.mcp.some((m) => m.connection === connection));

  const originOf = ({ origin }: ConnectionEntry) => {
    if (!origin) return "";
    if (!origin.madeFor) return "Connected by you";
    const agent = details.find((a) => a.agent === origin.madeFor)?.name ?? "an agent";
    const provider = providers.find((p) => p.provider === origin.provider)?.name;
    return `Created for ${agent}${provider ? ` by ${provider}` : ""}`;
  };

  return (
    <SettingsFrame
      tab="mcps"
      action={
        <Button size="sm" onClick={() => setOpen(true)}>
          <PlusIcon />
          Connect
        </Button>
      }
    >
      <Scroll>
        <ul className="mx-auto max-w-5xl">
          {rows.map(({ entry, tools }) => (
            <li
              key={entry.connection}
              className={`${rowClass(focus === entry.connection)} grid-cols-[minmax(0,1.1fr)_minmax(0,1.3fr)_minmax(0,1fr)_72px_24px] tight:grid-cols-[minmax(0,1fr)_auto]`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 font-medium">
                  <span className="truncate">{entry.name}</span>
                  {entry.state === "down" && <StateDot tone="trouble" />}
                </div>
                <div className="truncate text-[13px] text-muted-foreground">{originOf(entry)}</div>
              </div>
              <span className="flex min-w-0 items-center gap-2 tight:col-span-2 tight:row-start-2">
                {entry.origin && <WhereIcon kind={entry.origin.kind} />}
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {entry.origin?.target}
                </span>
              </span>
              <span className="flex min-w-0 tight:col-span-2 tight:row-start-3">
                <UsedBy agents={using(entry.connection)} />
              </span>
              <span className="flex justify-end text-xs tabular-nums text-muted-foreground tight:col-start-2 tight:row-start-1">
                {entry.state === "connecting" ? (
                  <LoaderCircleIcon
                    role="img"
                    aria-label="Connecting"
                    className="size-4 animate-spin motion-reduce:animate-none"
                  />
                ) : entry.state === "down" ? (
                  <span className="text-[var(--bad)]">Down</span>
                ) : (
                  tools !== undefined && `${tools} ${tools === 1 ? "tool" : "tools"}`
                )}
              </span>
              <span className="flex justify-end tight:col-start-2 tight:row-start-3">
                <DeleteButton
                  name={entry.name}
                  agents={using(entry.connection).map((a) => a.name)}
                  onDelete={() =>
                    api.call("connections", "remove", { connection: entry.connection })
                  }
                  onDeleted={() => setChanged((was) => was + 1)}
                />
              </span>
            </li>
          ))}
          {list.loaded && rows.length === 0 && (
            <li>
              <Nothing>
                {list.error ? "Connections can't be read right now." : "No connections yet."}
              </Nothing>
            </li>
          )}
        </ul>
      </Scroll>
      <ConnectDialog
        open={open}
        onClose={() => setOpen(false)}
        onConnected={() => {
          setOpen(false);
          setChanged((was) => was + 1);
        }}
      />
    </SettingsFrame>
  );
}
