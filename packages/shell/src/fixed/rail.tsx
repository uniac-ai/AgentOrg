/**
 * The rail: a scrolling element's sections as logos down its right edge, in place of a scrollbar,
 * joined by a line. It knows only the scrolling element and its sections, each a heading, a logo
 * and a label, and nothing of what they hold.
 *
 * Where the scroll stands is one number: how far it has come from the first heading, in headings.
 * 2.5 is halfway between the third heading and the fourth. Everything the rail draws follows from
 * it: how much of each connector is lit, and how the brightness and the growth are shared between
 * the two logos at its ends.
 */
import type { LucideIcon } from "lucide-react";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useReducedMotion } from "./motion.ts";

export interface RailSection {
  key: string;
  label: string;
  logo: LucideIcon;
  heading(): HTMLElement | null | undefined;
}

/** The current logo's enlargement, at most. */
const GROW = 0.06;
/** How long the rail stays at full opacity after the scrolling stops. */
const HOLD_MS = 1000;

const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));

/**
 * Where an element is in the scrolling content, by layout, so a window still growing as it opens
 * doesn't skew it. The scrolling element is positioned, so it is where the offsets lead.
 */
function topIn(element: HTMLElement, box: HTMLElement) {
  let y = 0;
  let at: Element | null = element;
  while (at instanceof HTMLElement && at !== box) {
    y += at.offsetTop;
    at = at.offsetParent;
  }
  return at === box
    ? y
    : element.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
}

/** The scroll that brings each heading to where the first one starts, as far as it goes. */
function stopsOf(box: HTMLElement, sections: RailSection[]) {
  const pad = Number.parseFloat(getComputedStyle(box).paddingTop || "0");
  const end = box.scrollHeight - box.clientHeight;
  return sections.map((section) => {
    const heading = section.heading();
    return heading ? clamp(topIn(heading, box) - pad, 0, end) : 0;
  });
}

/** How far the scroll has come, in headings. */
function whereOf(box: HTMLElement, sections: RailSection[]) {
  const stops = stopsOf(box, sections);
  const scroll = box.scrollTop;
  const last = stops.length - 1;
  if (last <= 0 || scroll <= (stops[0] ?? 0)) return 0;
  for (let i = 0; i < last; i++) {
    const from = stops[i] as number;
    const to = stops[i + 1] as number;
    if (scroll < to) return to > from ? i + (scroll - from) / (to - from) : i + 1;
  }
  return last;
}

export function Rail({
  scroller,
  sections,
}: {
  scroller: RefObject<HTMLElement | null>;
  sections: RailSection[];
}) {
  const reduced = useReducedMotion();
  const [at, setAt] = useState(0);
  const [scrolling, setScrolling] = useState(false);
  const list = useRef(sections);
  list.current = sections;
  const lines = useRef<(HTMLElement | null)[]>([]);
  const dragging = useRef(false);
  const keys = sections.map((section) => section.key).join(" ");

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the sections change.
  useLayoutEffect(() => {
    const box = scroller.current;
    if (box) setAt(whereOf(box, list.current));
  }, [scroller, keys]);
  // Scrolling brings it to full opacity, until a second after it stops.
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    let held: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      setAt(whereOf(box, list.current));
      setScrolling(true);
      clearTimeout(held);
      held = setTimeout(() => setScrolling(false), HOLD_MS);
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      box.removeEventListener("scroll", onScroll);
      clearTimeout(held);
    };
  }, [scroller]);
  // A section that grows, folds or goes moves the headings below it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the sections, watched again as they change.
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const watch = new ResizeObserver(() => setAt(whereOf(box, list.current)));
    watch.observe(box);
    for (const child of box.children) watch.observe(child);
    return () => watch.disconnect();
  }, [scroller, keys]);

  /** Pressing a logo: its heading comes to the top. */
  const jump = (i: number) => {
    const box = scroller.current;
    if (!box) return;
    box.scrollTo({
      top: stopsOf(box, list.current)[i] ?? 0,
      behavior: reduced ? "instant" : "smooth",
    });
  };
  /** Dragging the line: the lit end follows the pointer, and the scroll follows the lit end. */
  const dragTo = (y: number) => {
    const box = scroller.current;
    if (!box) return;
    const stops = stopsOf(box, list.current);
    let scroll = stops.at(-1) ?? 0;
    for (const [i, line] of lines.current.entries()) {
      if (!line) continue;
      const { top, height } = line.getBoundingClientRect();
      if (y < top + height) {
        const from = stops[i] ?? 0;
        scroll = from + clamp((y - top) / height, 0, 1) * ((stops[i + 1] ?? from) - from);
        break;
      }
    }
    box.scrollTo({ top: scroll, behavior: "instant" });
  };

  const whole = Math.floor(at);
  const part = at - whole;
  /** A logo's share of the brightness and the growth: the two at the current connector's ends share it. */
  const share = (i: number) => (i === whole ? 1 - part : i === whole + 1 ? part : 0);
  /** How much of a connector is lit: those passed whole, the current one as far as the scroll has come. */
  const lit = (i: number) => (i < whole ? 1 : i === whole ? part : 0);
  const current = Math.round(at);
  return (
    <nav
      aria-label="Sections"
      data-rail
      data-scrolling={scrolling || undefined}
      className="group/rail absolute top-3 right-2 bottom-3 z-10 flex w-8 flex-col items-center opacity-50 transition-opacity duration-200 hover:opacity-100 has-[:focus-visible]:opacity-100 data-[scrolling]:opacity-100 motion-reduce:transition-none"
    >
      {sections.map((section, i) => {
        const shared = share(i);
        const Logo = section.logo;
        return (
          <div key={section.key} className="contents">
            <button
              type="button"
              aria-label={section.label}
              aria-current={i === current ? "true" : undefined}
              onClick={() => jump(i)}
              style={{
                transform: reduced ? undefined : `scale(${1 + GROW * shared})`,
                color: `color-mix(in srgb, var(--fg) ${Math.round(shared * 100)}%, var(--faint))`,
              }}
              className="relative grid size-7 shrink-0 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              <Logo className="size-4" />
              {/* Its label, at its left, while the rail is pointed at or the keyboard is in it. */}
              <span
                aria-hidden
                className="pointer-events-none absolute top-1/2 right-full mr-2 -translate-y-1/2 rounded-full bg-[var(--raised)] px-2.5 py-1 text-xs whitespace-nowrap text-foreground opacity-0 shadow-md transition-opacity duration-150 group-hover/rail:opacity-100 group-has-[:focus-visible]/rail:opacity-100 motion-reduce:transition-none"
              >
                {section.label}
              </span>
            </button>
            {i < sections.length - 1 && (
              // The line to the next logo, 3 px and rounded, clear of both: dragged, it scrolls.
              <div
                ref={(line) => {
                  lines.current[i] = line;
                }}
                aria-hidden
                data-line
                onPointerDown={(event) => {
                  event.preventDefault();
                  dragging.current = true;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  dragTo(event.clientY);
                }}
                onPointerMove={(event) => dragging.current && dragTo(event.clientY)}
                onPointerUp={() => {
                  dragging.current = false;
                }}
                onPointerCancel={() => {
                  dragging.current = false;
                }}
                className="relative my-2 min-h-2 w-5 flex-1 cursor-grab touch-none active:cursor-grabbing"
              >
                <span className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-[var(--line-strong)]" />
                <span
                  data-lit
                  className="absolute top-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-[var(--fg)]"
                  style={{ height: `${lit(i) * 100}%` }}
                />
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
