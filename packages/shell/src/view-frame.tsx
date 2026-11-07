import { FrameHost, openFrame } from "@agentorg/sdk/frame/host";
import { useEffect, useRef, useState } from "react";
import type { View } from "./api.ts";
import { api, manifestOf, themeTokens, useConnection, useTheme } from "./data.ts";
import { viewLog } from "./rules.ts";
import { signIn } from "./sign-in.ts";

/** How long a view has to load and mount; a frame with no runtime never answers. */
const LOAD_MS = 15_000;

const sizeOf = (element: HTMLElement) => ({
  width: element.clientWidth,
  height: element.clientHeight,
});

/**
 * One view in its own sandboxed frame: opaque origin, scripts only. The shell hands it a port,
 * loads the view's bundle with which slots are bound, mounts it with the shell's theme and the
 * frame's size, and serves its calls as the view's Actor. It is unmounted and closed when it
 * leaves; one that fails to load is a quiet line in its place, tried again when the connection to
 * AgentOrg comes back.
 */
/**
 * `onSize` hears the view's content height, as its frame reports it (bounded and paced by
 * `FrameHost`), for a placement that sizes to its content; `height` is the height it gave back.
 */
type Sizing = { onSize?(height: number): void; height?: number };

export function ViewFrame({
  actor,
  module,
  hash,
  onSize,
  height,
}: View & { hash: string } & Sizing) {
  const [attempt, setAttempt] = useState(0);
  const key = `${actor}\0${module}\0${hash}\0${attempt}`;
  // Failed for this view and this try only: another view, or another try, starts afresh.
  const [failed, setFailed] = useState<string>();
  const connection = useConnection();
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a reopened connection retries.
  useEffect(() => {
    if (connection === "open" && failed === key) setAttempt((n) => n + 1);
  }, [connection]);
  if (failed === key) return <div className="view-error">This view didn't load.</div>;
  return (
    <Frame
      key={key}
      actor={actor}
      module={module}
      hash={hash}
      onFailed={() => setFailed(key)}
      {...(onSize ? { onSize } : {})}
      {...(height !== undefined ? { height } : {})}
    />
  );
}

function Frame({
  actor,
  module,
  hash,
  onFailed,
  onSize,
  height,
}: View & { hash: string; onFailed(): void } & Sizing) {
  const frame = useRef<HTMLIFrameElement>(null);
  // Each load of the frame's document, a moved frame's included, gets a fresh port.
  const [loads, setLoads] = useState(0);
  /** Mount the view again with the current theme, after any remount before it. */
  const remount = useRef<(() => void) | undefined>(undefined);
  const theme = useTheme();
  const failed = useRef(onFailed);
  failed.current = onFailed;
  const sized = useRef(onSize);
  sized.current = onSize;

  useEffect(() => {
    const element = frame.current;
    if (!loads || !element?.contentWindow) return;
    const view = { actor, module };
    const host = new FrameHost(
      openFrame(element.contentWindow as Parameters<typeof openFrame>[0]),
      {
        call: (slot, method, input) => api.call(slot, method, input, view),
        subscribe: (slot, event, send, end) => api.subscribe(slot, event, send, { view, end }),
        shell: {
          openExternal: (url) => void window.open(url, "_blank", "noopener,noreferrer"),
          signIn,
        },
        log: (level, message, fields) => viewLog(view, level, message, fields),
        size: (next) => sized.current?.(next),
      },
    );
    let live = true;
    const stops: (() => void)[] = [];
    void (async () => {
      const declared = Object.keys((await manifestOf(hash)).modules[module]?.slots ?? {});
      if (!live) return;
      // What the frame was told of each slot; until it loads, what to load it with.
      const known = new Map<string, boolean>();
      let loaded = false;
      // The gateway's watch: every slot bound now, at once and again after each reconnect, then
      // each change; bound again means its provider came back, so the frame is told that too.
      const first = new Promise<void>((resolve, ended) => {
        stops.push(
          api.watchSlots(
            view,
            (payload) => {
              const told = payload as { bound: string[] } | { slot: string; bound: boolean };
              const changes =
                "slot" in told
                  ? [[told.slot, told.bound] as const]
                  : declared
                      .map((slot) => [slot, told.bound.includes(slot)] as const)
                      .filter(([slot, bound]) => bound || known.get(slot) || !loaded);
              for (const [slot, bound] of changes) {
                known.set(slot, bound);
                if (loaded) host.slot(slot, bound);
              }
              resolve();
            },
            () => ended(new Error("The view's slots aren't watched.")),
          ),
        );
      });
      await first;
      const themed = document.documentElement.dataset.theme;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        (async () => {
          const loading = host.load({
            src: `${location.origin}/frames/${hash}/${module}.js`,
            actorId: actor,
            module,
            slots: Object.fromEntries(declared.map((slot) => [slot, known.get(slot) ?? false])),
          });
          // Sent: the frame holds what it's told while it loads.
          loaded = true;
          await loading;
          await host.mount(themeTokens(), sizeOf(element));
        })(),
        new Promise((_, failed) => {
          timer = setTimeout(() => failed(new Error("The view didn't load in time.")), LOAD_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      if (!live) return;
      let chain = Promise.resolve();
      let queued = false;
      remount.current = () => {
        // One waiting at most: it reads the theme when it runs, so it takes every switch so far.
        if (queued) return;
        queued = true;
        chain = chain
          .then(async () => {
            queued = false;
            await host.unmount();
            await host.mount(themeTokens(), sizeOf(element));
          })
          .catch(() => {});
      };
      // Switched while it loaded: mounted with the old theme, so again.
      if (document.documentElement.dataset.theme !== themed) remount.current();
      const observer = new ResizeObserver(() => void host.resize(sizeOf(element)).catch(() => {}));
      observer.observe(element);
      stops.push(() => observer.disconnect());
    })().catch(() => live && failed.current());
    return () => {
      live = false;
      remount.current = undefined;
      for (const stop of stops) stop();
      void host.unmount().catch(() => {});
      host.close();
    };
  }, [loads, actor, module, hash]);

  // A new theme: the view is mounted again with it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the theme is read from the document.
  useEffect(() => remount.current?.(), [theme]);

  return (
    <iframe
      ref={frame}
      className="frame"
      title={`${module} view`}
      sandbox="allow-scripts"
      style={height !== undefined ? { height } : undefined}
      src={`/frames/${hash}/${module}.html`}
      onLoad={() => setLoads((n) => n + 1)}
    />
  );
}
