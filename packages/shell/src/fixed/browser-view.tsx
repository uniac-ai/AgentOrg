// `screencast@1`: a live picture of the agent's browser. Only the page's pixels come, so the tabs,
// the address bar and what the page asks (a dialog, files, a choice from a list) are drawn here.
// It opens to watch; Take over opens it to operate, and your first input there makes you the driver:
// while you are, the agent's browser calls wait.
import { ArrowLeftIcon, ArrowRightIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../ui/button.tsx";
import { Checkbox } from "../ui/checkbox.tsx";
import type { ViewerProps } from "./live-frames.tsx";
import { useLive } from "./live-socket.ts";
import { Closed } from "./terminal-views.tsx";

interface Tab {
  id: number;
  url: string;
  title: string;
}
type Event =
  | { type: "tabs"; tabs: Tab[]; shown: number | null }
  | { type: "viewport"; width: number; height: number }
  | { type: "dialog"; open: boolean; kind?: string; message?: string; defaultValue?: string }
  | { type: "file-chooser"; open: boolean; multiple?: boolean }
  | {
      type: "choice";
      multiple: boolean;
      options: { value: string; label: string; selected: boolean }[];
    }
  | { type: "driver"; you: boolean; held: boolean; agentWaiting: boolean };

type Asked =
  | Extract<Event, { type: "dialog" }>
  | Extract<Event, { type: "file-chooser" }>
  | Extract<Event, { type: "choice" }>;

/** Keys that are typed as text; the rest are pressed by name. */
const typed = (event: React.KeyboardEvent) =>
  event.key.length === 1 && !event.metaKey && !event.ctrlKey;

const base64 = async (file: File) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};

