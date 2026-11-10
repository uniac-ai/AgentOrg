// Measures the shell as built against its design, with one probe run on both, and prints every
// difference. The design is a self-contained page of the same parts with sample data.
//
//   node --experimental-strip-types test/design/measure.ts <design.html> <out.json>
//
// Build the shell first: the built side is served by the stand-in gateway. A part added to the
// shell adds its probe and its screens here, and its screens to pairs.ts.
import { writeFileSync } from "node:fs";
import { chromium, type Page } from "@playwright/test";
import { type Agent, SESSION, standIn } from "../stand-in.ts";

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
/** What a probe measures: the frame, or one window's own rows. */
type Part = "frame" | "terminal" | "browser";
type Gateway = Awaited<ReturnType<typeof standIn>>;

/**
 * Runs in the page. `frame` measures the left bar, a drawer if one is open, the phone's head and
 * the page area, from the shell's top left. `terminal` and `browser` measure those windows' own
 * rows, from the window's top left.
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

  if (what === "terminal") {
    const list = [...document.querySelectorAll('[role="tablist"][aria-label="Terminals"]')].find(
      seen,
    );
    const bar = list?.parentElement?.parentElement;
    if (!list || !bar) return parts;
    origin = bar.getBoundingClientRect();
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
    return parts;
  }

  if (what === "browser") {
    const list = [...document.querySelectorAll('[role="tablist"][aria-label="Tabs"]')].find(seen);
    const bar = list?.parentElement?.parentElement;
    if (!list || !bar) return parts;
    origin = bar.getBoundingClientRect();
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
    parts.page = of(where?.nextElementSibling, "wh");
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
  // The page area's own box and surface. Its type is the pages', which are not the frame's.
  const main = of(document.querySelector("main"));
  if (main) main.font = "the pages'";
  parts.main = main;
  const head = [...document.querySelectorAll("header")].find(seen);
  parts.head = of(head);
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
// the same states.
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
  await drawn.close();

  const gateway = await standIn();
  (gateway.agents.get("a-research") as Agent).units = [
    {
      instance: "i-computer",
      provider: "units",
      unit: "computer",
      title: "Computer",
      values: {},
      needs: {},
      status: {
        state: "connected",
        surfaces: [{ surface: "terminal", protocol: "terminal@1", operate: true }],
      },
    },
  ];
  const titles = String(designed.tabs).split(" | ");
  const at = "2026-01-01T10:00:00Z";
  titles.forEach((title, i) => {
    const id = `t${i}`;
    const cmd = title.replace(" (in front)", "");
    gateway.terminal({ type: "start", id, by: "agent", cmd, workdir: "/work", tty: false, at });
    if (!designed[`tab${i}.running`]) gateway.terminal({ type: "exit", id, exitCode: 0, at });
  });
  const built = await builtPage(gateway, "wide", theme, "#/a/a-research");
  const tabs = built.getByRole("tablist", { name: "Terminals" }).getByRole("tab");
  await tabs.nth(titles.findIndex((title) => title.endsWith(" (in front)"))).click();
  await rest(built, "wide");
  all[`terminal.${theme}.built`] = await measure(built, "terminal");
  await built.close();
  await gateway.close();
}

// The browser window: the design's own, and the built one, each with a tab you opened in front.
for (const theme of ["dark", "light"] as const)
  for (const side of ["design", "built"] as const) {
    const gateway = side === "built" ? await standIn() : undefined;
    if (gateway)
      (gateway.agents.get("a-research") as Agent).units = [
        {
          instance: "i-computer",
          provider: "units",
          unit: "computer",
          title: "Computer",
          values: {},
          needs: {},
          status: {
            state: "connected",
            surfaces: [{ surface: "browser", protocol: "screencast@1", operate: true }],
          },
        },
      ];
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
    await rest(page, "wide");
    all[`browser.${theme}.${side}`] = await measure(page, "browser");
    await page.close();
    await gateway?.close();
  }

await browser.close();
writeFileSync(out, JSON.stringify(all, null, 1));
let rows = 0;
let different = 0;
for (const key of Object.keys(all).filter((k) => k.endsWith(".design"))) {
  const [drawn, built] = [all[key] ?? {}, all[key.replace(/design$/, "built")] ?? {}];
  for (const part of new Set([...Object.keys(drawn), ...Object.keys(built)])) {
    rows++;
    const [x, y] = [JSON.stringify(drawn[part]), JSON.stringify(built[part])];
    if (x === y) continue;
    different++;
    console.log(`${key.replace(/\.design$/, "")}  ${part}\n   design ${x}\n   built  ${y}`);
  }
}
console.log(`${rows - different} of ${rows} rows equal`);
process.exitCode = different ? 1 : 0;
