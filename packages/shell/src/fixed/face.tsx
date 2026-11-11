// An agent's face: a colour from its id and initials from its name. Its state is on it: a mark
// while it works or has a problem, a spinner while it starts, faded when it's stopped.
import { LoaderCircleIcon } from "lucide-react";
import { type Tone, WORD } from "./data.ts";

/** FNV-1a over the id, onto one of 24 hues. */
const hueOf = (id: string) =>
  (([...id].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0, 2166136261) >>> 23) %
    24) *
  15;
/** One letter for one word, two for more: "Release notes" is RN. */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0]?.toUpperCase())
    .join("");
/** An agent's colours, worked out from its id alone, so a rename keeps them. */
export const tintOf = (id: string) => {
  const h = hueOf(id);
  return {
    from: `oklch(0.80 0.11 ${h})`,
    to: `oklch(0.60 0.14 ${(h + 48) % 360})`,
    soft: `oklch(0.62 0.10 ${h} / 0.28)`,
  };
};

/** How a state that shows on an agent is marked: the others have no mark. */
export const MARK: Partial<Record<Tone, string>> = {
  working: "bg-[var(--ok)] pulse",
  trouble: "bg-[var(--bad)]",
};

export function Face({
  agent,
  size = 40,
  plain = false,
  bare = false,
}: {
  agent: { id: string; name: string; tone: Tone };
  size?: number;
  /** Without its state. */
  plain?: boolean;
  /** Without its letters. */
  bare?: boolean;
}) {
  const tint = tintOf(agent.id);
  const mark = MARK[agent.tone];
  const dot = Math.max(8, Math.round(size * 0.24));
  const letters = initials(agent.name);
  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }}>
      <span
        aria-hidden
        className={`grid size-full place-items-center rounded-full font-semibold text-white ${agent.tone === "stopped" ? "opacity-45 grayscale" : ""}`}
        style={{
          background: `linear-gradient(140deg, ${tint.from}, ${tint.to})`,
          fontSize: Math.round(size * ([...letters].length > 1 ? 0.36 : 0.42)),
        }}
      >
        {!bare && letters}
      </span>
      {!plain && agent.tone === "starting" && (
        <LoaderCircleIcon
          role="img"
          aria-label={WORD.starting}
          className="absolute -right-0.5 -bottom-0.5 animate-spin rounded-full bg-background text-muted-foreground motion-reduce:animate-none"
          style={{ width: dot + 2, height: dot + 2 }}
        />
      )}
      {!plain && mark && (
        <span
          role="img"
          aria-label={WORD[agent.tone]}
          className={`absolute right-0 bottom-0 rounded-full ring-2 ring-background ${mark}`}
          style={{ width: dot, height: dot }}
        />
      )}
    </span>
  );
}
