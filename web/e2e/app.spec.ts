import { expect, fits, fullTextFits, screenshot, test, value } from "./fixture.ts";

test("sign-in, navigation, keyboard, disclosure and close confirmation", async ({
  app,
  page,
}, info) => {
  await page.goto(app.url);
  await expect(page.getByRole("heading", { name: "Signed out" })).toBeVisible();
  await screenshot(page, "signedout", info.project.name);
  await app.signIn(page);
  await fits(page);
  await screenshot(page, "dashboard", info.project.name);
  const reports = page.getByRole("region", { name: "Reports", exact: true });
  const releaseDisclosure = reports.getByRole("button", { name: "release: actors under it" });
  const storageRow = reports.getByRole("link", { name: /^storage.*Last update/ });
  await releaseDisclosure.click();
  await expect(storageRow).not.toBeVisible();
  await releaseDisclosure.press("Space");
  await expect(storageRow).toBeVisible();
  await fits(page);
  await screenshot(page, "organization", info.project.name);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog", { name: "Jump to" })).toBeVisible();
  await screenshot(page, "palette", info.project.name);
  await page.getByPlaceholder("Jump to…").fill("release");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Jump to" })).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "release", exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Items", exact: true })).toBeVisible();
  await fits(page);
  await screenshot(page, "actor", info.project.name);
  await page.getByRole("button", { name: "Close actor", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("button", { name: "Close actor", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("link", { name: /storage/ })).toBeVisible();
  await screenshot(page, "close-dialog", info.project.name);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Jump to…").fill("Activity");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Jump to" })).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeAttached();
  await expect(page.getByText("set its progress").first()).toBeVisible();
  await fits(page);
  await screenshot(page, "activity", info.project.name);
  const organization = page.getByRole("navigation", { name: "Organization", exact: true });
  if (!(await organization.isVisible()))
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
  await expect(organization).toBeVisible();
  const disclosure = organization.getByRole("button", { name: "release: actors under it" });
  await disclosure.click();
  await expect(organization.getByRole("link", { name: /^storage/ })).not.toBeVisible();
  await disclosure.click();
  await organization.getByRole("link", { name: /^storage/ }).click();
  await expect(page.getByRole("heading", { name: "storage", exact: true })).toBeVisible();
  if (info.project.name === "mobile") await expect(organization).not.toBeVisible();
  await page.getByRole("button", { name: "Close actor", exact: true }).click();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Close actor", exact: true }).click();
  await dialog.getByRole("button", { name: "Close actor", exact: true }).click();
  await expect(page.getByRole("heading", { name: "release", exact: true })).toBeVisible();
  const team = await value<{ positions: { id: string; closed_at: string | null }[] }>(
    app.root,
    "team",
    { depth: 20 },
  );
  expect(team.positions.some(({ id }) => id === app.storage.id)).toBe(false);
});

