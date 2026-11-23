// What a page is laid out from, on the frame's ground: its list at the left, on the ground itself,
// and what it shows in cards. Wider than a phone both leave the frame's rows their room, the strip
// along the top and the row of places along the foot.
import { PlusIcon } from "lucide-react";
import { cn } from "../cn.ts";
import { Button } from "../ui/button.tsx";

/**
 * How a part of the frame's left side goes with the list while it is put away: off the window's
 * left edge, and back where it was, over the page, for as long as it is looked at. The list is
 * over all the page draws then, and the frame's own parts over the list.
 */
export const SIDE_PART =
  "away:-translate-x-[calc(var(--side)+24px)] away:transition-[translate] away:duration-200 away:ease-out peek:translate-x-0 motion-reduce:duration-0";

/**
 * The page's list, under the strip and over the row of places. Beside what is chosen it is as wide
 * as the frame's side; alone, as the page. Put away from `beside` what is chosen, it is off the
 * window's left edge, and looked at it lies over the page at the frame's side, on the ground, with
 * a line and a shadow at its end. A sideways scroll over it changes the place: the frame finds it
 * by its mark.
 */
export function ListPanel({
  label,
  beside,
  children,
}: {
  label: string;
  /** Something is chosen, and shown where there is room beside the list. */
  beside: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={label}
      data-list
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col wide:pt-[var(--strip)] wide:pb-[var(--foot)] split:w-[var(--side)] split:flex-none",
        beside &&
          `away:absolute away:inset-y-0 away:left-0 away:z-30 away:w-[var(--side)] away:flex-none away:border-r away:bg-[var(--ground)] peek:shadow-2xl ${SIDE_PART}`,
      )}
    >
      {children}
    </section>
  );
}

/**
 * A section of the list starts with its head: its label, small, in line with the rows' words, and
 * a plus at its end, named for the window it opens (`add`).
 */
export function ListHead({ label, add, onAdd }: { label: string; add: string; onAdd(): void }) {
  return (
    <header className="flex h-10 shrink-0 items-center pr-3 pl-[18px]">
      <h1 className="min-w-0 flex-1 truncate text-[13px] font-medium text-muted-foreground">
        {label}
      </h1>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={add}
        aria-haspopup="dialog"
        className="text-muted-foreground"
        onClick={onAdd}
      >
        <PlusIcon />
      </Button>
    </header>
  );
}

/**
 * A card: what the page shows, on the canvas, with a thin line, 14 px corners and a slight shadow.
 * Beside the list it is 6 from the window's top and side and from the next card, and 12 from its
 * foot, level with the row of places; alone, it is between the strip and that row. With the list
 * put away it has the window, 6 from each edge, and starts under a window's own buttons where the
 * window draws them over the page (`--corner`). On a phone it has the page to its edges, with no
 * line or corners.
 */
export const PAGE_CARD =
  "min-w-0 overflow-hidden bg-[var(--canvas)] wide:mx-1.5 wide:mt-[var(--strip)] wide:mb-[var(--foot)] wide:rounded-xl wide:border wide:shadow-[var(--card-shadow)] split:mt-1.5 split:mb-3 split:ml-0 away:mt-[calc(6px+min(var(--corner),46px))] away:mb-1.5";
