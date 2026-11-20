// Skills and MCP connections in Settings, in a real browser over the stand-in gateway: what each
// lists, how a connection stands, and deleting one after asking.
import assert from "node:assert/strict";
import test from "node:test";
import { withBrowser, withGateway } from "./build-kit.ts";
import { sampleAgents } from "./design/samples.ts";
import { addSkill, open, row } from "./manage-kit.ts";

withBrowser();

test(
  "Skills lists what's there and what uses each, and adds one from a folder",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/skills");
    await row(page, "cite-sources").getByRole("button", { name: "Research" }).waitFor();
    await row(page, "weekly-numbers").getByText("Not used yet").waitFor();
    await page.getByRole("button", { name: "Add skill" }).click();
    const dialog = addSkill(page);
    gateway.refuseNext("skills.add", "invalid", "That folder has no SKILL.md.");
    await dialog.getByRole("textbox").fill("/skills/empty");
    await dialog.getByRole("button", { name: "Add" }).click();
    await dialog.getByRole("alert").getByText("That folder has no SKILL.md.").waitFor();
    await dialog.getByRole("textbox").fill("/skills/changelog");
    await dialog.getByRole("button", { name: "Add" }).click();
    await dialog.waitFor({ state: "detached" });
    await row(page, "changelog").getByText("Not used yet").waitFor();
    assert.deepEqual(gateway.calls.findLast((c) => c.method === "add")?.input, {
      path: "/skills/changelog",
    });
    await page.close();
  }),
);

test(
  "MCP connections says where each is, how it got there, what uses it, and how it stands",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/mcps");
    const github = row(page, "GitHub acme");
    await github.getByText("Connected by you").waitFor();
    // An address is said without its scheme; a command as it is run.
    await github.getByText("api.githubcopilot.com/mcp", { exact: true }).waitFor();
    await row(page, "Notes for Research").getByText("notes-server ~/notes").waitFor();
    await github.getByRole("button", { name: "Reviewer" }).waitFor();
    await github.getByText("2 tools").waitFor();
    await row(page, "Notes for Research").getByText("Created for Research by Local").waitFor();
    await row(page, "Linear").getByText("Down").waitFor();
    await row(page, "Postgres analytics").getByRole("img", { name: "On this computer" }).waitFor();
    await page.close();
  }),
);

test(
  "a connection a unit made says which unit and for which agent",
  withGateway(async (gateway) => {
    sampleAgents(gateway);
    // A second one, made for the same agent by another of its units.
    const research = gateway.agents.get("a-research");
    const made = gateway.connections.get("c-postgres");
    const web = research?.mcp.find((one) => one.connection === "c-postgres");
    assert.ok(research && made?.origin && web);
    made.origin = { ...made.origin, madeFor: "a-research" };
    web.instance = "i-web";
    const page = await open(gateway, "#/mcps");
    await row(page, "Postgres analytics").getByText("Web for Research").waitFor();
    await row(page, "Notes for Research").getByText("Computer for Research").waitFor();
    await row(page, "GitHub acme").getByText("Connected by you").waitFor();
    await page.close();
  }),
);

test(
  "a connection that is down says why under its name, and one that isn't says nothing there",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/mcps");
    const linear = row(page, "Linear");
    const why = linear.getByText("The server didn't answer.", { exact: true });
    await why.waitFor();
    const name = await linear.getByText("Linear", { exact: true }).boundingBox();
    const said = await why.boundingBox();
    assert.ok(name && said && said.y > name.y + name.height && said.x === name.x, "under the name");
    const found = gateway.connections.get("c-linear");
    assert.ok(found);
    found.status = { state: "connected", tools: [] };
    await why.waitFor({ state: "detached", timeout: 7000 });
    await page.close();
  }),
);

test(
  "a connection stands down on its own page as soon as it's read again",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/mcps");
    await row(page, "Postgres analytics").getByText("1 tool").waitFor();
    const found = gateway.connections.get("c-postgres");
    assert.ok(found);
    found.status = { state: "down", tools: [] };
    await row(page, "Postgres analytics").getByText("Down").waitFor({ timeout: 7000 });
    await page.close();
  }),
);

test(
  "a skill is deleted after asking, and the confirm says who loses it",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/skills");
    await row(page, "cite-sources").getByRole("button", { name: "Research" }).waitFor();
    const before = await row(page, "cite-sources").boundingBox();
    await row(page, "cite-sources").hover();
    assert.deepEqual(await row(page, "cite-sources").boundingBox(), before, "hover moves nothing");
    await page.getByRole("button", { name: "Delete cite-sources" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete cite-sources?" });
    await dialog.getByText("Research loses it. This can't be undone.").waitFor();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(
      gateway.calls.some((c) => c.method === "remove"),
      false,
    );

    gateway.refuseNext("skills.remove", "failed", "It couldn't be removed.");
    await row(page, "cite-sources").hover();
    await page.getByRole("button", { name: "Delete cite-sources" }).click();
    await dialog.getByRole("button", { name: "Delete" }).click();
    await dialog.getByRole("alert").getByText("It couldn't be removed.").waitFor();
    await dialog.getByRole("button", { name: "Delete" }).click();
    await dialog.waitFor({ state: "detached" });
    await row(page, "cite-sources").waitFor({ state: "detached" });
    assert.deepEqual(gateway.calls.findLast((c) => c.method === "remove")?.input, {
      name: "cite-sources",
    });
    assert.deepEqual(gateway.agents.get("a-research")?.skills, []);

    await row(page, "weekly-numbers").hover();
    await page.getByRole("button", { name: "Delete weekly-numbers" }).click();
    await page
      .getByRole("dialog", { name: "Delete weekly-numbers?" })
      .getByText("Nothing uses it.")
      .waitFor();
    await page.close();
  }),
);

test(
  "a connection is deleted after asking, naming every agent that loses it",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/mcps");
    await row(page, "GitHub acme").getByRole("button", { name: "Reviewer" }).waitFor();
    await row(page, "GitHub acme").hover();
    await page.getByRole("button", { name: "Delete GitHub acme" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete GitHub acme?" });
    await dialog.getByText("Research and Reviewer lose it. This can't be undone.").waitFor();
    await dialog.getByRole("button", { name: "Delete" }).click();
    await dialog.waitFor({ state: "detached" });
    await row(page, "GitHub acme").waitFor({ state: "detached" });
    assert.deepEqual(gateway.calls.findLast((c) => c.method === "remove")?.input, {
      connection: "c-github",
    });
    assert.deepEqual(gateway.agents.get("a-reviewer")?.mcp, []);
    await page.close();
  }),
);
