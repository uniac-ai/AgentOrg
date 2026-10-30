import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Actor, connectActor, connectClient } from "@agentorg/cli/actor";
import { test as base, expect, type Locator, type Page } from "@playwright/test";

const repo = fileURLToPath(new URL("../../", import.meta.url));

/** Calls fail with their operation and state, without dumping credentials or rich API data. */
export async function value<T>(actor: Actor, name: string, input: Record<string, unknown> = {}) {
  const answer = await actor.call(name, input);
  if (answer.state !== "done") throw new Error(`${name}: ${answer.state}`);
  return answer.value as T;
}

function server(application: string, env: NodeJS.ProcessEnv) {
  const child = spawn(
    process.execPath,
    [join(repo, "dist/src", application, "bin.js"), "--port", "0"],
    { cwd: repo, env, stdio: ["ignore", "ignore", "pipe"] },
  );
  const exited = once(child, "exit");
  const url = new Promise<string>((resolveUrl, reject) => {
    const guard = setTimeout(() => reject(new Error(`${application} did not start`)), 15_000);
    child.once("error", reject);
    child.once("exit", () => {
      clearTimeout(guard);
      reject(new Error(`${application} exited before listening`));
    });
    child.stderr.on("data", (chunk) => {
      const match = String(chunk).match(/serving on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match?.[1]) {
        clearTimeout(guard);
        resolveUrl(match[1]);
      }
    });
  });
  return {
    pid: child.pid,
    url,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const guard = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try {
        await exited;
      } finally {
        clearTimeout(guard);
      }
    },
  };
}

interface Position {
  id: string;
  client: Actor;
}
interface Question {
  id: string;
  answer: { choice: string | null; text: string | null } | null;
}
interface Message {
  id: string;
  text: string;
  reply_to: string | null;
  read_at: string | null;
}

