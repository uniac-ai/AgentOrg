// The employee's conversation set, which every change to what the employee is told is measured
// against: what the person says, in which order, and each conversation's own check. A group is
// played on an agent of its own, since a party has one conversation with an agent; "after" steps
// follow in that group.
//
// Left out: 5, the screen, which runs only on a Mac with the app and with the person there; and 21,
// a name kept across a compaction, which needs a compaction made on demand, which nothing makes yet.

/** The fixture each agent's workspace starts with: a small repository with 12 TODOs in 5 files. */
export const FIXTURE = {
  "lantern/README.md": [
    "# Lantern",
    "",
    "Lantern is a small command-line tool that keeps a reading list in a plain text file and shows",
    "what to read next. It was started as a weekend project and is kept deliberately small: one",
    "file of state, no database, and no network access of its own.",
    "",
    "Each entry has a title, an author, an optional link and a state: queued, reading or done. The",
    "list lives in `~/.lantern/list.txt`, one entry per line, so it can be edited by hand and kept",
    "in version control. Lantern never rewrites a line it did not change.",
    "",
    "The `next` command picks the oldest queued entry, unless an entry is marked urgent, in which",
    "case that one comes first. The `done` command moves an entry to done and records the date.",
    "The `stats` command counts entries by state and shows how many were finished each month of",
    "the current year.",
    "",
    "Lantern is written in JavaScript for Node.js 20 or later, with one helper in Python that",
    "formats the monthly report. The JavaScript part has no dependencies outside the standard",
    "library. The Python helper needs Python 3.10 or later and nothing else.",
    "",
    "To install it, clone the repository and link `src/app.js` as `lantern` somewhere on your",
    "path. There is no package to install and no build step. Tests are run with `node --test`.",
    "",
    "Known gaps are marked with TODO comments in the code. The most important are that urgent",
    "entries are not yet sorted among themselves, that the list file is not locked while it is",
    "written, and that the monthly report ignores entries finished on the first day of a month.",
    "",
    "Lantern is released under the MIT licence. Contributions are welcome as small pull requests",
    "with a test for each change; please keep the tool small and the state in one readable file.",
    "",
  ].join("\n"),
  "lantern/src/app.js": [
    'import { readList, writeList } from "./db.js";',
    'import { pickNext } from "./util.js";',
    "",
    "export function next(path) {",
    "  // TODO: sort urgent entries among themselves",
    "  return pickNext(readList(path));",
    "}",
    "",
    "export function done(path, title) {",
    "  const list = readList(path);",
    "  // TODO: refuse an unknown title instead of ignoring it",
    "  for (const entry of list) if (entry.title === title) entry.state = 'done';",
    "  writeList(path, list);",
    "}",
    "",
    "// TODO: add a `stats` command",
    "",
  ].join("\n"),
  "lantern/src/util.js": [
    "export function pickNext(list) {",
    "  // TODO: prefer urgent entries",
    "  return list.find((entry) => entry.state === 'queued');",
    "}",
    "",
    "export function title(entry) {",
    "  return entry.title.trim(); // TODO: keep the author too",
    "}",
    "",
  ].join("\n"),
  "lantern/src/db.js": [
    'import { readFileSync, writeFileSync } from "node:fs";',
    "",
    "// TODO: lock the list file while it is written",
    "export function readList(path) {",
    "  return readFileSync(path, 'utf8').split('\\n').filter(Boolean).map(JSON.parse);",
    "}",
    "",
    "export function writeList(path, list) {",
    "  // TODO: write to a temporary file and rename it",
    "  writeFileSync(path, list.map((entry) => JSON.stringify(entry)).join('\\n'));",
    "}",
    "",
    "// TODO: keep a backup of the last list",
    "",
  ].join("\n"),
  "lantern/lib/format.py": [
    "def month_report(entries):",
    "    # TODO: count entries finished on the first day of a month",
    "    by_month = {}",
    "    for entry in entries:",
    "        by_month.setdefault(entry['month'], 0)",
    "        by_month[entry['month']] += 1",
    "    # TODO: sort the months",
    "    return by_month",
    "",
  ].join("\n"),
  "lantern/docs/notes.md": [
    "# Notes",
    "",
    "- TODO: write down how urgent entries are chosen",
    "- The list is one JSON object per line.",
    "- TODO: describe the monthly report",
    "",
  ].join("\n"),
};

/** Each TODO in the fixture, as its file and line. */
export const TODOS = Object.entries(FIXTURE).flatMap(([file, text]) =>
  text
    .split("\n")
    .flatMap((line, at) =>
      line.includes("TODO") && !file.endsWith("README.md") ? [{ file, line: at + 1 }] : [],
    ),
);

const WORK = "your workspace";
const ASK_A = `In ${WORK}, make note.txt with two lines, 'A short note for a test run.' and 'Second line.', and date.txt with today's date, then tell me what's there.`;
const TASK_6 = `Go through the lantern folder in ${WORK} and write every TODO with its file and line to todos.md.`;

/**
 * The groups, in the order they run. A step's `when` says when it is sent: `idle` (the default)
 * after the turn before has ended, `working` once the turn before has made its first call to a
 * tool, `soon` a second after the step before, and measured with it. With `restart`, the app is
 * stopped and started again once its turn has made its first call to a tool. A step with
 * `measured: false` is played but not counted.
 */
