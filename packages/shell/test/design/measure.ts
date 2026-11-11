// Measures the shell as built against its design, with one probe run on both, and prints every
// difference. The design is a self-contained page of the same parts with sample data. It also
// lists the controls and marks seen in each region: the built side may lack one the design has,
// which is printed and passes, and fails when it shows one the design doesn't.
//
//   node --experimental-strip-types test/design/measure.ts <design.html> <out.json>
//
// Build the shell first: the built side is served by the stand-in gateway. A part added to the
// shell adds its probe and its screens here, and its screens to pairs.ts.
import { writeFileSync } from "node:fs";
import { chromium, type Page } from "@playwright/test";
import { SESSION, standIn } from "../stand-in.ts";
import {
  ASKED,
  ASKS,
  closeEveryTab,
  computerWith,
  inDesign,
  noted,
  readChat,
  sampleChats,
  startTerminals,
  unreadReply,
} from "./samples.ts";

const [design, out] = process.argv.slice(2);
if (!design || !out) throw new Error("usage: measure.ts <design.html> <out.json>");

/** What is measured of one element. A width or height that isn't the part's own says "fills". */
interface Measured {
  box: (number | string)[];
  font: string;
  color: string;
  bg: string;
  radius: string;
  shadow: string;
  opacity: string;
  filter: string;
  motion: string;
  pad: string;
  gap: string;
}
type Parts = Record<string, Measured | string | number | null>;
/** What a probe measures: the frame, one window's own rows, the chat in its layer, or Home. */
type Part = "frame" | "terminal" | "browser" | "chat" | "thread" | "home";
type Gateway = Awaited<ReturnType<typeof standIn>>;

/**
 * Runs in the page. `frame` measures the left bar, a drawer if one is open, the phone's head and
 * the page area, from the shell's top left. `terminal` and `browser` measure those windows' own
 * rows, from the window's top left. `chat` measures the collapsed chat and its panel, from the
 * shell's top left. A window is also measured in the cases the design draws for it: what was
 * typed refused, its view closed, only watched, no tab, and the page asking. `home` measures
 * Home's two sections, from the shell's top left. `thread` measures one chat, a chat about to be started, and the chats the bar's
 * search finds, from the shell's top left. Each also lists the controls and marks seen in its regions: the bar, a
 * drawer, the phone's head, a window, the collapsed chat and its panel, and Home. The page
 * area is not listed on a page that isn't the design's yet.
 */
