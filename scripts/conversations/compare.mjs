#!/usr/bin/env node
// Sets runs of the conversation set side by side, conversation by conversation, as one page.
//
//   node scripts/conversations/compare.mjs --before A.json B.json --after C.json D.json --out page.html
//
// A measure counts as changed only when both runs after are on the same side of both runs before:
// the model answers differently from run to run. Each reply is there to read, folded.
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const after = args.indexOf("--after");
const out = args.indexOf("--out");
const before = args.slice(args.indexOf("--before") + 1, after);
const later = args.slice(after + 1, out < 0 ? undefined : out);
if (args.indexOf("--before") < 0 || after < 0 || out < 0 || !before.length || !later.length) {
  console.error(
    "Usage: compare.mjs --before A.json [B.json] --after C.json [D.json] --out page.html",
  );
  process.exit(2);
}
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const runs = { before: before.map(read), after: later.map(read) };

/** The measures, each as read from one conversation, and which way is better. */
const MEASURES = [
  ["First seen, s", (c) => c.seconds.firstSeen, "lower"],
  ["Final reply, s", (c) => c.seconds.finalReply, "lower"],
  ["Idle, s", (c) => c.seconds.idle, "lower"],
  ["Words", (c) => c.words.total, "lower"],
  ["Longest reply, words", (c) => c.words.longest, "lower"],
  ["Reads as a message", (c) => (c.form.message ? 1 : 0), "higher"],
  ["Model requests", (c) => c.requests.total, "lower"],
  ["Input tokens", (c) => c.requests.input, "lower"],
  // Of them, read from the provider's cache; a run from before it was recorded has none.
  ["Cached input tokens", (c) => c.requests.cached, "higher"],
  ["Right", (c) => (c.right === null ? undefined : c.right ? 1 : 0), "higher"],
];

const numbers = [
  ...new Set(
    [...runs.before, ...runs.after].flatMap((run) => run.conversations.map((c) => String(c.n))),
  ),
].sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
const find = (run, n) => run.conversations.find((c) => String(c.n) === n);

/** Changed only when both after are on one side of both before: "better", "worse", or "". */
function change(beforeValues, afterValues, better) {
  const b = beforeValues.filter((v) => typeof v === "number");
  const a = afterValues.filter((v) => typeof v === "number");
  if (!b.length || !a.length) return "";
  const lower = Math.max(...a) < Math.min(...b);
  const higher = Math.min(...a) > Math.max(...b);
  if (!lower && !higher) return "";
  return (lower && better === "lower") || (higher && better === "higher") ? "better" : "worse";
}

const html = (text) =>
  String(text ?? "").replace(
    /[&<>"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch],
  );
const cell = (value) => (value === undefined ? "–" : html(value));

const sections = numbers.map((n) => {
  const said = (find(runs.before[0], n) ?? find(runs.after[0], n))?.said ?? "";
  const rows = MEASURES.map(([name, of, better]) => {
    const b = runs.before.map((run) => (find(run, n) ? of(find(run, n)) : undefined));
    const a = runs.after.map((run) => (find(run, n) ? of(find(run, n)) : undefined));
    const changed = change(b, a, better);
    return `<tr class="${changed}"><th>${name}</th>${b.map((v) => `<td>${cell(v)}</td>`).join("")}${a
      .map((v) => `<td>${cell(v)}</td>`)
      .join("")}<td>${changed}</td></tr>`;
  }).join("\n");
  const replies = [
    ...runs.before.map((run, i) => [`Before ${i + 1}`, run]),
    ...runs.after.map((run, i) => [`After ${i + 1}`, run]),
  ]
    .map(([label, run]) => {
      const c = find(run, n);
      if (!c) return "";
      const texts =
        c.replies.map((r) => `<pre>${html(r.text)}</pre>`).join("") || "<p>No reply.</p>";
      return `<details><summary>${label}: ${c.replies.length} replies, right ${
        c.right === null ? "for a person" : c.right ? "yes" : "no"
      }</summary>${texts}</details>`;
    })
    .join("");
  return `<section><h2>${html(n)}: ${html(said)}</h2>
<table><tr><th></th>${runs.before.map((_, i) => `<th>Before ${i + 1}</th>`).join("")}${runs.after
    .map((_, i) => `<th>After ${i + 1}</th>`)
    .join("")}<th>Changed</th></tr>
${rows}</table>${replies}</section>`;
});

const totals = (run) =>
  `${run.requests.total} requests (front desk ${run.requests.frontDesk}), ${run.requests.input} input tokens${run.requests.cached === undefined ? "" : ` (${run.requests.cached} cached)`}, at ${html(run.head.slice(0, 7))}${run.dry ? ", dry" : ""}`;
const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conversation runs</title>
<style>
body { font: 14px/1.45 system-ui, sans-serif; margin: 24px; color: #1a1a1a; background: #fff; }
table { border-collapse: collapse; margin: 8px 0; } th, td { padding: 4px 10px; border-bottom: 1px solid #e5e5e5; text-align: right; }
th:first-child { text-align: left; font-weight: normal; color: #555; }
tr.better td:last-child { color: #11743c; } tr.worse td:last-child { color: #b42318; }
pre { white-space: pre-wrap; background: #f6f6f6; padding: 8px; border-radius: 6px; }
section { margin-bottom: 28px; } h2 { font-size: 15px; }
</style>
<h1>Conversation runs</h1>
<ul>${runs.before.map((run, i) => `<li>Before ${i + 1}: ${totals(run)}</li>`).join("")}${runs.after
  .map((run, i) => `<li>After ${i + 1}: ${totals(run)}</li>`)
  .join("")}</ul>
<p>A measure is marked changed only when both runs after are on the same side of both runs before.</p>
${sections.join("\n")}`;
writeFileSync(args[out + 1], page);
console.log(args[out + 1]);