test("answers and replies reach the core, approvals require Send", async ({ app, page }, info) => {
  await app.signIn(page);
  const approval = page.getByRole("article", { name: /Question from storage:/ });
  const send = approval.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeDisabled();
  await approval.focus();
  await page.keyboard.press("j");
  await expect(page.getByRole("article", { name: /Question from platform:/ })).toBeFocused();
  await page.keyboard.press("k");
  await expect(approval).toBeFocused();
  await page.keyboard.press("1");
  await expect(approval.getByRole("button", { name: /^Approve/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(
    (await app.questions()).questions.find(({ id }) => id === app.approval.id)?.answer,
  ).toBeNull();
  await expect(send).toBeEnabled();
  await send.click();
  await expect(approval).not.toBeVisible();
  expect(
    (await app.questions()).questions.find(({ id }) => id === app.approval.id)?.answer?.choice,
  ).toBe("Approve");
  const question = page.getByRole("article", { name: /Question from platform:/ });
  await question.focus();
  await page.keyboard.press("r");
  const composer = page.getByRole("form", { name: "Reply", exact: true });
  await expect(composer.getByRole("textbox")).toBeFocused();
  await composer.getByRole("textbox").fill("Keep the current preview.");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(question).not.toBeVisible();
  expect(
    (await app.questions()).questions.find(({ id }) => id === app.question.id)?.answer?.text,
  ).toBe("Keep the current preview.");
  const message = page.getByRole("article", { name: /Message from design:/ });
  await message.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.getByRole("list", { name: "Answers", exact: true })).toBeVisible();
  await composer.getByRole("textbox").fill("Navigation is approved for review.");
  await fits(page);
  for (const dismiss of await page
    .getByRole("button", { name: "Dismiss", exact: true, includeHidden: true })
    .all())
    await dismiss.click();
  await expect(
    page.getByRole("button", { name: "Dismiss", exact: true, includeHidden: true }),
  ).toHaveCount(0);
  await screenshot(page, "reply", info.project.name);
  await composer.getByRole("button", { name: "Send", exact: true }).click();
  await expect(message).not.toBeVisible();
  const received = (await app.messages(app.design.id)).messages;
  expect(
    received.some(
      (item) =>
        item.text === "Navigation is approved for review." && item.reply_to === app.message.id,
    ),
  ).toBe(true);
  expect(
    (await app.messages(app.rootId)).messages.find(({ id }) => id === app.message.id)?.read_at,
  ).toBeTruthy();
  await expect(page.getByText("Nothing is waiting on you", { exact: true })).toBeVisible();
  await page.getByText("Nothing is waiting on you", { exact: true }).scrollIntoViewIfNeeded();
  await screenshot(page, "empty-inbox", info.project.name);
});

test("actor composer, history and long content remain reachable", async ({ app, page }, info) => {
  await app.signIn(page);
  await page.goto(`${app.url}/people/${app.release.id}`);
  await expect(page.getByRole("heading", { name: "release", exact: true })).toBeVisible();
  await page.keyboard.press("r");
  const composer = page.getByRole("form", { name: "Message release", exact: true });
  await expect(composer.getByRole("textbox")).toBeFocused();
  await composer.getByRole("textbox").fill("Please keep the review open.");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.getByRole("list", { name: "Sent, not read yet", exact: true })).toContainText(
    "Please keep the review open.",
  );
  expect(
    (await app.messages(app.release.id)).messages.some(
      ({ text }) => text === "Please keep the review open.",
    ),
  ).toBe(true);
  await composer.getByRole("textbox").press("Escape");
  await page.keyboard.press("h");
  const history = page.getByRole("region", { name: "History", exact: true });
  await expect(history).toBeVisible();
  await history.scrollIntoViewIfNeeded();
  await fits(page);
  await screenshot(page, "history", info.project.name);
  await value(app.design.client, "message_send", {
    to: app.rootId,
    text: `Long review\n${"Detailed feedback for the actor. ".repeat(80)}`,
    links: [{ url: `https://example.com/${"a".repeat(150)}` }],
  });
  await page.goto(app.url);
  const long = page.getByRole("article", { name: /Message from design: Long review/ });
  await expect(long).toBeVisible();
  await long.getByRole("button", { name: "Mark read", exact: true }).scrollIntoViewIfNeeded();
  const link = long.getByRole("link", { name: /^example.com/ });
  await expect(link).toBeVisible();
  const linkRight = await link.evaluate((element) => element.getBoundingClientRect().right);
  expect(linkRight).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
  await fits(page);
  await long.getByRole("button", { name: "Mark read", exact: true }).click();
  await expect(long).not.toBeVisible();
});

test("long option labels and artifact filenames wrap within their surfaces", async ({
  app,
  page,
}, info) => {
  const label = "Keep the verified release candidate available until the next scheduled review";
  const filename = `artifact_${"W".repeat(140)}.tar.gz`;
  await value(app.platform.client, "question_ask", {
    text: "Choose the artifact review policy",
    options: [{ label }, { label: "W".repeat(80) }],
    recommendation: label,
  });
  await value(app.design.client, "message_send", {
    to: app.rootId,
    text: `${filename}\nStored artifact: ${filename}`,
  });
  await app.signIn(page);
  const question = page.getByRole("article", {
    name: /Question from platform: Choose the artifact/,
  });
  await expect(question.getByRole("button", { name: label, exact: false })).toBeVisible();
  await fullTextFits(question);
  await fits(page);
  await question.scrollIntoViewIfNeeded();
  await screenshot(page, "long-options", info.project.name);
  const message = page.getByRole("article", { name: /Message from design: artifact_/ });
  await expect(message).toContainText(`${filename}Stored artifact: ${filename}`);
  await fullTextFits(message);
  await message.scrollIntoViewIfNeeded();
  await screenshot(page, "long-filename", info.project.name);
  await question.getByRole("button", { name: "Answer", exact: true }).click();
  const composer = page.getByRole("form", { name: "Reply", exact: true });
  await expect(composer.getByRole("button", { name: label, exact: true })).toBeVisible();
  await fullTextFits(composer.getByRole("group", { name: "Choice", exact: true }));
  await fits(page);
  await screenshot(page, "long-choice-composer", info.project.name);
  await composer.getByRole("button", { name: label, exact: true }).click();
  await composer.getByRole("button", { name: "Send", exact: true }).click();
  await expect(question).not.toBeVisible();
  expect((await app.questions()).questions.some(({ answer }) => answer?.choice === label)).toBe(
    true,
  );
});

test("missing actor and unreachable core states", async ({ app, page }, info) => {
  await app.signIn(page);
  await page.goto(`${app.url}/people/unknown`);
  await expect(page.getByRole("heading", { name: "Not found", exact: true })).toBeVisible();
  await fits(page);
  await screenshot(page, "not-found", info.project.name);
  await app.stopCore();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "agentorg is not reachable", exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await fits(page);
  await screenshot(page, "unreachable", info.project.name);
});
