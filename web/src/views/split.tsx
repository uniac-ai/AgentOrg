// A pane with an optional detail beside it, like a thread beside its channel. At phone width the
// detail, when open, takes the whole pane.

import { cn } from "@/lib/utils";

export function SplitView({ main, detail }: { main: React.ReactNode; detail: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0">
      <div className={cn("min-w-0 flex-1 overflow-y-auto", detail ? "hidden lg:block" : "block")}>
        {main}
      </div>
      {detail ? (
        <aside className="flex min-w-0 flex-1 flex-col overflow-y-auto border-l lg:w-[26rem] lg:flex-none">
          {detail}
        </aside>
      ) : null}
    </div>
  );
}
