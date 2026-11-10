// `screencast@1`: a live picture of the agent's browser. Only the page's pixels come, so the tabs,
// the address bar and what the page asks (a dialog, files, a choice from a list) are drawn here.
// Where you may operate it, it opens ready for your input: nobody holds the browser, so you and the
// agent use it at once, and the page shown is this viewer's own.
import { ArrowLeftIcon, ArrowRightIcon, PlusIcon, RotateCwIcon, XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../ui/button.tsx";
import { Checkbox } from "../ui/checkbox.tsx";
import type { ViewerProps } from "./live-frames.tsx";
import { useLive } from "./live-socket.ts";
import { Closed } from "./xterm.tsx";

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
    };

type Asked =
  | Extract<Event, { type: "dialog" }>
  | Extract<Event, { type: "file-chooser" }>
  | Extract<Event, { type: "choice" }>;

/** A tab that has gone nowhere yet. */
const BLANK = "about:blank";
/** A tab's name: its page's title, else the site it is on, else that it is new. */
const nameOf = (tab: Tab) => {
  if (tab.title) return tab.title;
  if (!tab.url || tab.url === BLANK) return "New tab";
  return /^https?:/.test(tab.url) && URL.canParse(tab.url) ? new URL(tab.url).host : tab.url;
};

/** Keys that are typed as text; the rest are pressed by name. */
const typed = (event: React.KeyboardEvent) =>
  event.key.length === 1 && !event.metaKey && !event.ctrlKey;

const base64 = async (file: File) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};