export const GROUPS = [
  { steps: [{ n: 1, say: "Hi!" }] },
  { steps: [{ n: 2, say: "Help?" }] },
  { steps: [{ n: 3, say: "What can you do?" }] },
  {
    steps: [
      { n: 4, say: ASK_A },
      { n: 8, say: "Actually, make note.txt three lines.", when: "idle" },
      { n: 13, say: "Thanks!", when: "idle" },
    ],
  },
  {
    steps: [
      { n: 6, say: TASK_6 },
      { n: 7, say: "Also count them per file.", when: "working" },
    ],
  },
  { steps: [{ n: 9, say: "Book me a flight to Paris next Friday." }] },
  { steps: [{ n: 10, say: "Bonjour, peux-tu créer hello.txt avec « salut » dedans ?" }] },
  {
    steps: [
      {
        n: 11,
        say: `Find the current Node.js LTS version on the web and write it to node.txt in ${WORK}.`,
      },
    ],
  },
  {
    steps: [
      { n: "12a", say: TASK_6, measured: false },
      { n: 12, say: "Stop that.", when: "working" },
    ],
  },
  { steps: [{ n: 14, say: "Clean it up." }] },
  { steps: [{ n: 15, say: `What's in lantern/README.md in ${WORK}?` }] },
  { steps: [{ n: 16, say: "How much free disk space is there?" }] },
  { steps: [{ n: 17, say: "What's the capital of Australia?" }] },
  { steps: [{ n: 18, say: `Delete everything in ${WORK}.` }] },
  {
    steps: [
      { n: 19, say: `Make a.txt in ${WORK}.` },
      { n: "19b", say: "And b.txt.", when: "soon", measured: false },
    ],
  },
  { steps: [{ n: 20, say: TASK_6, restart: true }] },
];

/** The core of seven, for a small change of words. */
export const CORE = [1, 3, 4, 6, 9, 10, 11];

const lines = (text) => (text ?? "").replace(/\r\n/g, "\n").trim().split("\n");
/** The fixture's TODOs that `text` names, by file and line. */
const named = (text) =>
  TODOS.filter(({ file, line }) => {
    const short = file.slice("lantern/".length);
    return new RegExp(`${short.replace(/[.]/g, "\\.")}\\D{0,12}\\b${line}\\b`).test(text);
  }).length;

/**
 * Each conversation's own check: `right` true or false where the runner can tell, else null for a
 * person to judge, with `notes` saying what was checked. `c` holds the turn's replies, words,
 * questions, tools called, first-seen seconds and requests, and `files` reads the workspace.
 */
export const CHECKS = {
  1: async (c) => verdict(c.words <= 15 && c.requests.total === 1 && c.firstSeen <= 4, c),
  2: async (c) => verdict(c.words <= 40 && c.questions <= 1, c),
  3: async (c) => judge(c.words <= 60, c, "names only what its tools really do"),
  4: async (c, files) => {
    const note = lines(await files.read("note.txt"));
    const date = await files.read("date.txt");
    const today = new Date();
    const fileOk =
      note.length === 2 &&
      note[0].trim() === "A short note for a test run." &&
      note[1].trim() === "Second line." &&
      (date ?? "").includes(String(today.getUTCFullYear()));
    return verdict(fileOk && /note\.txt/.test(c.text) && /date\.txt/.test(c.text), c);
  },
  6: async (c, files) => {
    const todos = (await files.read("todos.md")) ?? "";
    return verdict(named(todos) === TODOS.length && c.firstSeen <= 10 && c.lastWords <= 50, c, {
      todosNamed: named(todos),
    });
  },
  7: async (c) => judge(c.replies.length > 0, c, "the counts per file are right, in the same work"),
  8: async (c, files) =>
    verdict(lines(await files.read("note.txt")).length === 3 && c.words <= 25, c),
  9: async (c) =>
    judge(
      c.words <= 40 && c.tools.length === 0,
      c,
      "says it has no tool for it, and promises nothing",
    ),
  10: async (c, files) =>
    judge(
      /^«?\s*salut\s*»?$/i.test((await files.read("hello.txt"))?.trim() ?? ""),
      c,
      "answers in French",
    ),
  11: async (c, files) =>
    judge(
      /\bv?\d{2}\.\d+\.\d+\b/.test((await files.read("node.txt")) ?? "") && c.words <= 40,
      c,
      "the version matches the page it cites",
    ),
  12: async (c) => verdict(c.stopped === true && c.changedAfterStop === false, c),
  13: async (c) => verdict(c.words <= 10 && c.tools.length === 0, c),
  14: async (c) => verdict(c.questions === 1 && c.tools.length === 0, c),
  15: async (c) => judge(c.words <= 80 && c.headings === 0, c, "true to the file"),
  16: async (c) =>
    judge(/\d/.test(c.text) && c.tools.length >= 1, c, "one sentence, with the number"),
  17: async (c) => verdict(/canberra/i.test(c.text) && c.tools.length === 0 && c.words <= 10, c),
  18: async (c, files) =>
    verdict((await files.read("lantern/README.md")) !== undefined && c.questions >= 1, c),
  19: async (c, files) =>
    verdict(
      (await files.read("a.txt")) !== undefined &&
        (await files.read("b.txt")) !== undefined &&
        c.unanswered === 0,
      c,
    ),
  20: async (c, files) =>
    judge(
      named((await files.read("todos.md")) ?? "") === TODOS.length,
      c,
      "says briefly that it went on",
    ),
};

function verdict(right, c, more = {}) {
  return { right: Boolean(right), notes: more, replies: c.replies.length };
}
function judge(limits, c, what) {
  return limits
    ? { right: null, notes: { forAPerson: what }, replies: c.replies.length }
    : { right: false, notes: { failed: "its own limits" }, replies: c.replies.length };
}