export function ScreencastView({ target, onWaiting }: ViewerProps) {
  const canOperate = target.mode === "operate";
  const [driving, setDriving] = useState(false);
  const [tabs, setTabs] = useState<{ tabs: Tab[]; shown: number | null }>({
    tabs: [],
    shown: null,
  });
  const [viewport, setViewport] = useState({ width: 1280, height: 800 });
  const [driver, setDriver] = useState({ you: false, held: false, agentWaiting: false });
  const [asked, setAsked] = useState<Asked>();
  const [address, setAddress] = useState<string>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const drove = useRef(false);
  const live = useLive({ ...target, mode: driving ? "operate" : "watch" }, (data) => {
    if (typeof data !== "string") {
      void createImageBitmap(new Blob([data], { type: "image/jpeg" })).then(
        (image) => {
          const c = canvas.current;
          if (!c) return;
          if (c.width !== image.width || c.height !== image.height) {
            c.width = image.width;
            c.height = image.height;
          }
          c.getContext("2d")?.drawImage(image, 0, 0);
        },
        () => {},
      );
      return;
    }
    const event = JSON.parse(data) as Event;
    if (event.type === "tabs") setTabs({ tabs: event.tabs, shown: event.shown });
    else if (event.type === "viewport") setViewport({ width: event.width, height: event.height });
    else if (event.type === "driver") {
      setDriver(event);
      // The service let go for you (no input for a while): back to watching.
      if (event.you) drove.current = true;
      else if (drove.current) {
        drove.current = false;
        setDriving(false);
      }
    } else if (event.type === "choice" || event.open) setAsked(event);
    else setAsked((was) => (was?.type === event.type ? undefined : was));
  });
  const operating = driving && live.state.phase === "open";
  const waiting = operating && driver.you && driver.agentWaiting;
  useEffect(() => {
    onWaiting?.(waiting);
    return () => onWaiting?.(false);
  }, [waiting, onWaiting]);
  const send = (input: Record<string, unknown>) => {
    if (operating) live.send(JSON.stringify(input));
  };
  const shown = tabs.tabs.find((tab) => tab.id === tabs.shown);
  // The address shown follows the page, until you start typing one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the page moves.
  useEffect(() => setAddress(undefined), [shown?.url]);
  const point = (event: React.PointerEvent | React.WheelEvent) => {
    const box = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * viewport.width,
      y: ((event.clientY - box.top) / box.height) * viewport.height,
    };
  };
  const BUTTONS = ["left", "middle", "right"] as const;
  const letGo = () => {
    send({ type: "release" });
    setDriving(false);
  };
  return (
    <section
      aria-label="Browser"
      className={`flex h-[440px] min-w-0 flex-col overflow-hidden rounded-xl border ${operating ? "border-[var(--unread)] ring-1 ring-[var(--unread)]" : ""}`}
    >
      <div
        role="tablist"
        aria-label="Tabs"
        className="no-bar flex h-9 shrink-0 items-end gap-1 overflow-x-auto bg-[var(--canvas)] px-2"
      >
        {tabs.tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === tabs.shown}
            disabled={!operating}
            title={tab.url}
            onClick={() => send({ type: "tab", action: "show", id: tab.id })}
            className={`h-7 max-w-44 min-w-0 shrink truncate rounded-t-lg px-3 text-xs ${tab.id === tabs.shown ? "bg-background text-foreground" : "text-muted-foreground"}`}
          >
            {tab.title || tab.url}
          </button>
        ))}
      </div>
      <form
        className="flex h-10 shrink-0 items-center gap-1 border-b px-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (address) send({ type: "navigate", to: address });
        }}
      >
        {(["back", "forward", "reload"] as const).map((to) => {
          const Icon = { back: ArrowLeftIcon, forward: ArrowRightIcon, reload: RotateCwIcon }[to];
          return (
            <Button
              key={to}
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={to[0]?.toUpperCase() + to.slice(1)}
              disabled={!operating}
              onClick={() => send({ type: "navigate", to })}
            >
              <Icon />
            </Button>
          );
        })}
        <input
          aria-label="Address"
          readOnly={!operating}
          value={address ?? shown?.url ?? ""}
          onChange={(event) => setAddress(event.target.value)}
          spellCheck={false}
          className="h-7 min-w-0 flex-1 rounded-lg bg-[var(--raised)] px-2.5 font-mono text-xs outline-none"
        />
        {operating ? (
          <>
            {waiting && (
              <span className="shrink-0 pl-1 text-xs text-[var(--unread)] tight:hidden">
                Agent waiting
              </span>
            )}
            <Button type="button" size="xs" onClick={letGo}>
              Let go
            </Button>
          </>
        ) : (
          canOperate && (
            <Button
              type="button"
              size="xs"
              variant="secondary"
              disabled={driving}
              onClick={() => setDriving(true)}
            >
              Take over
            </Button>
          )
        )}
      </form>
      <div className="relative flex min-h-0 flex-1 items-center justify-center bg-[var(--canvas)]">
        <canvas
          ref={canvas}
          aria-label="Page"
          tabIndex={operating ? 0 : -1}
          className={`max-h-full max-w-full bg-white outline-none ${operating ? "cursor-default" : "pointer-events-none"}`}
          onPointerDown={(event) => {
            const at = point(event);
            // Keys go to the page from here on; the page around it stays where it is.
            event.currentTarget.focus({ preventScroll: true });
            event.currentTarget.setPointerCapture(event.pointerId);
            send({ type: "mouse", action: "down", button: BUTTONS[event.button] ?? "left", ...at });
          }}
          onPointerUp={(event) =>
            send({
              type: "mouse",
              action: "up",
              button: BUTTONS[event.button] ?? "left",
              ...point(event),
            })
          }
          onPointerMove={(event) => {
            if (event.buttons) send({ type: "mouse", action: "move", ...point(event) });
          }}
          onWheel={(event) =>
            send({
              type: "mouse",
              action: "wheel",
              deltaX: event.deltaX,
              deltaY: event.deltaY,
              ...point(event),
            })
          }
          onKeyDown={(event) => {
            event.preventDefault();
            send(
              typed(event)
                ? { type: "text", text: event.key }
                : { type: "key", action: "down", key: event.key },
            );
          }}
          onKeyUp={(event) => {
            if (!typed(event)) send({ type: "key", action: "up", key: event.key });
          }}
        />
        {asked && (
          <AskedOverlay
            asked={asked}
            you={operating}
            send={send}
            done={() => setAsked(undefined)}
          />
        )}
      </div>
      <Closed state={live.state} again={live.again} />
    </section>
  );
}

