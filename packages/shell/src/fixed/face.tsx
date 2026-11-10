// An agent's face: a colour worked out from its id, so a rename keeps it, and initials from its
// name. Its state is on it: a mark while it works, starts or has a problem, faded when it's stopped,
// and named for a screen reader in every state.
import type { Tone } from "./data.ts";
import { StateDot } from "./parts.tsx";

/** FNV-1a over the id, onto one of 24 hues. */
const hueOf = (id: string) =>
  (([...id].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0, 2166136261) >>> 23) %
    24) *
  15;
/** One letter for one word, two for more. */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0]?.toUpperCase())
    .join("");

export function Face({ id, name, tone }: { id: string; name: string; tone: Tone }) {
  const hue = hueOf(id);
  const letters = initials(name);
  return (
    <span className="relative inline-block size-7 shrink-0">
      <span
        aria-hidden
        className={`grid size-full place-items-center rounded-full font-semibold text-white ${letters.length > 1 ? "text-[10px]" : "text-xs"} ${tone === "stopped" ? "opacity-45 grayscale" : ""}`}
        style={{
          background: `linear-gradient(140deg, oklch(0.80 0.11 ${hue}), oklch(0.60 0.14 ${(hue + 48) % 360}))`,
        }}
      >
        {letters}
      </span>
      <span
        className={
          tone === "working" || tone === "trouble" || tone === "starting"
            ? "absolute -right-0.5 -bottom-0.5 grid place-items-center rounded-full bg-[var(--canvas)] p-0.5 [&>*]:mx-0"
            : "sr-only"
        }
      >
        <StateDot tone={tone} />
      </span>
    </span>
  );
}
