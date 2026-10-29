// Whole-app states: signed out, the service unreachable, and the first load.

import { RefreshCwIcon, TerminalIcon, UnplugIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
      {children}
    </main>
  );
}

export function SignedOutView() {
  return (
    <Centered>
      <TerminalIcon aria-hidden="true" className="size-8 text-muted-foreground" />
      <h1 className="text-lg font-medium">Signed out</h1>
      <code className="rounded-md border bg-muted px-3 py-1.5 font-mono text-sm">
        agentorg-web open
      </code>
    </Centered>
  );
}

export function UnreachableView({ onRetry }: { onRetry: () => void }) {
  return (
    <Centered>
      <UnplugIcon aria-hidden="true" className="size-8 text-muted-foreground" />
      <h1 className="text-lg font-medium">agentorg is not reachable</h1>
      <Button variant="outline" onClick={onRetry}>
        <RefreshCwIcon aria-hidden="true" />
        Retry
      </Button>
    </Centered>
  );
}

export function PaneSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-6" aria-busy="true">
      <span className="sr-only">Loading</span>
      <Skeleton className="h-6 w-56" />
      <Skeleton className="h-4 w-80 max-w-full" />
      <Skeleton className="mt-4 h-20 w-full" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

export function NotFoundView() {
  return (
    <div className="p-6 text-muted-foreground">
      <h1 className="text-lg font-medium text-foreground">Not found</h1>
    </div>
  );
}
