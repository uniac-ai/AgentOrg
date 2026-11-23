// An agent's face, wherever the page draws it: its avatar in a square, from the string the agent
// was given or else from its id, standing still but where it is live, with its state's dot round.
// In a real browser over the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import { avatarFromSeed, toSvg } from "@agentorg/2dlivebot";
import type { Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";
import { noted, sampleAgents } from "./design/samples.ts";
import type { Agent } from "./stand-in.ts";

withBrowser();

async function open(gateway: Gateway, hash: string, width = 1440): Promise<Page> {
  const page = await browser().newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
/**
 * Each face drawn: whose it is, its width and height, the still picture it shows as SVG text or
 * none where it is live, whether it is faded, and whether its state's dot is round, if it has one.
 */
const faces = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-face]")].map((face) => {
      const box = face.getBoundingClientRect();
      const picture = face.querySelector("img")?.getAttribute("src");
      const dot = face.querySelector(':scope > span[role="img"]');
      return {
        agent: face.dataset.face,
        size: `${box.width}x${box.height}`,
        picture: picture ? decodeURIComponent(picture.slice(picture.indexOf(",") + 1)) : null,
        live: !!face.querySelector("svg path"),
        faded: getComputedStyle(face.firstElementChild as Element).opacity !== "1",
        dotRound: dot
          ? Number.parseFloat(getComputedStyle(dot).borderTopLeftRadius) >=
            dot.getBoundingClientRect().width / 2
          : null,
      };
    }),
  );
/** The avatar the stand-in's agent has: the one it was given, or the one its id makes. */
const avatarOf = (gateway: Gateway, id: string) =>
  (gateway.agents.get(id) as Agent).avatar ?? avatarFromSeed(id);

test(
  "every face on Chat and Team is its agent's avatar in a square, and a state's dot stays round",
  withGateway(async (gateway) => {
    sampleAgents(gateway);
    for (const [hash, width] of [
      ["#/chat", 1440],
      ["#/team", 1440],
      ["#/a/a-research", 1440],
      ["#/chat", 390],
    ] as const) {
      const page = await open(gateway, hash, width);
      await page.locator("[data-face]").first().waitFor();
      const seen = await faces(page);
      assert.ok(seen.length > 0, `faces on ${hash}`);
      for (const face of seen) {
        const [w, h] = face.size.split("x");
        assert.equal(w, h, `a square on ${hash}`);
        if (face.picture !== null)
          assert.equal(
            face.picture,
            toSvg(avatarOf(gateway, face.agent as string)),
            `${face.agent}'s avatar on ${hash}`,
          );
        if (face.dotRound !== null) assert.ok(face.dotRound, `its dot round on ${hash}`);
      }
      assert.ok(
        seen.some((face) => face.dotRound !== null) || hash !== "#/team",
        "a state's dot is among them",
      );
      await page.close();
    }
  }),
);

test(
  "an agent given an avatar shows it, one given none or text that names none is drawn from its id, and a stopped one is faded",
  withGateway(async (gateway) => {
    // The sample's Research and Weekly report were given avatars; Reviewer was given none.
    sampleAgents(gateway);
    assert.ok(gateway.agents.get("a-research")?.avatar);
    assert.equal(gateway.agents.get("a-reviewer")?.avatar, undefined);
    (gateway.agents.get("a-triage") as Agent).avatar = "not-an-avatar";
    const page = await open(gateway, "#/team");
    await page.locator('[data-face="a-broken"]').waitFor();
    const seen = new Map((await faces(page)).map((face) => [face.agent, face]));
    assert.equal(
      seen.get("a-research")?.picture,
      toSvg(gateway.agents.get("a-research")?.avatar as string),
    );
    for (const id of ["a-reviewer", "a-triage"])
      assert.equal(seen.get(id)?.picture, toSvg(avatarFromSeed(id)), `${id} from its id`);
    assert.deepEqual(
      [...seen.values()].filter((face) => face.faded).map((face) => face.agent),
      ["a-weekly"],
    );
    await page.close();
  }),
);

test(
  "a face stands still in the lists and is live at a conversation's head and in its details, asleep when its agent is stopped",
  withGateway(async (gateway) => {
    // Weekly report is stopped, with a conversation and an avatar whose eyes are #2a2530.
    sampleAgents(gateway);
    const page = await open(gateway, "#/chat/a-weekly");
    const main = page.getByRole("main");
    const head = main.getByRole("button", { name: "Weekly report's details" });
    await head.locator("svg path").first().waitFor();
    for (const face of await faces(page))
      assert.equal(
        face.live,
        face.picture === null,
        `${face.agent}: a picture, or live, never both`,
      );
    const listed = await main.getByRole("list", { name: "Chats" }).locator("[data-face]").count();
    assert.ok(listed > 0, "faces in the list");
    assert.equal(
      await main.getByRole("list", { name: "Chats" }).locator("[data-face] svg").count(),
      0,
      "none in the list is live",
    );
    await head.click();
    const card = page.getByRole("region", { name: "Weekly report's details" });
    await card.locator("[data-face] svg path").first().waitFor();
    // Asleep, its eyes close: each eye, drawn in the eyes' colour, comes to be flatter than wide.
    await page.waitForFunction(() => {
      const eyes = document.querySelectorAll<SVGPathElement>(
        'section[aria-label$="details"] [data-face] svg path[fill="#2a2530"]',
      );
      return (
        eyes.length === 2 &&
        [...eyes].every((eye) => eye.getBBox().height < eye.getBBox().width / 2)
      );
    });
    await page.close();
  }),
);

test(
  "the collapsed chat's faces are each edged along the figure, at each side, in the pill's own colour",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/team");
    const pill = page.getByRole("group", { name: "Chats, collapsed" });
    await pill.waitFor();
    // Said before the page's note of what is read begins, a reply is read already: no face.
    await noted(gateway);
    gateway.addMessage("a-research", {
      id: "n1",
      role: "assistant",
      text: "A reply.",
      at: new Date().toISOString(),
    });
    const edged = pill.getByRole("button", { name: /^Open / });
    await edged.waitFor();
    const seen = await edged.evaluate((button) => ({
      edge: getComputedStyle(button).filter,
      ground: getComputedStyle(button.closest('[role="group"]') as Element).backgroundColor,
      face: (button.querySelector("[data-face]") as HTMLElement).dataset.face,
    }));
    assert.equal(seen.face, "a-research");
    assert.equal(
      seen.edge,
      `drop-shadow(${seen.ground} 2px 0px 0px) drop-shadow(${seen.ground} -2px 0px 0px)`,
    );
    await page.close();
  }),
);
