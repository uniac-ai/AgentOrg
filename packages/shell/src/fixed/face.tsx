// An agent's face: its avatar, drawn from the string it was given, or else from its id, so each
// agent keeps one face. A still picture, or live where it is asked to be. Its state is on it: a
// mark while it works or has a problem, a spinner while it starts, faded when it's stopped.
import { avatarFromSeed, toSvg } from "@agentorg/2dlivebot";
import { Avatar } from "@agentorg/2dlivebot/react";
import { LoaderCircleIcon } from "lucide-react";
import { type Tone, WORD } from "./data.ts";

/** FNV-1a over the id, onto one of 24 hues. */
const hueOf = (id: string) =>
  (([...id].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0, 2166136261) >>> 23) %
    24) *
  15;
/** An agent's colour, worked out from its id alone, so a rename keeps it. */
export const tintOf = (id: string) => ({ soft: `oklch(0.62 0.10 ${hueOf(id)} / 0.28)` });

/** How a state that shows on an agent is marked: the others have no mark. */
export const MARK: Partial<Record<Tone, string>> = {
  working: "bg-[var(--ok)] pulse",
  trouble: "bg-[var(--bad)]",
};

/** An agent as its face needs it: `avatar` is the avatar's string, for an agent given one. */
export interface Faced {
  id: string;
  name: string;
  tone: Tone;
  avatar?: string | undefined;
}

/** An avatar's still picture as an image's address: none for text that names no avatar. */
function addressOf(avatar: string) {
  try {
    return `data:image/svg+xml,${encodeURIComponent(toSvg(avatar))}`;
  } catch {
    return undefined;
  }
}
/** Each avatar's still picture, drawn once however many faces show it. */
const pictures = new Map<string, string | undefined>();
function pictureOf(avatar: string) {
  if (!pictures.has(avatar)) pictures.set(avatar, addressOf(avatar));
  return pictures.get(avatar);
}

export function Face({
  agent,
  size = 40,
  plain = false,
  live = false,
}: {
  agent: Faced;
  size?: number;
  /** Without its state's mark. */
  plain?: boolean;
  /** Moving, and doing what the agent does: reading while it works, asleep when it's stopped. */
  live?: boolean;
}) {
  const mark = MARK[agent.tone];
  const dot = Math.max(8, Math.round(size * 0.24));
  const avatar = agent.avatar && pictureOf(agent.avatar) ? agent.avatar : avatarFromSeed(agent.id);
  return (
    <span
      data-face={agent.id}
      className="relative inline-block shrink-0"
      style={{ width: size, height: size }}
    >
      {/* The figure alone, in a square. Whatever draws a face names its agent beside it. */}
      <span
        aria-hidden
        className={`grid size-full ${agent.tone === "stopped" ? "opacity-45 grayscale" : ""}`}
      >
        {live ? (
          <Avatar
            value={avatar}
            size={size}
            state={
              agent.tone === "working" ? "working" : agent.tone === "stopped" ? "asleep" : "idle"
            }
          />
        ) : (
          <img alt="" draggable={false} src={pictureOf(avatar)} width={size} height={size} />
        )}
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
