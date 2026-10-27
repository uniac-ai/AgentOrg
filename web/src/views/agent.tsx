// An agent's pane: who it is and where its work stands.

import { ExternalLinkIcon, OctagonAlertIcon } from "lucide-react";
import type { AgentModel } from "../control/agent.tsx";
import { SR, StateMark, StateName } from "./marks.tsx";
import { Ago } from "./time.tsx";

const isWebLink = (url: string) => /^https?:\/\//i.test(url);

export function AgentView({ detail }: AgentModel) {
  const { agent } = detail;
  const status = agent.status;
  return (
    <article
      aria-labelledby="agent-title"
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-6"
    >
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <StateMark agent={agent} />
          <h1 id="agent-title" className="truncate text-xl font-semibold tracking-tight">
            {agent.title}
          </h1>
          <StateName agent={agent} />
          {status ? (
            <Ago
              at={status.updated_at}
              className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums"
            />
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">{agent.purpose}</p>
      </header>
      {status?.summary ? <p className="whitespace-pre-wrap">{status.summary}</p> : null}
      {status && status.blockers.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {status.blockers.map((blocker) => (
            <li key={blocker} className="flex items-center gap-2 text-sm text-state-blocked">
              <OctagonAlertIcon aria-hidden="true" className="size-4 shrink-0" />
              <SR>Blocked on</SR>
              {blocker}
            </li>
          ))}
        </ul>
      ) : null}
      {status && status.links.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {status.links.map((link) => (
            <li key={`${link.label}-${link.url}`}>
              {isWebLink(link.url) ? (
                <a
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-sm hover:bg-muted"
                >
                  {link.label}
                  <ExternalLinkIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                </a>
              ) : (
                <span
                  className="inline-flex rounded-md border px-2 py-1 text-sm text-muted-foreground"
                  title={link.url}
                >
                  {link.label}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}