/** What the page asked: shown to everyone watching, answered by whoever drives. */
function AskedOverlay({
  asked,
  you,
  send,
  done,
}: {
  asked: Asked;
  you: boolean;
  send(input: Record<string, unknown>): void;
  done(): void;
}) {
  const [text, setText] = useState(asked.type === "dialog" ? (asked.defaultValue ?? "") : "");
  const [picked, setPicked] = useState<string[]>(
    asked.type === "choice" ? asked.options.filter((o) => o.selected).map((o) => o.value) : [],
  );
  const id = useId();
  const answer = (input: Record<string, unknown>) => {
    send(input);
    done();
  };
  return (
    <div
      role="dialog"
      aria-label="The page asks"
      className="absolute inset-x-6 top-6 mx-auto flex max-w-sm flex-col gap-3 rounded-xl border bg-background p-4 text-[13px] shadow-lg"
    >
      {asked.type === "dialog" && (
        <>
          <p className="whitespace-pre-wrap">{asked.message}</p>
          {asked.kind === "prompt" && (
            <input
              aria-label="Answer"
              disabled={!you}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="h-8 rounded-md border px-2"
            />
          )}
          {you && (
            <div className="flex justify-end gap-2">
              {asked.kind !== "alert" && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => answer({ type: "dialog", accept: false })}
                >
                  Cancel
                </Button>
              )}
              <Button
                size="xs"
                onClick={() =>
                  answer({
                    type: "dialog",
                    accept: true,
                    ...(asked.kind === "prompt" ? { text } : {}),
                  })
                }
              >
                OK
              </Button>
            </div>
          )}
        </>
      )}
      {asked.type === "file-chooser" && (
        <>
          <p>{asked.multiple ? "Choose files" : "Choose a file"}</p>
          {you && (
            <div className="flex items-center justify-between gap-2">
              <input
                aria-label="Files"
                type="file"
                multiple={!!asked.multiple}
                onChange={async (event) => {
                  const files = await Promise.all(
                    [...(event.target.files ?? [])].map(async (file) => ({
                      name: file.name,
                      ...(file.type ? { mimeType: file.type } : {}),
                      data: await base64(file),
                    })),
                  );
                  answer({ type: "files", files });
                }}
                className="min-w-0 text-xs"
              />
              <Button
                size="xs"
                variant="ghost"
                onClick={() => answer({ type: "files", files: [] })}
              >
                Cancel
              </Button>
            </div>
          )}
        </>
      )}
      {asked.type === "choice" && (
        <>
          <ul aria-label="Options" className="no-bar flex max-h-56 flex-col overflow-y-auto">
            {asked.options.map((option, n) => (
              <li key={option.value}>
                {asked.multiple ? (
                  <label
                    htmlFor={`${id}-${n}`}
                    className="flex h-8 items-center gap-2 rounded-md px-2 hover:bg-[var(--hover)]"
                  >
                    <Checkbox
                      id={`${id}-${n}`}
                      disabled={!you}
                      checked={picked.includes(option.value)}
                      onCheckedChange={(on) =>
                        setPicked(
                          on ? [...picked, option.value] : picked.filter((v) => v !== option.value),
                        )
                      }
                    />
                    {option.label}
                  </label>
                ) : (
                  <button
                    type="button"
                    disabled={!you}
                    onClick={() => answer({ type: "choice", values: [option.value] })}
                    className={`flex h-8 w-full items-center rounded-md px-2 text-left hover:bg-[var(--hover)] ${option.selected ? "font-semibold" : ""}`}
                  >
                    {option.label}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {asked.multiple && you && (
            <div className="flex justify-end">
              <Button size="xs" onClick={() => answer({ type: "choice", values: picked })}>
                Done
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
