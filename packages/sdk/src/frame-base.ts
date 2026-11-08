/**
 * The base stylesheet every view's frame gets first, before the view's own: the document fills the
 * frame on a transparent background, and plain HTML looks like the shell, drawn with the theme's
 * tokens (`--fg`, `--surface`, `--accent`, … as the shell sends them at mount). Every rule is in
 * `:where()`, so it has no specificity: any selector a view writes wins, and a view that wants its
 * own look draws it.
 */
export const FRAME_BASE = `
:where(*, *::before, *::after) { box-sizing: border-box; }
:where(html, body) { height: 100%; margin: 0; background: transparent; }
:where(body) {
  overflow: auto; scrollbar-width: none;
  color: var(--fg); font: 14px/1.45 var(--font, ui-sans-serif, system-ui, sans-serif);
  -webkit-font-smoothing: antialiased;
}
:where(body)::-webkit-scrollbar { display: none; }
:where(body > :only-child) { min-height: 100%; }
:where(h1, h2, h3, h4) { margin: 0 0 8px; font-weight: 600; letter-spacing: -0.01em; }
:where(h1) { font-size: 20px; }
:where(h2) { font-size: 16px; }
:where(h3, h4) { font-size: 14px; }
:where(p) { margin: 0 0 8px; }
:where(small) { color: var(--muted); font-size: 12.5px; }
:where(a) { color: inherit; text-underline-offset: 2px; }
:where(hr) { border: 0; border-top: 1px solid var(--line); margin: 10px 0; }
:where(ul, ol) { margin: 0 0 10px; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
:where(li) { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 10px; background: var(--raised); }
:where(button) {
  height: 34px; padding: 0 12px; border: 0; border-radius: 9px; cursor: pointer;
  background: var(--hover); color: var(--fg); font: inherit; font-weight: 500;
}
:where(button:hover) { background: var(--selected); }
:where(button:disabled) { opacity: 0.5; cursor: default; }
:where(button[type="submit"], button.primary) { background: var(--accent); color: var(--accent-fg); font-weight: 600; }
:where(input:not([type]), input[type="text"], input[type="search"], input[type="number"], input[type="url"], input[type="email"], select) {
  height: 34px; padding: 0 10px; border: 0; border-radius: 9px; outline: 0;
  background: var(--raised); color: var(--fg); font: inherit;
}
:where(textarea) { padding: 8px 10px; border: 0; border-radius: 9px; outline: 0; resize: none; background: var(--raised); color: var(--fg); font: inherit; }
:where(input:focus-visible, textarea:focus-visible, select:focus-visible, button:focus-visible) { box-shadow: 0 0 0 1.5px var(--ring); outline: 0; }
:where(input[type="checkbox"]) {
  appearance: none; width: 16px; height: 16px; margin: 0; flex: none; display: grid; place-items: center;
  border: 1.5px solid var(--faint); border-radius: 5px; cursor: pointer;
}
:where(input[type="checkbox"]:checked) { background: var(--ok); border-color: var(--ok); }
:where(input[type="checkbox"]:checked)::after {
  content: ""; width: 4px; height: 8px; border: solid white; border-width: 0 2px 2px 0;
  transform: translateY(-1px) rotate(45deg);
}
:where(li:has(> input[type="checkbox"]:checked) > span) { color: var(--faint); text-decoration: line-through; }
:where(form) { display: flex; gap: 6px; }
:where(form > input, form > textarea) { flex: 1; min-width: 0; }
:where(table) { width: 100%; border-collapse: collapse; font-size: 13px; }
:where(th) { padding: 0 8px 6px; text-align: left; color: var(--faint); font-weight: 500; font-size: 12px; }
:where(td) { padding: 7px 8px; border-top: 1px solid var(--line); }
:where(code, pre) { font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
:where(code) { padding: 1px 5px; border-radius: 5px; background: var(--raised); }
:where(pre) { margin: 0 0 10px; padding: 10px 12px; border-radius: 10px; background: var(--raised); overflow: auto; }
:where(pre code) { padding: 0; background: none; }
:where(progress) { appearance: none; width: 100%; height: 4px; border: 0; border-radius: 2px; background: var(--raised); }
:where(progress)::-webkit-progress-bar { background: var(--raised); border-radius: 2px; }
:where(progress)::-webkit-progress-value { background: var(--ok); border-radius: 2px; }
:where(progress)::-moz-progress-bar { background: var(--ok); border-radius: 2px; }
`;