export function ScreencastView({ target }: ViewerProps) {
  const canOperate = target.mode === "operate";
  const [tabs, setTabs] = useState<{ tabs: Tab[]; shown: number | null }>({
    tabs: [],
    shown: null,
  });
  const [viewport, setViewport] = useState({ width: 1280, height: 800 });
  const [asked, setAsked] = useState<Asked>();
  const [address, setAddress] = useState<string>();
  const canvas = useRef<HTMLCanvasElement>(null);
  /** The keys held down in the page: one let go there was pressed there. */
  const held = useRef(new Set<string>());
  /** No tab is shown, so a picture still on its way belongs to none. */
  const none = useRef(false);
  const live = useLive(target, (data) => {
    if (typeof data !== "string") {
      void createImageBitmap(new Blob([data], { type: "image/jpeg" })).then(
        (image) => {
          const c = canvas.current;
          if (!c || none.current) return;
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
    if (event.type === "tabs") {
      setTabs({ tabs: event.tabs, shown: event.shown });
      // With no tab shown there is no page: what the last one looked like goes.
      none.current = event.shown === null;
      if (event.shown === null) {
        const c = canvas.current;
        c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
      }
    } else if (event.type === "viewport") setViewport({ width: event.width, height: event.height });
    else if (event.type === "choice" || event.open) setAsked(event);
    else setAsked((was) => (was?.type === event.type ? undefined : was));
  });
  const operating = canOperate && live.state.phase === "open";
  const send = (input: Record<string, unknown>) => {
    if (operating) live.send(JSON.stringify(input));
  };
  const shown = tabs.tabs.find((tab) => tab.id === tabs.shown);
  const url = shown && shown.url !== BLANK ? shown.url : "";
  // The address shown follows the page, until you start typing one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the tab or its page changes.
  useEffect(() => setAddress(undefined), [tabs.shown, url]);
  const point = (event: { clientX: number; clientY: number }) => {
    const box = canvas.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 1, 1);
    return {
      x: ((event.clientX - box.left) / box.width) * viewport.width,
      y: ((event.clientY - box.top) / box.height) * viewport.height,
    };
  };
  // A list belongs to the page it opened on, and the service says nothing of it on another.
  // biome-ignore lint/correctness/useExhaustiveDependencies: dropped when the tab shown changes.
  useEffect(
    () => setAsked((was) => (was?.type === "choice" || tabs.shown === null ? undefined : was)),
    [tabs.shown],
  );
  // The wheel is the page's once the page has focus, and then it scrolls nothing else. Until then
  // it scrolls what's around the frame, and nothing of the agent's.
  useEffect(() => {
    const page = canvas.current;
    const wheel = (event: WheelEvent) => {
      if (document.activeElement !== page) return;
      event.preventDefault();
      send({
        type: "mouse",
        action: "wheel",
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        ...point(event),
      });
    };
    page?.addEventListener("wheel", wheel, { passive: false });
    return () => page?.removeEventListener("wheel", wheel);
  });
  const BUTTONS = ["left", "middle", "right"] as const;
  const visit = () => {
    if (!address) return;
    // An address bar's habits: a name with no scheme is a site, and the page takes the keys. With
    // no tab to go there in, it opens one.
    const to = address.includes("://") ? address : `https://${address}`;
    send(tabs.shown === null ? { type: "tab", action: "open", url: to } : { type: "navigate", to });
    canvas.current?.focus({ preventScroll: true });
  };
  return (
    <section
      aria-label="Browser"
      className="flex h-[440px] min-w-0 flex-col overflow-hidden rounded-xl border bg-background text-[15px] leading-[1.5]"
    >
      {/* The first row: its tabs, with the plus beside them. */}
      <div className="flex h-11 shrink-0 items-center gap-1 pr-1.5 pl-2">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <div
            role="tablist"
            aria-label="Tabs"
            className="no-bar flex min-w-0 gap-1 overflow-x-auto"
          >
            {tabs.tabs.map((tab) => {
              const on = tab.id === tabs.shown;
              // Where you may only watch, a tab is its name alone.
              if (!canOperate)
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    disabled
                    className={`h-8 min-w-0 shrink truncate rounded-lg px-3 text-[13px] ${on ? "bg-[var(--selected)] font-medium text-foreground" : "text-muted-foreground"}`}
                  >
                    {nameOf(tab)}
                  </button>
                );
              return (
                <span
                  key={tab.id}
                  className={`flex h-8 min-w-0 shrink items-center rounded-lg ${on ? "bg-[var(--selected)]" : "hover:bg-[var(--hover)]"}`}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={on}
                    disabled={!operating}
                    onClick={() => send({ type: "tab", action: "show", id: tab.id })}
                    className={`h-8 min-w-0 truncate pr-1 pl-3 text-[13px] ${on ? "font-medium" : "text-muted-foreground"}`}
                  >
                    {nameOf(tab)}
                  </button>
                  <button
                    type="button"
                    aria-label={`Close ${nameOf(tab)}`}
                    disabled={!operating}
                    onClick={() => send({ type: "tab", action: "close", id: tab.id })}
                    className="mr-1 grid size-5 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-[var(--hover)]"
                  >
                    <XIcon className="size-3" />
                  </button>
                </span>
              );
            })}
          </div>
          {canOperate && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="New tab"
              disabled={!operating}
              onClick={() => send({ type: "tab", action: "open" })}
            >
              <PlusIcon />
            </Button>
          )}
        </div>
      </div>
      {/* The second row: where it is. */}
      <form
        className="flex h-10 shrink-0 items-center gap-0.5 px-2"
        onSubmit={(event) => {
          event.preventDefault();
          visit();
        }}
      >
        {(["back", "forward", "reload"] as const).map((to) => {
          const Icon = { back: ArrowLeftIcon, forward: ArrowRightIcon, reload: RotateCwIcon }[to];
          return (
            <Button
              key={to}
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={to[0]?.toUpperCase() + to.slice(1)}
              disabled={!operating || tabs.shown === null}
              onClick={() => send({ type: "navigate", to })}
            >
              <Icon />
            </Button>
          );
        })}
        <input
          aria-label="Address"
          readOnly={!operating}
          value={address ?? url}
          onChange={(event) => setAddress(event.target.value)}
          inputMode="url"
          enterKeyHint="go"
          spellCheck={false}
          className="ml-1 h-8 min-w-0 flex-1 rounded-full bg-[var(--raised)] px-3.5 font-mono text-xs outline-none"
        />
      </form>
      <div className="relative m-2 mt-1 flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-white text-[#111]">
        <canvas
          ref={canvas}
          aria-label="Page"
          tabIndex={-1}
          className={`max-h-full max-w-full bg-white outline-none ${operating ? "cursor-default" : "pointer-events-none"}`}
          onPointerDown={(event) => {
            const at = point(event);
            // Keys and the wheel go to the page from here on; what's around it stays where it is.
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
          onKeyDown={(event) => {
            event.preventDefault();
            held.current.add(event.key);
            send(
              typed(event)
                ? { type: "text", text: event.key }
                : { type: "key", action: "down", key: event.key },
            );
          }}
          onKeyUp={(event) => {
            if (held.current.delete(event.key) && !typed(event))
              send({ type: "key", action: "up", key: event.key });
          }}
        />
        {asked && (
          <AskedOverlay
            key={asked.type === "dialog" ? asked.message : asked.type}
            asked={asked}
            operating={operating}
            send={send}
            done={() => setAsked(undefined)}
          />
        )}
      </div>
      <Closed state={live.state} again={live.again} />
    </section>
  );
}

/** What the page asked: shown to everyone watching, answered where you may operate. */
function AskedOverlay({
  asked,
  operating,
  send,
  done,
}: {
  asked: Asked;
  operating: boolean;
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
      className="absolute inset-x-6 top-6 mx-auto flex max-w-sm flex-col gap-3 rounded-xl border bg-background p-4 text-[13px] text-foreground shadow-lg"
    >
      {asked.type === "dialog" && (
        <>
          <p className="whitespace-pre-wrap">{asked.message}</p>
          {asked.kind === "prompt" && (
            <input
              aria-label="Answer"
              disabled={!operating}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="h-8 rounded-md border px-2"
            />
          )}
          {operating && (
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
          {operating && (
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
                      disabled={!operating}
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
                    disabled={!operating}
                    onClick={() => answer({ type: "choice", values: [option.value] })}
                    className={`flex h-8 w-full items-center rounded-md px-2 text-left hover:bg-[var(--hover)] ${option.selected ? "font-semibold" : ""}`}
                  >
                    {option.label}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {asked.multiple && operating && (
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
