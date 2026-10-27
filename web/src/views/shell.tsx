// The app shell: the organization as a sidebar, like a messaging app's people list, and the
// selected pane beside it. At phone width the sidebar becomes a sheet.

import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, InboxIcon, UnplugIcon } from "lucide-react";
import { useEffect } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import type { ShellModel } from "../control/shell.tsx";
import type { OrgNode } from "../model/organization.ts";
import { StateMark, StateName } from "./marks.tsx";

function AgentItem({ node, selected }: { node: OrgNode; selected: string | undefined }) {
  const { agent, asks_to_answer, unread_messages } = node.summary;
  const hasChildren = node.children.length > 0;
  const item = (
    <>
      <SidebarMenuButton
        isActive={selected === agent.id}
        render={<Link to="/people/$agentId" params={{ agentId: agent.id }} />}
      >
        <StateMark agent={agent} />
        <span className={cn("truncate", unread_messages > 0 && "font-semibold")}>
          {agent.title}
        </span>
        <StateName agent={agent} />
        {unread_messages > 0 ? (
          <span className="sr-only">, {unread_messages} unread messages</span>
        ) : null}
      </SidebarMenuButton>
      {asks_to_answer > 0 ? (
        <SidebarMenuBadge
          className={cn(
            "bg-state-waiting/15 text-state-waiting peer-hover/menu-button:text-state-waiting peer-data-active/menu-button:text-state-waiting",
            hasChildren && "right-7",
          )}
        >
          {asks_to_answer}
          <span className="sr-only"> asks to answer</span>
        </SidebarMenuBadge>
      ) : null}
    </>
  );
  if (!hasChildren) return <SidebarMenuItem>{item}</SidebarMenuItem>;
  return (
    <Collapsible defaultOpen render={<SidebarMenuItem />}>
      {item}
      <CollapsibleTrigger
        render={
          <SidebarMenuAction
            aria-label={`${agent.title}: agents under it`}
            className="data-[panel-open]:rotate-90"
          />
        }
      >
        <ChevronRightIcon />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <SidebarMenuSub className="mr-0 pr-0">
          {node.children.map((child) => (
            <AgentItem key={child.summary.agent.id} node={child} selected={selected} />
          ))}
        </SidebarMenuSub>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** At phone width the sidebar is a sheet; going somewhere closes it. */
function CloseSheetOn({ place }: { place: string }) {
  const { setOpenMobile } = useSidebar();
  // biome-ignore lint/correctness/useExhaustiveDependencies: it runs when the place changes.
  useEffect(() => setOpenMobile(false), [place, setOpenMobile]);
  return null;
}

export function ShellView({ organization, inboxCount, offline, place, path, pane }: ShellModel) {
  const selected = place.view === "agent" ? place.id : undefined;
  return (
    <SidebarProvider>
      <CloseSheetOn place={selected ?? place.view} />
      <Sidebar>
        <SidebarHeader>
          <Link to="/inbox" className="px-2 py-1 text-sm font-semibold tracking-tight">
            agentorg
          </Link>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={place.view === "inbox"} render={<Link to="/inbox" />}>
                  <InboxIcon aria-hidden="true" />
                  <span>Inbox</span>
                </SidebarMenuButton>
                {inboxCount > 0 ? (
                  <SidebarMenuBadge className="bg-primary text-primary-foreground peer-hover/menu-button:text-primary-foreground peer-data-active/menu-button:text-primary-foreground">
                    {inboxCount}
                    <span className="sr-only"> waiting</span>
                  </SidebarMenuBadge>
                ) : null}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
          <SidebarGroup>
            <nav aria-label="Organization">
              <SidebarMenu>
                {organization === undefined
                  ? [0, 1, 2, 3].map((n) => (
                      <SidebarMenuItem key={n}>
                        <SidebarMenuSkeleton showIcon />
                      </SidebarMenuItem>
                    ))
                  : organization.map((node) => (
                      <AgentItem key={node.summary.agent.id} node={node} selected={selected} />
                    ))}
              </SidebarMenu>
            </nav>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger />
          {place.view === "inbox" ? (
            <InboxIcon aria-hidden="true" className="size-4 text-muted-foreground" />
          ) : null}
          <nav aria-label="Managers" className="flex min-w-0 items-center gap-1 text-sm">
            {path.map((manager) => (
              <span
                key={manager.id}
                className="flex min-w-0 items-center gap-1 text-muted-foreground"
              >
                <Link
                  to="/people/$agentId"
                  params={{ agentId: manager.id }}
                  className="truncate hover:text-foreground"
                >
                  {manager.title}
                </Link>
                <ChevronRightIcon aria-hidden="true" className="size-3.5 shrink-0" />
              </span>
            ))}
          </nav>
          {offline ? (
            <span
              role="status"
              className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-state-waiting"
            >
              <UnplugIcon aria-hidden="true" className="size-3.5" />
              Offline
            </span>
          ) : null}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{pane}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
