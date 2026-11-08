/**
 * The kit's styles: the shell's own look, drawn in the theme's tokens (`--fg`, `--surface`,
 * `--accent`, …), which the shell defines and sends every view at mount. Every class is `kit-`.
 * They work without React too: a plain-DOM view may use the class names.
 */
export const KIT_CSS = `
.kit-button {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  height: 32px; padding: 0 12px; border: 0; border-radius: 9px; cursor: pointer;
  background: var(--hover); color: var(--fg); font: inherit; font-size: 13px; font-weight: 500;
}
.kit-button:hover { background: var(--selected); }
.kit-button.kit-primary { background: var(--accent); color: var(--accent-fg); font-weight: 600; }
.kit-button.kit-quiet { height: auto; padding: 0; background: none; color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.kit-button:disabled { opacity: 0.6; cursor: default; }
.kit-icon-button {
  width: 30px; height: 30px; padding: 0; border: 0; border-radius: 8px; cursor: pointer;
  display: grid; place-items: center; background: transparent; color: var(--muted);
}
.kit-icon-button:hover { background: var(--hover); color: var(--fg); }
.kit-icon-button:disabled { opacity: 0.4; cursor: default; }
.kit-switch {
  position: relative; flex: none; width: 30px; height: 18px; padding: 0; border: 0; border-radius: 9px;
  background: var(--raised); cursor: pointer;
}
.kit-switch[data-state="checked"] { background: var(--ok); }
.kit-switch:disabled { opacity: 0.5; cursor: default; }
.kit-switch-thumb {
  position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: var(--faint); transition: left 0.12s;
}
.kit-switch[data-state="checked"] .kit-switch-thumb { left: 14px; background: white; }
.kit-field, .kit-select {
  width: 100%; height: 38px; padding: 0 12px; border: 0; border-radius: 10px; outline: 0;
  background: var(--raised); color: var(--fg); font: inherit;
}
.kit-select { height: 32px; padding: 0 8px; border-radius: 8px; }
.kit-field:focus-visible, .kit-select:focus-visible, .kit-button:focus-visible, .kit-icon-button:focus-visible,
.kit-switch:focus-visible { outline: 0; box-shadow: 0 0 0 1.5px var(--ring); }
.kit-scrim { position: fixed; inset: 0; z-index: 20; background: rgb(0 0 0 / 0.5); }
.kit-dialog {
  position: fixed; left: 50%; top: 50%; z-index: 21; transform: translate(-50%, -50%);
  width: min(440px, calc(100% - 32px)); max-height: calc(100% - 32px); overflow: auto; scrollbar-width: none;
  display: flex; flex-direction: column; gap: 16px; padding: 20px; border-radius: 18px;
  background: var(--surface); color: var(--fg); box-shadow: 0 24px 60px rgb(0 0 0 / 0.45); outline: 0;
}
.kit-dialog-title { margin: 0; font-size: 16px; font-weight: 600; }
.kit-actions { display: flex; justify-content: flex-end; gap: 8px; }
.kit-menu {
  z-index: 30; min-width: 150px; padding: 4px; border-radius: 10px;
  background: var(--raised); color: var(--fg); box-shadow: 0 12px 28px rgb(0 0 0 / 0.35);
}
.kit-menu-item {
  display: block; width: 100%; padding: 7px 10px; border-radius: 7px; outline: 0; cursor: pointer;
  font-size: 13px; text-align: left; user-select: none;
}
.kit-menu-item[data-highlighted] { background: var(--hover); }
.kit-menu-item[data-disabled] { opacity: 0.6; cursor: default; }
.kit-tabs-list {
  display: inline-flex; align-self: flex-start; gap: 2px; padding: 3px; border-radius: 10px;
  background: var(--hover);
}
.kit-tab {
  padding: 5px 12px; border: 0; border-radius: 8px; cursor: pointer;
  background: transparent; color: var(--muted); font: inherit; font-size: 13px;
}
.kit-tab[data-state="active"] { background: var(--surface); color: var(--fg); font-weight: 600; box-shadow: 0 1px 2px rgb(0 0 0 / 0.2); }
.kit-card { padding: 14px; border-radius: 12px; background: var(--card); }
.kit-list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; font-size: 13px; }
.kit-list > li { display: flex; align-items: center; gap: 10px; padding: 7px 0; }
.kit-list > li + li { border-top: 1px solid var(--line); }
.kit-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.kit-table th { padding: 0 10px 8px; text-align: left; color: var(--faint); font-weight: 500; font-size: 12px; }
.kit-table td { padding: 9px 10px; border-top: 1px solid var(--line); vertical-align: middle; }
.kit-table tr:hover td { background: var(--hover); }
.kit-meter { display: flex; gap: 3px; }
.kit-meter > i { flex: 1; height: 4px; border-radius: 2px; background: var(--raised); }
.kit-meter > i.kit-on { background: var(--ok); }
.kit-stack { display: flex; flex-direction: column; gap: var(--kit-gap, 8px); min-height: 0; }
.kit-row { display: flex; align-items: center; gap: var(--kit-gap, 8px); min-width: 0; }
.kit-fill { flex: 1; min-width: 0; min-height: 0; }
.kit-scroll { overflow: auto; scrollbar-width: none; }
.kit-scroll::-webkit-scrollbar { display: none; }
.kit-resize-handle { position: relative; flex: none; width: 8px; margin: 0 -4px; z-index: 2; outline: 0; cursor: col-resize; touch-action: none; }
.kit-resize-handle::after {
  content: ""; position: absolute; left: 3px; top: 0; bottom: 0; width: 2px; border-radius: 1px; background: transparent;
}
.kit-resize-handle:hover::after, .kit-resize-handle:focus-visible::after, .kit-resize-handle[data-separator="active"]::after { background: var(--ring); }
/* While a handle is dragged, frames under the pointer take no events, so the drag keeps them all. */
:root:has(.kit-resize-handle[data-separator="active"]) iframe { pointer-events: none; }
.kit-md > :first-child { margin-top: 0; }
.kit-md > :last-child { margin-bottom: 0; }
.kit-md p { margin: 0 0 10px; }
.kit-md strong { font-weight: 650; }
.kit-md ul, .kit-md ol { display: block; margin: 0 0 10px; padding-left: 20px; list-style: revert; }
.kit-md li { display: list-item; margin: 3px 0; padding: 0; border-radius: 0; background: none; }
.kit-md code { padding: 1px 5px; border-radius: 5px; background: var(--raised); font: 12.5px ui-monospace, Menlo, monospace; }
.kit-md pre { margin: 0 0 10px; padding: 10px 12px; border-radius: 10px; background: var(--raised); overflow: auto; scrollbar-width: none; }
.kit-md pre code { padding: 0; background: none; }
.kit-md table { width: auto; min-width: 260px; margin: 2px 0 10px; border-collapse: collapse; font-size: 13px; }
.kit-md th { padding: 0 14px 6px 0; text-align: left; color: var(--faint); font-weight: 500; font-size: 12px; }
.kit-md td { padding: 6px 14px 6px 0; border-top: 1px solid var(--line); }
.kit-md a { color: inherit; text-underline-offset: 2px; }
.kit-chat { container-type: inline-size; display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--fg); }
.kit-chat-viewport { flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: none; padding: 8px 20px 0; }
.kit-chat-viewport::-webkit-scrollbar { display: none; }
.kit-chat-thread { display: flex; flex-direction: column; gap: 22px; max-width: 720px; margin: 0 auto; padding-bottom: 16px; }
.kit-chat-earlier { align-self: center; height: 28px; border: 0; background: none; color: var(--muted); font: inherit; font-size: 12.5px; cursor: pointer; }
.kit-chat-user { align-self: flex-end; max-width: 75%; padding: 9px 13px; border-radius: 16px; background: var(--raised); white-space: pre-wrap; word-break: break-word; }
.kit-chat-assistant { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.kit-chat-who { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12.5px; }
.kit-chat-bar { display: flex; gap: 2px; height: 26px; margin-top: -4px; }
.kit-chat-bar .kit-icon-button { width: 26px; height: 26px; border-radius: 7px; color: var(--faint); }
.kit-chat-bar[data-hidden], .kit-chat-assistant:not([data-last]):not(:hover) .kit-chat-bar { visibility: hidden; }
.kit-chat-thinking { display: flex; align-items: center; gap: 6px; height: 22px; color: var(--muted); }
.kit-chat-thinking > i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; animation: kit-pulse 1.2s infinite; }
.kit-chat-thinking > i:nth-child(2) { animation-delay: 0.2s; }
.kit-chat-thinking > i:nth-child(3) { animation-delay: 0.4s; }
@keyframes kit-pulse { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
.kit-chat-step { font-size: 12.5px; color: var(--muted); }
.kit-tool { border-radius: 12px; background: var(--hover); font-size: 13px; }
.kit-tool > button {
  display: flex; align-items: center; gap: 10px; width: 100%; height: 38px; padding: 0 12px;
  border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.kit-tool-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kit-tool-name { color: var(--muted); font: 12px ui-monospace, Menlo, monospace; }
.kit-tool-done { color: var(--ok); font-weight: 700; }
.kit-tool-refused { color: var(--bad); }
.kit-tool-chevron { color: var(--faint); transition: transform 0.12s; }
.kit-tool[data-open] .kit-tool-chevron { transform: rotate(90deg); }
.kit-tool-body { margin: 0; padding: 0 12px 10px 36px; color: var(--muted); font: 12px/1.5 ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-word; }
.kit-chat-notice { display: flex; flex-direction: column; gap: 6px; max-width: 720px; margin: 0 auto 10px; padding: 10px 12px; border-radius: 12px; background: var(--raised); font-size: 13px; }
.kit-chat-notice b { font-weight: 600; }
.kit-chat-composer-wrap { flex: none; padding: 0 20px 16px; }
.kit-chat-composer { display: flex; flex-direction: column; max-width: 720px; margin: 0 auto; padding: 10px 10px 8px 14px; border-radius: 14px; background: var(--raised); }
.kit-chat-input { display: block; width: 100%; min-height: 44px; max-height: 160px; padding: 0; border: 0; outline: 0; resize: none; background: transparent; color: inherit; font: inherit; scrollbar-width: none; }
.kit-chat-composer-row { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 12px; }
.kit-chat-send {
  width: 30px; height: 30px; margin-left: auto; padding: 0; border: 0; border-radius: 50%; cursor: pointer;
  display: grid; place-items: center; background: var(--accent); color: var(--accent-fg);
}
.kit-chat-send:disabled { opacity: 0.35; cursor: default; }
@container (max-width: 460px) {
  .kit-chat-viewport { padding: 6px 12px 0; }
  .kit-chat-thread { gap: 14px; }
  .kit-chat-user { max-width: 88%; padding: 7px 11px; }
  .kit-chat-who, .kit-tool-name { display: none; }
  .kit-chat-composer-wrap { padding: 0 10px 10px; }
  .kit-chat-composer { padding: 8px 8px 6px 12px; border-radius: 12px; }
  .kit-chat-input { min-height: 34px; }
}
`;

const MARK = "data-agentorg-kit";

/**
 * Put the kit's styles in a document once, first in its head so a view's own come after and win.
 * Importing the kit does it for the document it runs in; a document that has them is left alone.
 */
export function ensureKitStyles(doc: Document | undefined = globalThis.document): void {
  if (!doc?.head || doc.head.querySelector(`style[${MARK}]`)) return;
  const style = doc.createElement("style");
  style.setAttribute(MARK, "");
  style.textContent = KIT_CSS;
  doc.head.prepend(style);
}
