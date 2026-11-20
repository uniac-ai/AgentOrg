/**
 * Loaded before every test of the app (`--import`, in its test script): each test file, and all it
 * starts, runs with a home of its own. So no test can find the person's own AgentOrg Mac, which the
 * computer connector looks for in the home, nor anything else of theirs there, whether or not a
 * test gives the connector a folder of its own.
 */
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Playwright's browsers are still found where they are installed, under the real home.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(
  homedir(),
  ...(process.platform === "darwin" ? ["Library", "Caches"] : [".cache"]),
  "ms-playwright",
);
process.env.HOME = mkdtempSync(join(tmpdir(), "agentorg-test-home-"));
