// Connecting an MCP in Settings, in a real browser over the stand-in gateway: the form each kind's
// schemas ask for, its fields, a refusal, and the name a connection is exposed under.
import assert from "node:assert/strict";
import test from "node:test";
import { withBrowser, withGateway } from "./build-kit.ts";
import { openSetup } from "./design/samples.ts";
import { connectForm, labels, open, opened, row } from "./manage-kit.ts";

withBrowser();

test(
  "Connect asks what each kind's schemas ask, and a secret goes only in `secrets`",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/mcps");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    const dialog = connectForm(page);
    await dialog.getByLabel("Name").waitFor();
    await opened(dialog);
    const size = await dialog.boundingBox();
    assert.equal(size?.height, 460, "as tall as the design has it");
    assert.deepEqual(await labels(page), ["Name", "Address", "Public addresses only", "Token"]);
    const connect = dialog.getByRole("button", { name: "Connect" });
    assert.equal(await connect.isDisabled(), true);
    await dialog.getByRole("combobox", { name: "Kind" }).click();
    await page.getByRole("option", { name: /starts/ }).click();
    assert.deepEqual(await labels(page), ["Name", "Command", "Args", "CWD", "Secrets"]);
    assert.deepEqual(await dialog.boundingBox(), size, "the dialog keeps its box");

    await dialog.getByRole("combobox", { name: "Kind" }).click();
    await page.getByRole("option", { name: /address/ }).click();
    await dialog.getByLabel("Name").fill("Notion");
    await dialog.getByLabel("Address", { exact: true }).fill("https://mcp.notion.com/mcp");
    await dialog.getByLabel("Token").fill("secret-value");
    await connect.click();
    await dialog.waitFor({ state: "detached" });
    await row(page, "Notion").getByText("Connected by you").waitFor();
    assert.deepEqual(gateway.calls.findLast((c) => c.method === "create")?.input, {
      provider: "local",
      kind: "url",
      params: { url: "https://mcp.notion.com/mcp", public: false },
      name: "Notion",
      secrets: { token: "secret-value" },
    });
    assert.ok(!(await page.content()).includes("secret-value"), "never shown again");
    await page.close();
  }),
);

test(
  "a yes-or-no field is a switch, off at first, and goes as true or false",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/mcps/add");
    const dialog = connectForm(page);
    const only = dialog.getByRole("switch", { name: "Public addresses only" });
    assert.equal(await only.getAttribute("aria-checked"), "false");
    assert.equal(await dialog.getByRole("textbox", { name: "Public addresses only" }).count(), 0);
    await dialog.getByLabel("Name").fill("Search");
    await dialog.getByLabel("Address", { exact: true }).fill("https://mcp.example.com/mcp");
    await only.click();
    assert.equal(await only.getAttribute("aria-checked"), "true");
    await dialog.getByRole("button", { name: "Connect" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.deepEqual(gateway.calls.findLast((c) => c.method === "create")?.input, {
      provider: "local",
      kind: "url",
      params: { url: "https://mcp.example.com/mcp", public: true },
      name: "Search",
    });
    await page.close();
  }),
);

test(
  "a field says what it does under it, as its kind's schema says",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/mcps/add");
    const dialog = connectForm(page);
    const about = dialog.getByText(
      "It reaches only https servers on the public internet, never this machine or its network, and follows no redirect.",
      { exact: true },
    );
    await about.waitFor();
    await opened(dialog);
    const label = await dialog.getByText("Public addresses only", { exact: true }).boundingBox();
    const said = await about.boundingBox();
    assert.ok(label && said && said.y > label.y + label.height && said.x === label.x, "under it");
    // A field whose schema says nothing has nothing under it.
    assert.equal(await dialog.locator("p").count(), 1);
    await page.close();
  }),
);

test(
  "a command takes its arguments one per line and its secrets by name",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/mcps/add");
    const dialog = connectForm(page);
    await dialog.getByRole("combobox", { name: "Kind" }).click();
    await page.getByRole("option", { name: /starts/ }).click();
    await dialog.getByLabel("Name").fill("Search");
    await dialog.getByLabel("Command").fill("search-mcp");
    await dialog.getByLabel("Args").fill("--index\n/my docs");
    await dialog.getByRole("button", { name: "Add a secret" }).click();
    const connect = dialog.getByRole("button", { name: "Connect" });
    assert.equal(await connect.isDisabled(), true, "a half-written secret holds it back");
    await dialog.getByLabel("Secret name").fill("API_KEY");
    await dialog.getByLabel("Secret value").fill("k");
    await connect.click();
    await dialog.waitFor({ state: "detached" });
    assert.deepEqual(gateway.calls.findLast((c) => c.method === "create")?.input, {
      provider: "local",
      kind: "command",
      params: { command: "search-mcp", args: ["--index", "/my docs"] },
      name: "Search",
      secrets: { API_KEY: "k" },
    });
    await page.close();
  }),
);

test(
  "a refused connection keeps the form and says why",
  withGateway(async (gateway) => {
    gateway.refuseNext("connections.create", "invalid", "url: its parameters don't fit.");
    const page = await open(gateway, "#/mcps/add");
    const dialog = connectForm(page);
    await dialog.getByLabel("Name").fill("Bad");
    await dialog.getByLabel("Address", { exact: true }).fill("nope");
    await dialog.getByRole("button", { name: "Connect" }).click();
    await dialog.getByRole("alert").getByText("url: its parameters don't fit.").waitFor();
    assert.equal(await dialog.getByLabel("Address", { exact: true }).inputValue(), "nope");
    await page.close();
  }),
);

test(
  "a connection is exposed under a slug of its name, or the Hub's name on a clash",
  withGateway(async (gateway) => {
    gateway.connections.set("c-other", {
      connection: "c-other",
      name: "GitHub",
      origin: {
        provider: "local",
        kind: "url",
        target: "https://example.com",
        madeBy: "person",
        at: new Date().toISOString(),
      },
      status: { state: "connected", tools: [] },
    });
    const page = await open(gateway, "#/a/a-reviewer");
    await openSetup(page, "Reviewer");
    await page.getByRole("region", { name: "MCPs" }).getByText("github", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Add an MCP" }).click();
    await page.getByRole("menuitem", { name: "GitHub", exact: true }).click();
    await page.getByRole("region", { name: "MCPs" }).getByText("generated_tools").waitFor();
    assert.deepEqual(gateway.calls.findLast((c) => c.method === "expose")?.input, {
      agent: "a-reviewer",
      connection: "c-other",
    });
    await page.getByRole("button", { name: "Add an MCP" }).click();
    await page.getByRole("menuitem", { name: "Postgres analytics" }).click();
    await page.getByRole("region", { name: "MCPs" }).getByText("postgres_analytics").waitFor();
    assert.deepEqual(gateway.calls.findLast((c) => c.method === "expose")?.input, {
      agent: "a-reviewer",
      connection: "c-postgres",
      as: "postgres_analytics",
    });
    await page.close();
  }),
);
