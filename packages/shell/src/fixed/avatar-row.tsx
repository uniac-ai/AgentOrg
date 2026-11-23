// The avatars a new agent is chosen from: a row with no end, each avatar with a name. The one in
// the middle is the choice, and alive; the others are still pictures, smaller and fainter toward
// the sides. It is dragged, or moved by its two buttons, the arrow keys and the wheel, which a turn
// up or down moves as a turn sideways does. The row is a ring of
// `KEPT` places that goes round: a place that comes round to the far side, out of sight, is given a
// new avatar and name, so there are always new ones ahead and never more than `KEPT`. The ones
// just passed, as many as are behind the choice in the ring, come back as they were.
import { Avatar } from "@agentorg/2dlivebot/react";
import { WheelGesturesPlugin } from "embla-carousel-wheel-gestures";
import { useEffect, useRef, useState } from "react";
import {
  Carousel,
  type CarouselApi,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "../ui/carousel.tsx";
import GradualBlur from "../ui/gradual-blur.tsx";
import { apart, comingRound, freshPair, KEPT, type Pair } from "./avatar-ring.ts";
import { useReducedMotion } from "./motion.ts";
import { freshName } from "./names.ts";

/** An avatar's width and height in the row, in pixels. */
const SIZE = 104;
/** Within this many places of the choice, a place keeps what it has. */
const NEAR = 6;

/** The blur at each side has square corners, whatever the row's own are. */
const SQUARE = {
  borderTopLeftRadius: 0,
  borderTopRightRadius: 0,
  borderBottomLeftRadius: 0,
  borderBottomRightRadius: 0,
};

type Api = NonNullable<CarouselApi>;

/**
 * Each avatar by how far it is from the middle, as the row moves: smaller, fainter and drawn in a
 * little. Nothing turns. The distance is Embla's, in places, as its tween examples work it out.
 */
function paint(api: Api, event?: string) {
  const engine = api.internalEngine();
  const progress = api.scrollProgress();
  const seen = api.slidesInView();
  const snaps = api.scrollSnapList();
  const nodes = api.slideNodes();
  snaps.forEach((snap, index) => {
    for (const slide of engine.slideRegistry[index] ?? []) {
      if (event === "scroll" && !seen.includes(slide)) continue;
      let from = snap - progress;
      // A place the loop has carried to the row's other end is measured from there.
      if (engine.options.loop)
        for (const point of engine.slideLooper.loopPoints) {
          const target = point.target();
          if (slide === point.index && target !== 0)
            from = target < 0 ? snap - (1 + progress) : snap + (1 - progress);
        }
      const away = Math.abs(from * snaps.length);
      const node = nodes[slide]?.firstElementChild as HTMLElement | null | undefined;
      if (!node) continue;
      const scale = Math.max(1 - 0.22 * away, 0.5);
      const shift = -Math.sign(from) * 8 * Math.min(away, 2);
      node.style.transform = `translateX(${shift.toFixed(2)}px) scale(${scale.toFixed(3)})`;
      node.style.opacity = Math.min(Math.max(1 - 0.42 * away, 0), 1).toFixed(3);
    }
  });
}

/**
 * Embla's wheel plugin for one way of turning, on a row that goes round. The plugin takes how far
 * the row has scrolled for its start and its end, and holds the wheel back there: at the ring's
 * first place, going left. A ring has neither, so the plugin is told the row is in its middle.
 */
function wheelRound(axis: "x" | "y"): ReturnType<typeof WheelGesturesPlugin> {
  const plugin = WheelGesturesPlugin({ forceWheelAxis: axis });
  return {
    ...plugin,
    init: (api, options) =>
      plugin.init(Object.assign(Object.create(api), { scrollProgress: () => 0.5 }), options),
  };
}

/**
 * Whether a place is out of sight as the row is drawn now, whatever its width: farther from the
 * row's middle than the row reaches, by Embla's own measure of where it has scrolled to, and not
 * among the places it sees.
 */
function outOfSight(api: Api, place: number) {
  if (api.slidesInView().includes(place)) return false;
  const snaps = api.scrollSnapList();
  const from = Math.abs((snaps[place] ?? 0) - api.scrollProgress()) % 1;
  const away = Math.min(from, 1 - from) * snaps.length;
  return away >= api.rootNode().offsetWidth / 2 / SIZE + 1;
}

/**
 * The row. `taken` is the names agents have, which none here is given; `onChoose` hears the avatar
 * and name in the middle, at the start and each time it changes.
 */
export function AvatarRow({
  taken,
  onChoose,
}: {
  taken: ReadonlySet<string>;
  onChoose(pair: Pair): void;
}) {
  const [ring, setRing] = useState(() => {
    const first: Pair[] = [];
    for (let i = 0; i < KEPT; i++)
      first.push(freshPair([...taken, ...first.map((pair) => pair.name)]));
    return first;
  });
  const [at, setAt] = useState(0);
  const [api, setApi] = useState<CarouselApi>();
  const reduced = useReducedMotion();
  // The wheel moves the row as a drag does, by Embla's own plugin, which reads one way of turning
  // each: one for a wheel turned up or down, one for a sideways scroll. Over the row the wheel is
  // the row's, and scrolls nothing behind it.
  const [wheels] = useState(() => [wheelRound("y"), wheelRound("x")]);
  // What the row's own events read: the ring and the choice as they now are, and the places that
  // have come round and wait, out of sight, for a new avatar.
  const now = useRef({ ring, at, stale: new Set<number>(), taken, onChoose });
  now.current.taken = taken;
  now.current.onChoose = onChoose;

  // Once, with the avatar it opens on.
  useEffect(() => {
    const first = now.current.ring[0];
    if (first) now.current.onChoose(first);
  }, []);

  // An agent made while the row is open may have a name in it: that place is given another.
  const agents = taken.size;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the names taken are one set, which grows.
  useEffect(() => {
    const held = now.current;
    const had = new Set([...held.taken].map((name) => name.toLowerCase()));
    if (!held.ring.some((pair) => had.has(pair.name.toLowerCase()))) return;
    const next = [...held.ring];
    next.forEach((pair, place) => {
      if (had.has(pair.name.toLowerCase()))
        next[place] = {
          ...pair,
          name: freshName([...held.taken, ...next.map((one) => one.name)]),
        };
    });
    held.ring = next;
    setRing(next);
    const chosen = next[held.at];
    if (chosen) held.onChoose(chosen);
  }, [agents]);

  useEffect(() => {
    if (!api) return;
    /** A place that has come round is given a new avatar once it is out of sight. */
    const renew = () => {
      const held = now.current;
      let next: Pair[] | undefined;
      for (const place of [...held.stale]) {
        // The choice came back toward it first: it keeps what it has.
        if (apart(place, held.at, KEPT) < NEAR) held.stale.delete(place);
        else if (outOfSight(api, place)) {
          next ??= [...held.ring];
          next[place] = freshPair([...held.taken, ...next.map((pair) => pair.name)]);
          held.stale.delete(place);
        }
      }
      if (!next) return;
      held.ring = next;
      setRing(next);
    };
    const select = () => {
      const held = now.current;
      const to = api.selectedScrollSnap();
      if (to === held.at) return;
      for (const place of comingRound(held.at, to, KEPT)) held.stale.add(place);
      held.at = to;
      setAt(to);
      const chosen = held.ring[to];
      if (chosen) held.onChoose(chosen);
      renew();
    };
    paint(api);
    api
      .on("select", select)
      .on("slidesInView", renew)
      .on("settle", renew)
      .on("reInit", paint)
      .on("scroll", paint)
      .on("slideFocus", paint);
    return () => {
      api
        .off("select", select)
        .off("slidesInView", renew)
        .off("settle", renew)
        .off("reInit", paint)
        .off("scroll", paint)
        .off("slideFocus", paint);
    };
  }, [api]);

  return (
    <Carousel
      aria-label="Avatar"
      tabIndex={0}
      opts={{ loop: true, align: "center" }}
      plugins={wheels}
      setApi={setApi}
      jump={reduced}
      className="mx-8 cursor-grab rounded-2xl outline-none max-sm:mx-3 select-none focus-visible:ring-2 focus-visible:ring-ring/50 active:cursor-grabbing"
    >
      <CarouselContent className="ml-0 py-2">
        {ring.map((pair, place) => (
          <CarouselItem
            // A place stays where it is in the ring: what it holds changes.
            // biome-ignore lint/suspicious/noArrayIndexKey: the place is the key.
            key={place}
            aria-label={pair.name}
            aria-current={place === at ? "true" : undefined}
            className="basis-auto pl-0"
            onClick={() => api?.scrollTo(place, reduced)}
          >
            {/* Until the row has measured itself, nothing is drawn at the wrong size. */}
            <div className="opacity-0 will-change-transform" style={{ width: SIZE, height: SIZE }}>
              {place === at ? (
                <Avatar value={pair.avatar} size={SIZE} />
              ) : (
                <img alt="" draggable={false} width={SIZE} height={SIZE} src={pair.still} />
              )}
            </div>
          </CarouselItem>
        ))}
      </CarouselContent>
      {/* The row goes into a blur and the card's own colour at each side, under its buttons, which
          take no room of their own. */}
      <GradualBlur
        position="left"
        width={56}
        strength={1}
        curve="ease-out"
        tint="var(--create-card)"
        zIndex={10}
        style={SQUARE}
      />
      <GradualBlur
        position="right"
        width={56}
        strength={1}
        curve="ease-out"
        tint="var(--create-card)"
        zIndex={10}
        style={SQUARE}
      />
      <CarouselPrevious
        variant="ghost"
        size="icon-sm"
        className="left-0 z-20 size-7 text-muted-foreground"
      >
        Previous avatar
      </CarouselPrevious>
      <CarouselNext
        variant="ghost"
        size="icon-sm"
        className="right-0 z-20 size-7 text-muted-foreground"
      >
        Next avatar
      </CarouselNext>
      <span aria-live="polite" className="sr-only">
        {ring[at]?.name}
      </span>
    </Carousel>
  );
}
