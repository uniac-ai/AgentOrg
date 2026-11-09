// The small pieces the fixed pages share.
import { GlobeIcon, LaptopIcon, LoaderCircleIcon } from "lucide-react";
import { Fragment } from "react";
import { go, type Route } from "../data.ts";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../ui/breadcrumb.tsx";
import { Button } from "../ui/button.tsx";
import type { Tone } from "./data.ts";

const WORD: Record<Tone, string> = {
  working: "Working",
  trouble: "Has a problem",
  idle: "Idle",
  starting: "Starting",
  stopped: "Stopped",
};
const COLOR: Record<Tone, string> = {
  working: "bg-[var(--ok)] motion-safe:animate-pulse",
  trouble: "bg-[var(--bad)]",
  idle: "bg-[var(--faint)]",
  starting: "",
  stopped: "border border-[var(--faint)]",
};

export function StateDot({ tone }: { tone: Tone }) {
  if (tone === "starting")
    return (
      <LoaderCircleIcon
        role="img"
        aria-label={WORD.starting}
        className="size-3 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
      />
    );
  return (
    <span
      role="img"
      aria-label={WORD[tone]}
      className={`mx-0.5 inline-block size-2 shrink-0 rounded-full ${COLOR[tone]}`}
    />
  );
}

/** A connection's kind as where it is: a URL is remote, anything else runs on this computer. */
export function WhereIcon({ kind }: { kind: string }) {
  const Icon = kind === "url" ? GlobeIcon : LaptopIcon;
  return (
    <Icon
      role="img"
      aria-label={kind === "url" ? "Remote" : "On this computer"}
      className="size-3.5 shrink-0 text-muted-foreground"
    />
  );
}

/** Text that goes somewhere: plain until it's pointed at. */
export function Jump({ to, children }: { to: Route; children: React.ReactNode }) {
  return (
    <Button
      variant="link"
      className="h-auto min-w-0 justify-start truncate border-0 p-0 text-[13px] font-normal text-inherit"
      onClick={() => go(to)}
    >
      {children}
    </Button>
  );
}

/** The agents using something, each a way to it. */
export function UsedBy({ agents }: { agents: { agent: string; name: string }[] }) {
  if (agents.length === 0)
    return <span className="text-[13px] text-[var(--faint)]">Not used yet</span>;
  return (
    <span className="min-w-0 truncate text-[13px] text-muted-foreground">
      {agents.map((agent, i) => (
        <Fragment key={agent.agent}>
          {i > 0 && ", "}
          <Jump to={{ screen: "agent", agent: agent.agent }}>{agent.name}</Jump>
        </Fragment>
      ))}
    </span>
  );
}

export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title}>
      <div className="flex h-7 items-center justify-between">
        <h2 className="text-[13px] font-semibold">{title}</h2>
        {action}
      </div>
      <div className="mt-1">{children}</div>
    </section>
  );
}

export const Nothing = ({ children }: { children: React.ReactNode }) => (
  <p className="py-2 text-[13px] text-[var(--faint)]">{children}</p>
);

export interface Crumb {
  label: string;
  to?: Route;
}

/** A page: its path and its actions on the canvas, its content on one surface. */
export function Page({
  crumbs,
  action,
  children,
}: {
  crumbs: Crumb[];
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <>
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 px-3">
        <Breadcrumb>
          <BreadcrumbList className="flex-nowrap text-[13px]">
            {crumbs.map((crumb, i) => (
              <Fragment key={crumb.label}>
                {i > 0 && <BreadcrumbSeparator />}
                <BreadcrumbItem className="min-w-0">
                  {crumb.to ? (
                    <BreadcrumbLink asChild>
                      <button type="button" onClick={() => go(crumb.to as Route)}>
                        {crumb.label}
                      </button>
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage className="truncate font-semibold">
                      {crumb.label}
                    </BreadcrumbPage>
                  )}
                </BreadcrumbItem>
              </Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
        <div className="flex shrink-0 items-center gap-1">{action}</div>
      </header>
      <main className="window relative min-h-0 flex-1 overflow-hidden rounded-2xl bg-background phone:rounded-none phone:after:hidden">
        {children}
      </main>
    </>
  );
}

export const Scroll = ({ children }: { children: React.ReactNode }) => (
  <div className="no-bar h-full overflow-y-auto p-5 phone:p-3.5">{children}</div>
);