async function start() {
  const directory = await mkdtemp(join(tmpdir(), "agentorg-browser-"));
  const connections: Actor[] = [];
  const servers: ReturnType<typeof server>[] = [];
  const env = {
    ...process.env,
    HOME: directory,
    AGENTORG_HOME: directory,
    CODEX_HOME: join(directory, "codex"),
    AGENTORG_CREDENTIAL: "",
    AGENTORG_ACTOR_ID: "",
  };
  const close = async () => {
    await Promise.allSettled(connections.map((actor) => actor.close()));
    for (const instance of [...servers].reverse()) await instance.close();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const core = server("server", env);
    servers.push(core);
    const coreUrl = await core.url;
    const credential = (await readFile(join(directory, "root-credential"), "utf8")).trim();
    const actorId = (await readFile(join(directory, "root-actor"), "utf8")).trim();
    const root = await connectClient({ url: coreUrl, actorId, credential });
    connections.push(root);
    const { root: rootId, positions } = await value<{ root: string; positions: unknown[] }>(
      root,
      "team",
    );
    expect(positions).toHaveLength(1);
    const create = async (
      manager: Actor,
      name: string,
      purpose: string,
      state: string,
      summary: string,
    ): Promise<Position> => {
      const made = await value<{ actor: { id: string }; credential: string }>(
        manager,
        "actor_create",
        { name, purpose },
      );
      const client = await connectActor({
        url: coreUrl,
        actorId: made.actor.id,
        credential: made.credential,
        exposed: [],
      });
      connections.push(client);
      await value(client, "progress_set", { state, summary });
      return { id: made.actor.id, client };
    };
    const release = await create(
      root,
      "release",
      "Coordinate the October platform release.",
      "review",
      "The release is ready for review. Storage migration needs your approval.",
    );
    const platform = await create(
      root,
      "platform",
      "Keep the shared platform reliable.",
      "running",
      "Validating reconnect behavior and restoring the preview environment.",
    );
    const design = await create(
      root,
      "design",
      "Improve the organization dashboard.",
      "waiting",
      "The interface review is ready. Waiting for feedback on navigation.",
    );
    const storage = await create(
      release.client,
      "storage",
      "Deliver the storage schema change.",
      "blocked",
      "The migration is verified and waiting for a release decision.",
    );
    const documentation = await create(
      release.client,
      "documentation",
      "Publish accurate release documentation.",
      "running",
      "Checking examples against the packaged commands.",
    );
    const checks = await create(
      platform.client,
      "checks",
      "Verify platform behavior.",
      "review",
      "All connection and lifecycle checks passed.",
    );
    await value(release.client, "progress_set", {
      items: [
        {
          title: "Storage migration",
          state: "blocked",
          summary: "Fresh install and upgrade checks passed.",
          owner: storage.id,
          waits_on: [{ text: "Release approval" }],
        },
        {
          title: "Release documentation",
          state: "running",
          summary: "Review the setup examples and package instructions.",
          owner: documentation.id,
        },
        {
          title: "Package verification",
          state: "review",
          summary: "The installed commands work with a minimal PATH.",
          links: [{ url: "https://github.com/uniac-ai/AgentOrg", title: "Review changes" }],
        },
      ],
      links: [{ url: "https://github.com/uniac-ai/AgentOrg", title: "Release changes" }],
    });
    const approval = await value<Question>(storage.client, "question_ask", {
      to: release.id,
      text: "Approve the storage migration?\nFresh and upgrade checks passed. The migration is ready to run.",
      options: [
        { label: "Approve", detail: "Proceed with the verified migration." },
        { label: "Hold", detail: "Keep the release waiting for another review." },
      ],
      recommendation: "Approve",
      answerer: rootId,
    });
    const question = await value<Question>(platform.client, "question_ask", {
      text: "Which preview should we keep for the team?",
      options: [{ label: "Current preview" }, { label: "New preview" }],
      recommendation: "Current preview",
    });
    const message = await value<Message>(design.client, "message_send", {
      to: rootId,
      text: "Navigation review is ready\nThe sidebar and actor pages now share the same structure. Feedback is welcome.",
      links: [{ url: "https://github.com/uniac-ai/AgentOrg", title: "Interface review" }],
    });
    await value(platform.client, "claim", {
      resource: "preview",
      note: "Validating the release preview.",
    });
    const web = server("clients/web", { ...env, AGENTORG_URL: coreUrl });
    servers.push(web);
    const url = await web.url;
    return {
      url,
      root,
      rootId,
      release,
      platform,
      design,
      storage,
      checks,
      approval,
      question,
      message,
      inventory: {
        directory,
        processes: [
          { pid: core.pid, url: coreUrl },
          { pid: web.pid, url },
        ],
        actors: [release, platform, design, storage, documentation, checks].map(({ id }) => id),
      },
      async signIn(page: Page) {
        const response = await fetch(`${url}/signin/link`, {
          method: "POST",
          headers: { Authorization: `Bearer ${credential}` },
        });
        if (!response.ok) throw new Error(`sign-in link: ${response.status}`);
        const { path } = (await response.json()) as { path: string };
        await page.goto(url + path);
        await expect(page.getByRole("heading", { name: "You", exact: true })).toBeAttached();
      },
      questions: () => value<{ questions: Question[] }>(root, "questions", { open: false }),
      messages: (actor: string) => value<{ messages: Message[] }>(root, "messages", { actor }),
      stopCore: () => core.close(),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export const test = base.extend<{ app: Awaited<ReturnType<typeof start>> }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture argument.
  app: async ({}, use, info) => {
    const app = await start();
    try {
      const inventory = info.outputPath("owned-resources.json");
      await writeFile(inventory, JSON.stringify(app.inventory));
      await info.attach("owned-resources", { path: inventory, contentType: "application/json" });
      await use(app);
    } finally {
      await app.close();
    }
  },
});
export { expect };

/** Optional review evidence; no auth state or trace is saved. */
export async function screenshot(page: Page, name: string, project: string) {
  if (!process.env.AGENTORG_SCREENSHOTS) return;
  for (const dialog of await page.getByRole("dialog").or(page.getByRole("alertdialog")).all()) {
    await expect(dialog).toHaveCSS("opacity", "1");
  }
  await page.screenshot({
    animations: "disabled",
    path: resolve(
      process.env.AGENTORG_SCREENSHOTS,
      `after-${name}${project === "mobile" ? "-mobile" : ""}.png`,
    ),
  });
}

export async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const clipped = await page.locator("body *").evaluateAll((elements) =>
    elements
      .filter((node) => {
        const element = node as HTMLElement;
        const style = getComputedStyle(element);
        return (
          element.clientHeight > 1 &&
          !element.classList.contains("sr-only") &&
          ((element.scrollHeight > element.clientHeight + 1 &&
            ["hidden", "clip"].includes(style.overflowY)) ||
            (element.clientWidth > 1 &&
              element.scrollWidth > element.clientWidth + 1 &&
              ["hidden", "clip"].includes(style.overflowX) &&
              style.textOverflow !== "ellipsis")) &&
          element.getBoundingClientRect().height > 0
        );
      })
      .map((element) => ({
        tag: element.tagName,
        slot: element.getAttribute("data-slot"),
        class: element.className,
        height: element.clientHeight,
        content: element.scrollHeight,
        width: element.clientWidth,
        contentWidth: element.scrollWidth,
      })),
  );
  expect(clipped).toEqual([]);
}

/** Full-content surfaces must fit their text even when an inner element clips it. */
export async function fullTextFits(surface: Locator) {
  const overflow = await surface.locator("*").evaluateAll((elements) =>
    elements
      .filter(
        (element) =>
          element.textContent?.trim() &&
          element.clientWidth > 1 &&
          element.scrollWidth > element.clientWidth + 1 &&
          !element.classList.contains("sr-only"),
      )
      .map((element) => ({
        tag: element.tagName,
        class: element.className,
        text: element.textContent?.slice(0, 80),
        width: element.clientWidth,
        contentWidth: element.scrollWidth,
      })),
  );
  expect(overflow).toEqual([]);
}
