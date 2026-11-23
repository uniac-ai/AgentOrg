// What a page is laid out from, on the frame's ground: its list at the left, on the ground itself,
// and what it shows in cards. Wider than a phone both leave the frame's rows their room, the strip
// along the top and the row of places along the foot.
import { PlusIcon } from "lucide-react";
import { Button } from "../ui/button.tsx";

/**
 * The page's list, under the strip and over the row of places. Beside what is chosen it is as wide
 * as the frame's side; alone, as the page. A sideways scroll over it changes the place: the frame
 * finds it by its mark.
 */
export function ListPanel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section
      aria-label={label}
      data-list
      className="flex min-h-0 min-w-0 flex-1 flex-col wide:pt-[var(--strip)] wide:pb-[var(--foot)] split:w-[var(--side)] split:flex-none"
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
 * put away it is under the strip, as wide as the page, and 12 from the window's foot. On a phone it has the page to its edges, with no line or corners.
 */
export const PAGE_CARD =
  "min-w-0 overflow-hidden bg-[var(--canvas)] wide:mx-1.5 wide:mt-[var(--strip)] wide:mb-[var(--foot)] wide:rounded-xl wide:border wide:shadow-[var(--card-shadow)] split:mt-1.5 split:mb-3 split:ml-0 away:mb-3";
