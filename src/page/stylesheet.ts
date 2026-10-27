/**
 * The decisions page's one stylesheet, inlined into every page and admitted by the
 * Content-Security-Policy through its hash. Light and dark follow `prefers-color-scheme`.
 */

import { createHash } from "node:crypto";

export const STYLESHEET = `
:root {
  color-scheme: light dark;
  --bg: #f5f5f2;
  --surface: #ffffff;
  --text: #1c1c1a;
  --muted: #5d5d57;
  --border: #d9d9d2;
  --accent: #2b55c9;
  --accent-text: #ffffff;
  --accent-soft: #e6ecfb;
  --rec: #1d6e46;
  --rec-soft: #e2f2e9;
  --waiting: #8a5a00;
  --waiting-soft: #fbf0d9;
  --blocked: #b3261e;
  --blocked-soft: #fbe5e3;
  --radius: 8px;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131312;
    --surface: #1d1d1b;
    --text: #ecece8;
    --muted: #a6a69e;
    --border: #3a3a33;
    --accent: #8aa6f7;
    --accent-text: #0e0e0d;
    --accent-soft: #232c45;
    --rec: #6fcf9a;
    --rec-soft: #1c3327;
    --waiting: #e9b85a;
    --waiting-soft: #3a2e16;
    --blocked: #f28b82;
    --blocked-soft: #3d1f1d;
  }
}

*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.5 var(--font);
  overflow-wrap: anywhere;
}

a { color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
code { font-family: var(--mono); font-size: 0.9em; }
blockquote { margin: 4px 0 0; color: var(--muted); }

.top, main { max-width: 760px; margin: 0 auto; padding: 0 16px; }
.top { padding-top: 20px; }
.top h1 { margin: 0; font-size: 0.875rem; font-weight: 600; color: var(--muted); }
.top a { color: inherit; text-decoration: none; }
main { padding-bottom: 48px; }

.section-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 20px 0 12px;
  font-size: 1.5rem;
  line-height: 1.25;
}
.count { font-size: 1rem; color: var(--muted); }
.subsection-title { margin: 24px 0 8px; font-size: 1.0625rem; line-height: 1.35; }

.card {
  margin: 0 0 12px;
  padding: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.card-title { margin: 0; font-size: 1rem; line-height: 1.4; }
.meta { margin: 2px 0 0; font-size: 0.875rem; color: var(--muted); }
.context { margin: 10px 0 0; }
.body { margin: 8px 0 0; white-space: pre-wrap; }

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
}

.badge {
  display: inline-block;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.6;
  white-space: nowrap;
}
.recommended { margin-left: 6px; vertical-align: 1px; color: var(--rec); background: var(--rec-soft); }
.state-waiting { color: var(--waiting); background: var(--waiting-soft); }
.state-review, .state-running, .kind { color: var(--accent); background: var(--accent-soft); }
.state-blocked { color: var(--blocked); background: var(--blocked-soft); }
.state-pending, .state-closed { color: var(--muted); box-shadow: inset 0 0 0 1px var(--border); }

.chain {
  margin: 10px 0 0;
  padding: 8px 12px;
  list-style: none;
  font-size: 0.875rem;
  background: var(--bg);
  border-left: 3px solid var(--border);
  border-radius: 0 var(--radius) var(--radius) 0;
}
.chain .chain { margin-top: 6px; }
.chain-ask { display: block; color: var(--muted); }

.options { display: grid; gap: 8px; margin: 14px 0 0; padding: 0; border: 0; }
.option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
}
.option:hover { border-color: var(--accent); }
.option:has(input:checked) { background: var(--accent-soft); border-color: var(--accent); }
.option input { flex: none; width: 18px; height: 18px; margin: 3px 0 0; accent-color: var(--accent); }
.option-label { font-weight: 600; }
.option-detail { display: block; font-size: 0.875rem; color: var(--muted); }

.note { display: block; margin: 12px 0 0; }
.note span { display: block; margin-bottom: 4px; font-size: 0.875rem; color: var(--muted); }
.note textarea {
  display: block;
  width: 100%;
  min-height: 2.75rem;
  padding: 8px 10px;
  font: inherit;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  resize: vertical;
}

.step-in, .warning {
  margin: 14px 0 0;
  padding: 8px 12px;
  font-size: 0.875rem;
  color: var(--waiting);
  background: var(--waiting-soft);
  border-radius: var(--radius);
}
.refusal { margin: 12px 0 0; font-weight: 600; color: var(--blocked); }
.outcome { margin: 10px 0 0; font-weight: 600; }

.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 12px 0 0; }
.send, .button {
  display: inline-block;
  min-height: 44px;
  padding: 10px 18px;
  font: inherit;
  font-weight: 600;
  line-height: 1.5;
  text-decoration: none;
  color: var(--accent-text);
  background: var(--accent);
  border: 0;
  border-radius: var(--radius);
  cursor: pointer;
}
.send { margin: 12px 0 0; }
.button.secondary, .button.danger { color: var(--text); background: transparent; box-shadow: inset 0 0 0 1px var(--border); }
.danger.send, .button.danger.confirm { color: #ffffff; background: var(--blocked); box-shadow: none; }

.settled {
  margin: 16px 0;
  padding: 12px 16px;
  border: 1px solid var(--rec);
  border-radius: var(--radius);
  background: var(--rec-soft);
}
.settled p { margin: 0; }

.empty {
  margin: 0 0 12px;
  padding: 24px 16px;
  text-align: center;
  color: var(--muted);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
}

.tree, .tree ul { margin: 0; padding: 0; list-style: none; }
.tree ul { margin-left: 10px; padding-left: 12px; border-left: 1px solid var(--border); }
.agent { margin: 0 0 8px; padding: 12px 14px; }
.agent-title { font-weight: 600; }
.waiting-on { margin: 4px 0 0; font-size: 0.875rem; font-weight: 600; color: var(--waiting); }
.summary { margin: 6px 0 0; white-space: pre-wrap; }

.purpose { margin: 0; color: var(--muted); }
.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 12px 0 0;
  font-size: 0.875rem;
}
.facts dt { color: var(--muted); }
.facts dd { margin: 0; min-width: 0; }
.links { margin: 0; padding: 0; list-style: none; }

.sessions { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
.sessions th, .sessions td {
  padding: 6px 8px 6px 0;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--border);
}
.sessions th { font-weight: 600; color: var(--muted); }

@media (max-width: 480px) {
  .facts { grid-template-columns: 1fr; gap: 0; }
  .facts dd + dt { margin-top: 6px; }
  .send { width: 100%; }
}
`;

/** The CSP source that admits this stylesheet and no other. */
export const STYLESHEET_SOURCE = `'sha256-${createHash("sha256").update(STYLESHEET).digest("base64")}'`;
