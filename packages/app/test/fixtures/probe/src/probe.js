import { uiShell, uiView } from "@agentorg/interfaces";
import { defineWidget } from "@agentorg/sdk";

/** Try one thing a view's frame must not reach; what happened, in a word. */
async function attempt(what) {
  try {
    const reached = await what();
    return `reached: ${String(reached).slice(0, 60)}`;
  } catch (error) {
    return `blocked: ${error?.name ?? "Error"}`;
  }
}

export default defineWidget({
  slots: { shell: uiShell },
  exports: { view: uiView },
  start(ctx) {
    ctx.exports.view.implement({
      mount(el) {
        void (async () => {
          const results = {
            // The frame's security origin, not its address's.
            origin: globalThis.origin,
            parentDom: await attempt(() => globalThis.parent.document.title),
            cookie: await attempt(() => globalThis.document.cookie),
            localStorage: await attempt(() => globalThis.localStorage.getItem("x")),
            // no-cors: only the frame's policy can refuse these, not the server's CORS answer.
            fetchGateway: await attempt(() => fetch("/", { mode: "no-cors" }).then((r) => r.type)),
            fetchOutside: await attempt(() =>
              fetch("https://example.com/", { mode: "no-cors" }).then((r) => r.type),
            ),
            xhr: await attempt(
              () =>
                new Promise((done, failed) => {
                  const request = new XMLHttpRequest();
                  request.open("GET", "/");
                  request.onload = () => done(request.status);
                  request.onerror = () => failed(new TypeError("xhr"));
                  request.send();
                }),
            ),
            openWindow: await attempt(() => {
              const opened = globalThis.open("https://example.com/");
              if (!opened) throw new Error("no window");
              return "a window";
            }),
            shellHttp: await attempt(() =>
              ctx.slots.shell.call.openExternal({ url: "http://example.com/" }),
            ),
          };
          ctx.log.info("probe", results);
          el.textContent = "probed";
        })();
      },
    });
  },
});