const probe = (what: Part): Parts => {
  const seen = (e: Element | null | undefined): e is HTMLElement =>
    !!e && (e as HTMLElement).getClientRects().length > 0;
  const round = (n: number) => Math.round(n * 100) / 100;
  let origin = new DOMRect();
  const of = (e: Element | null | undefined, fills = "") => {
    if (!seen(e)) return null;
    const s = getComputedStyle(e);
    const moves = s.animationName !== "none";
    // What turns or fades is measured at rest: its box and opacity change as it moves.
    const was = e.style.animation;
    if (moves) e.style.animation = "none";
    const b = e.getBoundingClientRect();
    const opacity = getComputedStyle(e).opacity;
    if (moves) e.style.animation = was;
    return {
      box: [
        round(b.x - origin.x),
        round(b.y - origin.y),
        fills.includes("w") ? "fills" : round(b.width),
        fills.includes("h") ? "fills" : round(b.height),
      ],
      font: `${s.fontSize}/${s.fontWeight}/${s.lineHeight}/${s.fontFamily.slice(0, 24)}`,
      color: s.color,
      bg: s.backgroundColor,
      radius: s.borderTopLeftRadius,
      shadow: s.boxShadow,
      opacity,
      filter: s.filter,
      motion: `${moves ? "moves" : "still"} ${s.animationDuration} ${s.animationTimingFunction} ${s.animationIterationCount} | ${s.transitionProperty} ${s.transitionDuration}`,
      pad: s.padding,
      gap: s.gap,
    };
  };
  const parts: Parts = {};
  /**
   * The controls and marks a person can see in a region, each by its kind and its name: buttons,
   * links, tabs, fields, dialogs, and what speaks up or marks a state. Plain text isn't listed: it
   * is the sample's. What repeats with the sample (a tab, a row, a face) is listed once, by the
   * first word of its name, whatever it is called and however many there are.
   */
  const KINDS = {
    button: 'button:not([role="tab"]), [role="button"]',
    link: "a[href]",
    tab: '[role="tab"]',
    field: 'input:not([type="hidden"]), textarea, select, [contenteditable="true"]',
    dialog: '[role="dialog"]',
    alert: '[role="alert"]',
    status: '[role="status"]',
    mark: '[role="img"]',
  };
  const shows = (e: Element) => {
    if (!seen(e)) return false;
    const style = getComputedStyle(e);
    return style.visibility !== "hidden" && style.opacity !== "0";
  };
  const controls = (name: string, region: Element | null | undefined, except = "") => {
    if (!seen(region)) return;
    const all = new Set<string>();
    for (const [kind, selector] of Object.entries(KINDS))
      for (const e of region.querySelectorAll(selector)) {
        if (!shows(e) || (except && e.closest(except))) continue;
        const label = e.getAttribute("aria-label") ?? e.getAttribute("title");
        const said =
          (label ?? e.textContent ?? "").split(",")[0]?.trim().replace(/\d+/g, "#") ?? "";
        const repeats = e.closest('li, [role="tablist"]');
        // What speaks up, in any region, says the service's words or the sample's: it is listed
        // by its kind alone.
        const spoken = kind === "alert" || kind === "status";
        all.add(
          `${kind}: ${spoken ? "" : repeats ? (label ? said.split(" ")[0] : "") : said}`.trim(),
        );
      }
    parts[`${name}.seen`] = [...all].sort().join(" | ");
  };

  /** A part measured from the top left of another it is in, where that one's place isn't fixed. */
  const inside = (box: Element | null | undefined, e: Element | null | undefined, fills = "") => {
    const m = of(e, fills);
    const [at, own] = [box?.getBoundingClientRect(), e?.getBoundingClientRect()];
    if (m && at && own) {
      m.box[0] = round(own.x - at.x);
      m.box[1] = round(own.y - at.y);
    }
    return m;
  };
  /** What a window says under itself when its view has closed. */
  const closed = (window: Element | null | undefined) => {
    const again = [...(window?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent?.trim() === "Open again",
    );
    const line = again?.parentElement;
    // Under the window, which is as tall as its frame: its place is the frame's, its size its own.
    const whole = of(line, "w");
    if (whole) whole.box = ["-", "under the window", "fills", whole.box[3] ?? 0];
    parts.closed = whole;
    parts["closed.words"] = inside(line, line?.children[0]);
    parts["closed.again"] = inside(line, again);
  };

  if (what === "terminal") {
    const list = [...document.querySelectorAll('[role="tablist"][aria-label="Terminals"]')].find(
      seen,
    );
    const bar = list?.parentElement?.parentElement;
    if (!list || !bar) return parts;
    origin = bar.getBoundingClientRect();
    controls("window", bar.parentElement);
    // The window is as wide and as tall as its frame, so what fills it has no width of its own.
    parts.bar = of(bar, "w");
    parts["bar.inner"] = of(bar.children[0], "w");
    parts.tablist = of(list);
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    parts.tabs = tabs
      .map(
        (t) => `${t.textContent}${t.getAttribute("aria-selected") === "true" ? " (in front)" : ""}`,
      )
      .join(" | ");
    tabs.forEach((tab, i) => {
      parts[`tab${i}`] = of(tab);
      parts[`tab${i}.running`] = of(tab.querySelector('[aria-label="Running"]'));
      parts[`tab${i}.label`] = of(tab.querySelector("span"));
    });
    const plus = bar.querySelector('button[aria-label="New terminal"]');
    parts.plus = of(plus);
    parts["plus.icon"] = of(plus?.querySelector("svg"));
    const where = bar.nextElementSibling;
    parts.where = of(where, "w");
    parts.folder = of(where?.querySelector('[aria-label="Folder"]'), "w");
    const host = where?.nextElementSibling?.querySelector(".xterm-host");
    parts.host = of(host, "wh");
    const rows = host?.querySelector(".xterm-rows");
    parts.rows = of(rows, "wh");
    const line = of(rows?.children[0], "w");
    if (line) line.box = ["-", "-", "fills", line.box[3] ?? 0];
    parts.line = line;
    // What was typed and refused: one line over the foot of the terminal, from its foot.
    const alert = bar.parentElement?.querySelector('[role="alert"]');
    const refused = of(alert, "w");
    const foot = alert?.parentElement?.getBoundingClientRect();
    const said = alert?.getBoundingClientRect();
    if (refused && foot && said)
      refused.box = [
        round(said.x - foot.x),
        round(foot.bottom - said.bottom),
        "fills",
        refused.box[3] ?? 0,
      ];
    parts.refused = refused;
    closed(bar.parentElement);
    return parts;
  }

  if (what === "browser") {
    const list = [...document.querySelectorAll('[role="tablist"][aria-label="Tabs"]')].find(seen);
    const bar = list?.parentElement?.parentElement;
    if (!list || !bar) return parts;
    origin = bar.getBoundingClientRect();
    controls("window", bar.parentElement);
    parts.bar = of(bar, "w");
    parts["bar.inner"] = of(bar.children[0], "w");
    // The row of tabs is as wide as its tabs, which are the sample's.
    parts.tablist = of(list, "w");
    /** Measured from another left edge than the window's, where what comes before it differs. */
    const from = (x: number, m: Measured | null) => {
      if (m) m.box[0] = round(Number(m.box[0]) + origin.x - x);
      return m;
    };
    // A tab you opened, in front, from its own left edge.
    const tab = [...list.querySelectorAll('[role="tab"]')].find((t) => t.textContent === "New tab");
    const whole = tab?.parentElement;
    const left = whole?.getBoundingClientRect().x ?? 0;
    parts.tab = from(left, of(whole));
    parts["tab.name"] = from(left, of(tab));
    const close = whole?.querySelector("button:not([role])");
    parts["tab.close"] = from(left, of(close));
    parts["tab.close.icon"] = from(left, of(close?.querySelector("svg")));
    // The plus, from the end of the tabs.
    const plus = bar.querySelector('button[aria-label="New tab"]');
    const end = list.getBoundingClientRect().right;
    parts.plus = from(end, of(plus));
    parts["plus.icon"] = from(end, of(plus?.querySelector("svg")));
    const where = bar.nextElementSibling;
    parts.where = of(where, "w");
    for (const name of ["Back", "Forward", "Reload"]) {
      const button = where?.querySelector(`button[aria-label="${name}"]`);
      parts[name] = of(button);
      parts[`${name}.icon`] = of(button?.querySelector("svg"));
    }
    parts.address = of(where?.querySelector('[aria-label="Address"]'), "w");
    // The page under them: as wide and tall as the window leaves it.
    const page = where?.nextElementSibling;
    parts.page = of(page, "wh");
    // What the page asks, over the page: across its middle, from its top.
    const asks = page?.querySelector('[role="dialog"]');
    const asked = inside(page, asks);
    const [around, box] = [page?.getBoundingClientRect(), asks?.getBoundingClientRect()];
    // Across the middle of the page, however wide the page is.
    if (asked && around && box && Math.abs(box.x - around.x - (around.right - box.right)) < 1)
      asked.box[0] = "in the middle";
    parts.asks = asked;
    parts["asks.words"] = inside(asks, asks?.querySelector("p"), "w");
    const answers = [...(asks?.querySelectorAll("button") ?? [])];
    const named = (name: string) => answers.find((b) => b.textContent?.trim() === name);
    parts["asks.ok"] = inside(asks, named("OK"));
    parts["asks.cancel"] = inside(asks, named("Cancel"));
    parts["asks.file"] = inside(asks, asks?.querySelector('input[type="file"]'), "w");
    const options = asks?.querySelector("ul");
    parts["asks.options"] = inside(asks, options);
    parts["asks.option"] = inside(asks, options?.querySelector("button"));
    closed(bar.parentElement);
    return parts;
  }

  if (what === "home") {
    const shell = document.querySelector("[data-shell]");
    const page = document.querySelector("main");
    if (!shell || !page) return parts;
    origin = shell.getBoundingClientRect();
    controls("page", page);
    // Its two sections, each a head and its rows. How tall a section is, is how many chats it has.
    for (const [key, label] of [
      ["needs", "Needs you"],
      ["recent", "Recent"],
    ] as const) {
      const section = page.querySelector(`section[aria-label="${label}"]`);
      parts[key] = of(section, "h");
      const head = section?.children[0];
      parts[`${key}.head`] = of(head);
      parts[`${key}.title`] = of(head?.querySelector("h2"));
      parts[`${key}.all`] = of(head?.querySelector("button"));
      parts[`${key}.row`] = of(section?.querySelector("li button"));
    }
    return parts;
  }

  if (what === "thread") {
    const shell = document.querySelector("[data-shell]");
    const panel = document.querySelector('aside[aria-label="Chats"]');
    if (!shell) return parts;
    origin = shell.getBoundingClientRect();
    controls("panel", panel);
    // One chat, or one about to be started: its head, what was said, and where to write.
    const head = panel?.querySelector("header");
    parts.head = of(head);
    parts["head.back"] = of(head?.querySelector('button[aria-label="All chats"]'));
    const face = head?.querySelector('button[aria-label$="page"]');
    parts["head.face"] = of(face);
    const disc = of(face?.querySelector("span > span") ?? face?.children[0]?.children[0]);
    if (disc) disc.bg = "the agent's";
    parts["head.face.disc"] = disc;
    const title = head?.querySelector("h2");
    parts["head.title"] = of(title, "w");
    parts["head.agent"] = of(title?.nextElementSibling, "w");
    parts["head.options"] = of(head?.querySelector('button[aria-label="Chat options"]'));
    parts["head.close"] = of(head?.querySelector('button[aria-label="Close chats"]'));
    const said = panel?.querySelector(".whitespace-pre-wrap");
    parts.said = of(said);
    const call = panel?.querySelector("[data-call]");
    parts.call = of(call);
    parts["call.line"] = of(call?.querySelector("button"));
    parts["call.words"] = of(call?.querySelector("button > span"));
    const reply = panel?.querySelector(".prose-chat");
    parts.reply = of(reply);
    parts["reply.copy"] = of(panel?.querySelector('button[aria-label="Copy"]'));
    const wrong = panel?.querySelector('[role="alert"]');
    parts.wrong = of(wrong);
    parts["wrong.words"] = of(wrong?.children[0], "w");
    const box = panel?.querySelector('textarea[aria-label="Message"]');
    const group = box?.closest('[data-slot="input-group"]') ?? box?.parentElement;
    parts.composer = of(group);
    parts["composer.box"] = of(box);
    parts["composer.send"] = of(panel?.querySelector('button[aria-label="Send"]'));
    // A chat about to be started: who with, and the room where the first thing will be written.
    const who = panel?.querySelector('ul[aria-label="Who with"]');
    parts.who = of(who);
    const first = who?.querySelector("button");
    parts["who.first"] = of(first);
    parts["who.first.face"] = of(first?.children[0]);
    parts["who.first.name"] = of(first?.children[1]);
    parts["new.room"] = box ? null : of(who?.parentElement?.nextElementSibling?.children[0]);
    // Chats found from the bar's search.
    const found = document.querySelector('ul[aria-label="Chats found"]');
    parts.found = of(found);
    const row = found?.querySelector("button");
    parts["found.row"] = of(row);
    parts["found.row.icon"] = of(row?.children[0]);
    parts["found.row.title"] = of(row?.children[1], "w");
    return parts;
  }

  if (what === "chat") {
    const shell = document.querySelector("[data-shell]");
    if (!shell) return parts;
    origin = shell.getBoundingClientRect();
    // Collapsed: the column the layer counts, the pill at its foot, the chat button and its count,
    // and the faces behind it.
    const column = document.querySelector("[data-chat-column]");
    const pill = column?.querySelector('[role="group"]');
    controls("column", column);
    controls("panel", document.querySelector('aside[aria-label="Chats"]'));
    parts.column = of(column);
    parts.pill = of(pill);
    const button = pill?.querySelector("button");
    parts["pill.button"] = of(button);
    parts["pill.button.icon"] = of(button?.querySelector("svg"));
    parts["pill.count"] = of(button?.querySelector("span"));
    [...(pill?.querySelectorAll("li") ?? [])].forEach((face, i) => {
      parts[`pill.face${i}`] = of(face);
      const disc = of(face.querySelector("button > span > span"));
      // A face's colours are its agent's own, and so is the size its letters would have.
      if (disc) disc.bg = disc.font = "the agent's";
      parts[`pill.face${i}.disc`] = disc;
    });
    // Open: the panel, its head, its list and its foot.
    const panel = document.querySelector('aside[aria-label="Chats"]');
    parts.panel = of(panel);
    const head = panel?.querySelector("header");
    parts["panel.head"] = of(head);
    // A text is as wide as what it says, which is the sample's.
    parts["panel.title"] = of(head?.querySelector("h2"), "w");
    parts["panel.close"] = of(head?.querySelector('button[aria-label="Close chats"]'));
    const list = panel?.querySelector("ul");
    parts["panel.list"] = of(list);
    const rows = [...(list?.querySelectorAll("li > button") ?? [])];
    parts["row.first"] = of(rows[0]);
    parts["row.second"] = of(rows[1]);
    // One row with something unread and one without, part by part.
    for (const [name, row] of [
      ["unread", rows.find((r) => r.querySelector('[aria-label="New"]'))],
      ["read", rows.find((r) => !r.querySelector('[aria-label="New"]'))],
    ] as const) {
      const top = row?.getBoundingClientRect().y ?? 0;
      const inRow = (m: Measured | null) => {
        if (m) m.box[1] = round(Number(m.box[1]) + origin.y - top);
        return m;
      };
      const [face, words, side] = row ? [...row.children] : [];
      const disc = inRow(of(face?.children[0]));
      if (disc) disc.bg = "the agent's";
      parts[`row.${name}.face`] = inRow(of(face));
      parts[`row.${name}.face.disc`] = disc;
      parts[`row.${name}.words`] = inRow(of(words));
      parts[`row.${name}.title`] = inRow(of(words?.children[0]));
      parts[`row.${name}.under`] = inRow(of(words?.children[1]));
      parts[`row.${name}.agent`] = inRow(of(words?.children[1]?.children[0], "w"));
      // The last words start where the agent's name ends.
      const last = inRow(of(words?.children[1]?.children[1], "w"));
      if (last) last.box[0] = "after the name";
      parts[`row.${name}.last`] = last;
      parts[`row.${name}.side`] = inRow(of(side));
      // The age ends at the row's edge, so where it starts is how long it is.
      const when = inRow(of(side?.children[0], "w"));
      if (when) when.box[0] = "ends at the edge";
      parts[`row.${name}.when`] = when;
      parts[`row.${name}.mark`] = inRow(of(side?.children[1]));
    }
    parts["panel.foot"] = of(list?.nextElementSibling);
    return parts;
  }

  const shell = document.querySelector("[data-shell]");
  if (!shell) return parts;
  origin = shell.getBoundingClientRect();
  parts.shell = `${origin.width} x ${origin.height}`;
  const navs = [...document.querySelectorAll('nav[aria-label="Main"]')].filter(seen);
  parts.bars = navs.length;
  navs.forEach((nav, n) => {
    const at = navs.length > 1 && n === navs.length - 1 ? "drawer" : "bar";
    // The agents are the sample's: there are as many rows as agents.
    controls(at, nav, 'ul[aria-label="Agents"]');
    const button = (name: string) =>
      [...nav.querySelectorAll("button")].find(
        (b) => seen(b) && (b.title === name || b.getAttribute("aria-label") === name),
      );
    const row = (name: string, b: Element | undefined) => {
      parts[`${at}.${name}`] = of(b);
      parts[`${at}.${name}.cell`] = of(b?.children[0]);
      parts[`${at}.${name}.label`] = of(b?.children[1]);
      if (/Home|Templates|Settings/.test(name))
        parts[`${at}.${name}.icon`] = of(b?.children[0]?.querySelector("svg"));
    };
    parts[`${at}.nav`] = of(nav);
    row("Home", button("Home"));
    parts[`${at}.search`] = of(nav.querySelector('input[type="search"]'));
    parts[`${at}.searchButton`] = of(button("Search"));
    parts[`${at}.Create`] = of(button("Create"));
    [...nav.querySelectorAll('[aria-label="Agents"] button')]
      .filter(seen)
      .slice(0, 3)
      .forEach((b, i) => {
        row(`agent${i}`, b);
      });
    // A face is measured within its own row: which agent is in which row is the data's.
    for (const [word, label] of [
      ["Working", "working"],
      ["Has a problem", "trouble"],
    ] as const) {
      const mark = [
        ...nav.querySelectorAll(`[aria-label="Agents"] [role="img"][aria-label="${word}"]`),
      ].find(seen);
      const top = mark?.closest("button")?.getBoundingClientRect().y ?? 0;
      const within = (m: Measured | null) => {
        if (m) m.box[1] = round(Number(m.box[1]) + origin.y - top);
        return m;
      };
      const face = mark?.parentElement;
      parts[`${at}.face.${label}`] = within(of(face));
      const disc = within(of(face?.children[0]));
      // A face's colours are its agent's own.
      if (disc) disc.bg = "the agent's";
      parts[`${at}.face.${label}.disc`] = disc;
      parts[`${at}.face.${label}.mark`] = within(of(mark));
    }
    row("Templates", button("Templates"));
    row("Settings", button("Settings"));
  });
  // The page area's own box and surface.
  const main = of(document.querySelector("main"));
  parts.main = main;
  const head = [...document.querySelectorAll("header")].find(seen);
  parts.head = of(head);
  controls("head", head);
  parts["head.menu"] = of(head?.querySelector("button"));
  parts["head.place"] = of(head?.querySelector("span"));
  parts.overlay = of(
    [...document.querySelectorAll("[data-drawer-overlay], [aria-hidden].bg-black\\/40")].find(seen),
  );
  return parts;
};

/** The design's page has a bar of its own controls above its shell. */
const CONTROLS = 33;
const SIZES = { wide: [1440, 900], rail: [800, 900], phone: [390, 844] } as const;
type Size = keyof typeof SIZES;
type Theme = "dark" | "light";

const browser = await chromium.launch();
async function designPage(size: Size, theme: Theme) {
  const [width, height] = SIZES[size];
  const page = await browser.newPage({ viewport: { width, height: height + CONTROLS } });
  await page.goto(`file://${design}`);
  if (theme === "light") await page.getByRole("button", { name: "Light" }).click();
  return page;
}
async function builtPage(gateway: Gateway, size: Size, theme: Theme, hash = "#/") {
  const [width, height] = SIZES[size];
  const page = await browser.newPage({ viewport: { width, height } });
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  await page
    .getByRole("button", { name: "Dismiss" })
    .click({ timeout: 3000 })
    .catch(() => {});
  if (theme === "light")
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
  return page;
}
/** Off everything, so nothing is measured under the pointer, and settled. */
async function rest(page: Page, size: Size) {
  await page.mouse.move(SIZES[size][0] - 3, SIZES[size][1] / 2);
  await page.waitForTimeout(900);
}

const measure = (page: Page, what: Part) => page.evaluate(probe, what);
const all: Record<string, Parts> = {};

// The frame: each width in each theme, and the drawer from the rail's search and the phone's menu.
for (const size of Object.keys(SIZES) as Size[])
  for (const theme of ["dark", "light"] as const)
    for (const side of ["design", "built"] as const) {
      const gateway = side === "built" ? await standIn() : undefined;
      const page = gateway ? await builtPage(gateway, size, theme) : await designPage(size, theme);
      await rest(page, size);
      all[`frame.${size}.${theme}.${side}`] = await measure(page, "frame");
      if (theme === "dark" && size !== "wide") {
        await (size === "phone"
          ? page.getByRole("button", { name: "Menu" })
          : page
              .getByRole("navigation", { name: "Main" })
              .getByRole("button", { name: "Search", exact: true })
        ).click();
        await rest(page, size);
        all[`frame.${size}.drawer.${side}`] = await measure(page, "frame");
      }
      await page.close();
      await gateway?.close();
    }

// The terminal window: the design's own, and the built one with terminals of the same names in
// the same states. Then the cases the design draws from its own controls, which the built side
// is put in by its service: typing refused, the view closed, and a computer only watched.
for (const theme of ["dark", "light"] as const) {
  const drawn = await designPage("wide", theme);
  await drawn
    .getByRole("navigation", { name: "Main" })
    .getByRole("button", { name: "Research", exact: true })
    .click();
  await drawn.getByRole("button", { name: "Terminal", exact: true }).click();
  await rest(drawn, "wide");
  const designed = await measure(drawn, "terminal");
  all[`terminal.${theme}.design`] = designed;
  const titles = String(designed.tabs).split(" | ");
  const terminals = titles.map((title, i) => ({
    cmd: title.replace(" (in front)", ""),
    running: !!designed[`tab${i}.running`],
  }));
  const front = titles.findIndex((title) => title.endsWith(" (in front)"));
  /** The built side, with the same terminals and the same one in front. */
  const built = async (operate: boolean) => {
    const gateway = await standIn();
    computerWith(gateway, "terminal", operate);
    startTerminals(gateway, terminals);
    const page = await builtPage(gateway, "wide", theme, "#/a/a-research");
    await page.getByRole("tablist", { name: "Terminals" }).getByRole("tab").nth(front).click();
    return { gateway, page };
  };
  const both = async (state: string, page: Page) => {
    for (const [side, one] of [
      ["design", drawn],
      ["built", page],
    ] as const) {
      await rest(one, "wide");
      all[`terminal.${state}${theme}.${side}`] = await measure(one, "terminal");
    }
  };
  const { gateway, page } = await built(true);
  await both("", page);

  await inDesign(drawn, "Typing refused");
  gateway.live.terminal.full = true;
  await page.getByRole("button", { name: "New terminal" }).click();
  await page.getByRole("group", { name: "Terminals" }).getByRole("alert").waitFor();
  await both("refused.", page);
  await inDesign(drawn, "Typing taken");
  // Picking a tab takes the built side's refusal away.
  await page.getByRole("tablist", { name: "Terminals" }).getByRole("tab").nth(front).click();

  await inDesign(drawn, "View closed");
  for (const ws of gateway.live.terminal.sockets) ws.close(1000);
  await page.getByRole("button", { name: "Open again" }).waitFor();
  await both("closed.", page);
  await inDesign(drawn, "View open");
  await page.close();
  await gateway.close();

  await inDesign(drawn, "Watch only");
  const watched = await built(false);
  await both("watch.", watched.page);
  await watched.page.close();
  await watched.gateway.close();
  await drawn.close();
}

// The browser window: the design's own, and the built one, each with a tab you opened in front.
// Then its cases: the view closed, what the page asks, no tab, and a computer only watched.
for (const theme of ["dark", "light"] as const)
  for (const side of ["design", "built"] as const) {
    const gateway = side === "built" ? await standIn() : undefined;
    if (gateway) computerWith(gateway, "browser");
    const page = gateway
      ? await builtPage(gateway, "wide", theme, "#/a/a-research")
      : await designPage("wide", theme);
    if (!gateway) {
      await page
        .getByRole("navigation", { name: "Main" })
        .getByRole("button", { name: "Research", exact: true })
        .click();
      await page.getByRole("button", { name: "Browser", exact: true }).click();
    }
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await page.getByRole("tab", { name: "New tab", selected: true }).waitFor();
    const at = async (state: string, on = page) => {
      await rest(on, "wide");
      all[`browser.${state}${theme}.${side}`] = await measure(on, "browser");
    };
    await at("");

    const again = page.getByRole("button", { name: "Open again" });
    if (gateway) for (const ws of gateway.live.screens.keys()) ws.close(1000);
    else await inDesign(page, "View closed");
    await again.waitFor();
    await at("closed.");
    if (gateway) await again.click();
    else await inDesign(page, "View open");
    await again.waitFor({ state: "detached" });
    // The built side's view is open again once its service has it.
    while (gateway && gateway.live.screens.size === 0)
      await new Promise((done) => setTimeout(done, 20));

    // Each thing a page asks, one after another; then answered, it is gone.
    const asks = page.getByRole("dialog", { name: "The page asks" });
    for (const [name, event] of Object.entries(ASKS)) {
      if (gateway) gateway.screen(event);
      else await inDesign(page, /^Page asks/);
      await asks.getByText(ASKED[name as keyof typeof ASKS]).waitFor();
      await at(`asks.${name}.`);
    }
    if (gateway) await asks.getByRole("button").first().click();
    else await inDesign(page, /^Page asks/);
    await asks.waitFor({ state: "detached" });

    if (gateway) await closeEveryTab(page);
    else await inDesign(page, "No tab");
    await page
      .getByRole("tablist", { name: "Tabs" })
      .getByRole("tab")
      .first()
      .waitFor({ state: "detached" });
    await at("notab.");

    // Watched only: the design's own page with its control on, and a built one that may not
    // operate, each with a tab of that name in front, and then with the page asking.
    let watching = page;
    let watched: Gateway | undefined;
    if (gateway) {
      watched = await standIn();
      computerWith(watched, "browser", false);
      // A watcher opens no tab of its own: the one in front is there already.
      watched.live.tabs.push({ id: 2, url: "about:blank", title: "" });
      watching = await builtPage(watched, "wide", theme, "#/a/a-research");
    } else {
      await inDesign(page, "A tab");
      await inDesign(page, "Watch only");
    }
    await watching.getByRole("tab", { name: "New tab", selected: true }).waitFor();
    await at("watch.", watching);
    if (watched) watched.screen(ASKS.confirm);
    else await inDesign(page, /^Page asks/);
    await watching.getByRole("dialog", { name: "The page asks" }).waitFor();
    await at("asks.watch.", watching);
    if (watched) {
      await watching.close();
      await watched.close();
    }
    await page.close();
    await gateway?.close();
  }

// The chat in the layer: collapsed with one, two and three chats unread, at rest and under the
// pointer, then open on its list.
for (const theme of ["dark", "light"] as const)
  for (const side of ["design", "built"] as const) {
    const gateway = side === "built" ? await standIn() : undefined;
    const page = gateway
      ? await builtPage(gateway, "wide", theme)
      : await designPage("wide", theme);
    if (gateway) await noted(gateway);
    for (const unread of [1, 2, 3]) {
      // One more chat says something: in the design by its own control, in the build by its agent.
      if (!gateway) {
        if (unread > 1) await page.getByRole("button", { name: "A reply arrives" }).click();
      } else unreadReply(gateway, unread);
      await page.getByRole("button", { name: `Chats, ${unread} new` }).waitFor();
      await rest(page, "wide");
      all[`chat.collapsed.${unread}.${theme}.${side}`] = await measure(page, "chat");
      await page
        .getByRole("group", { name: "Chats, collapsed" })
        .hover({ position: { x: 44, y: 24 } });
      await page.waitForTimeout(500);
      all[`chat.widened.${unread}.${theme}.${side}`] = await measure(page, "chat");
    }
    // And one with nothing unread, to be measured beside them.
    if (gateway) readChat(gateway);
    await page.getByRole("button", { name: "Chats, 3 new" }).click();
    await rest(page, "wide");
    all[`chat.panel.${theme}.${side}`] = await measure(page, "chat");
    await page.close();
    await gateway?.close();
  }

// Home: the chats that need you and the recent ones, wide and on a phone. The built side has as
// many that need you as the design's sample: one with a problem, one with a reply not yet read.
for (const size of ["wide", "phone"] as const)
  for (const theme of ["dark", "light"] as const)
    for (const side of ["design", "built"] as const) {
      const gateway = side === "built" ? await standIn() : undefined;
      if (gateway) sampleChats(gateway);
      const page = gateway ? await builtPage(gateway, size, theme) : await designPage(size, theme);
      if (gateway) {
        await noted(gateway);
        unreadReply(gateway, 1);
      }
      await page.getByRole("region", { name: "Needs you" }).getByRole("button").nth(1).waitFor();
      await rest(page, size);
      all[`home.${size}.${theme}.${side}`] = await measure(page, "home");
      await page.close();
      await gateway?.close();
    }

// One chat, a chat with a problem, a chat about to be started, and chats found from the bar: the
// design's sample chats, and the same two on the built side.
for (const theme of ["dark", "light"] as const)
  for (const side of ["design", "built"] as const) {
    const gateway = side === "built" ? await standIn() : undefined;
    if (gateway) sampleChats(gateway);
    const page = gateway
      ? await builtPage(gateway, "wide", theme)
      : await designPage("wide", theme);
    const panel = page.getByRole("complementary", { name: "Chats" });
    const at = async (state: string) => {
      await rest(page, "wide");
      all[`thread.${state}.${theme}.${side}`] = await measure(page, "thread");
    };
    await page.getByRole("button", { name: /^Chats/ }).click();
    await panel.getByRole("button", { name: /Review #482/ }).click();
    await panel.getByRole("heading", { name: "Review #482" }).waitFor();
    await at("chat");
    await panel.getByRole("button", { name: "All chats" }).click();
    await panel.getByRole("button", { name: /Route today's issues/ }).click();
    await panel.getByRole("alert").waitFor();
    await at("problem");
    await panel.getByRole("button", { name: "All chats" }).click();
    await panel.getByRole("button", { name: "New chat" }).click();
    await panel.getByRole("heading", { name: "New chat" }).waitFor();
    await at("new");
    await panel.getByRole("list", { name: "Who with" }).locator("button:enabled").first().click();
    await panel.getByRole("textbox", { name: "Message" }).waitFor();
    await at("picked");
    await panel.getByRole("button", { name: "Close chats" }).click();
    await page.getByRole("searchbox", { name: "Search" }).fill("Route today");
    await page.getByRole("list", { name: "Chats found" }).waitFor();
    await at("found");
    await page.close();
    await gateway?.close();
  }

await browser.close();
writeFileSync(out, JSON.stringify(all, null, 1));
let rows = 0;
let different = 0;
/** Where the built side shows fewer controls or marks than the design: a part not built yet. */
const fewer: string[] = [];
for (const key of Object.keys(all).filter((k) => k.endsWith(".design"))) {
  const [drawn, built] = [all[key] ?? {}, all[key.replace(/design$/, "built")] ?? {}];
  for (const part of new Set([...Object.keys(drawn), ...Object.keys(built)])) {
    rows++;
    const [x, y] = [JSON.stringify(drawn[part]), JSON.stringify(built[part])];
    if (x === y) continue;
    const at = `${key.replace(/\.design$/, "")}  ${part}`;
    // What is seen may lack something the design has, and never has something it doesn't.
    if (part.endsWith(".seen")) {
      const [has, shows] = [drawn[part], built[part]].map((one) => String(one ?? "").split(" | "));
      const more = (shows as string[]).filter((one) => one && !(has as string[]).includes(one));
      if (more.length === 0) {
        const less = (has as string[]).filter((one) => !(shows as string[]).includes(one));
        fewer.push(`${at}: the design also has ${less.join(", ")}`);
        continue;
      }
      different++;
      console.log(`${at}\n   built and not in the design: ${more.join(", ")}`);
      continue;
    }
    different++;
    console.log(`${at}\n   design ${x}\n   built  ${y}`);
  }
}
if (fewer.length > 0) console.log(`Seen in the design and not built:\n  ${fewer.join("\n  ")}`);
console.log(
  `${rows - different - fewer.length} of ${rows} rows equal, ${fewer.length} with less seen than the design, ${different} different`,
);
process.exitCode = different ? 1 : 0;
