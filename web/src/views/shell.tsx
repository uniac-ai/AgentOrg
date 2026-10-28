// The app shell: the organization as a sidebar, like a messaging app's people list, and the
// selected pane beside it. At phone width the sidebar becomes a sheet.

import { Link } from "@tanstack/react-router";
import { ActivityIcon, ChevronRightIcon, UnplugIcon, UserRoundIcon } from "lucide-react";
import { useEffect } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
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
import type { ShellModel, SidebarNode } from "../control/shell.tsx";
import { OnlineMark, StateMark, StateName } from "./marks.tsx";

function ActorItem({ node, selected }: { node: SidebarNode; selected: string | undefined }) {
  const { member, waiting } = node;
  const hasChildren = node.children.length > 0;
  const item = (
    <>
      <SidebarMenuButton
        isActive={selected === member.id}
        render={<Link to="/people/$actorId" params={{ actorId: member.id }} />}
      >
        <StateMark member={member} />
        <span className="truncate">{member.name}</span>
        <StateName member={member} />
        {member.online ? <OnlineMark /> : null}
      </SidebarMenuButton>
      {waiting > 0 ? (
        <SidebarMenuBadge
          className={cn(
            "bg-state-waiting/15 text-state-waiting peer-hover/menu-button:text-state-waiting peer-data-active/menu-button:text-state-waiting",
            hasChildren && "right-7",
          )}
        >
          {waiting}
          <span className="sr-only"> waiting on it</span>
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
            aria-label={`${member.name}: actors under it`}
            className="data-[panel-open]:rotate-90"
          />
        }
      >
        <ChevronRightIcon />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <SidebarMenuSub className="mr-0 pr-0">
          {node.children.map((child) => (
            <ActorItem key={child.member.id} node={child} selected={selected} />
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

export function ShellView({ organization, waitingOnYou, offline, place, path, pane }: ShellModel) {
  const selected = place.view === "actor" ? place.id : undefined;
  return (
    <SidebarProvider>
      <CloseSheetOn place={selected ?? place.view} />
      <Sidebar>
        <SidebarContent>
          <h2 className="sr-only">agentorg</h2>
          <SidebarGroup>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={place.view === "you"} render={<Link to="/" />}>
                  <UserRoundIcon aria-hidden="true" />
                  <span>You</span>
                </SidebarMenuButton>
                {waitingOnYou > 0 ? (
                  <SidebarMenuBadge className="bg-primary text-primary-foreground peer-hover/menu-button:text-primary-foreground peer-data-active/menu-button:text-primary-foreground">
                    {waitingOnYou}
                    <span className="sr-only"> waiting</span>
                  </SidebarMenuBadge>
                ) : null}
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={place.view === "activity"}
                  render={<Link to="/activity" />}
                >
                  <ActivityIcon aria-hidden="true" />
                  <span>Activity</span>
                </SidebarMenuButton>
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
                      <ActorItem key={node.member.id} node={node} selected={selected} />
                    ))}
              </SidebarMenu>
            </nav>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <SidebarInset className="h-svh min-w-0">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger />
          {place.view === "you" ? (
            <UserRoundIcon aria-hidden="true" className="size-4 text-muted-foreground" />
          ) : place.view === "activity" ? (
            <ActivityIcon aria-hidden="true" className="size-4 text-muted-foreground" />
          ) : null}
          <nav aria-label="Managers" className="flex min-w-0 items-center gap-1 text-sm">
            {path.map((manager) => (
              <span
                key={manager.id}
                className="flex min-w-0 items-center gap-1 text-muted-foreground"
              >
                <Link
                  to="/people/$actorId"
                  params={{ actorId: manager.id }}
                  className="truncate hover:text-foreground"
                >
                  {manager.name}
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
        <div className="relative min-h-0 flex-1 overflow-y-auto">{pane}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
