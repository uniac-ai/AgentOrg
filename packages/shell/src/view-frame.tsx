import { FrameHost, openFrame } from "@agentorg/sdk/frame/host";
import { useEffect, useRef, useState } from "react";
import type { View } from "./api.ts";
import { api, type Binding, manifestOf, themeTokens, useConnection, useTheme } from "./data.ts";
import { viewLog } from "./rules.ts";
import { signIn } from "./sign-in.ts";

/** Which of a view's slots are bound: its module's slots against the Actor's `module.slot` bindings. */
async function slotsOf(view: View, hash: string): Promise<Record<string, boolean>> {
  const [manifest, { bindings }] = await Promise.all([
    manifestOf(hash),
    api.call<{ bindings: Binding[] }>("bindings", "list", { actor: view.actor }),
  ]);
  const bound = new Set(
    bindings.filter((binding) => binding.consumer === view.actor).map((binding) => binding.slot),
  );
  const slots = manifest.modules[view.module]?.slots ?? {};
  return Object.fromEntries(
    Object.keys(slots).map((slot) => [slot, bound.has(`${view.module}.${slot}`)]),
  );
}

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
export function ViewFrame({ actor, module, hash }: View & { hash: string }) {
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
    <Frame key={key} actor={actor} module={module} hash={hash} onFailed={() => setFailed(key)} />
  );
}

function Frame({ actor, module, hash, onFailed }: View & { hash: string; onFailed(): void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  // Each load of the frame's document, a moved frame's included, gets a fresh port.
  const [loads, setLoads] = useState(0);
  /** Mount the view again with the current theme, after any remount before it. */
  const remount = useRef<(() => void) | undefined>(undefined);
  const theme = useTheme();
  const failed = useRef(onFailed);
  failed.current = onFailed;

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
      },
    );
    let live = true;
    const stops: (() => void)[] = [];
    void (async () => {
      let known = await slotsOf(view, hash);
      const themed = document.documentElement.dataset.theme;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        (async () => {
          await host.load({
            src: `${location.origin}/frames/${hash}/${module}.js`,
            actorId: actor,
            module,
            slots: known,
          });
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
      // A slot bound or unbound since: the frame is told each change.
      const recheck = () =>
        void slotsOf(view, hash).then(
          (next) => {
            for (const [slot, bound] of Object.entries(next))
              if (known[slot] !== bound) host.slot(slot, bound);
            known = next;
          },
          () => {},
        );
      stops.push(api.subscribe("exports", "changed", recheck));
      stops.push(api.subscribe("grants", "decided", recheck));
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
      src={`/frames/${hash}/${module}.html`}
      onLoad={() => setLoads((n) => n + 1)}
    />
  );
}
