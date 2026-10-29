import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "../test-results",
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: "list",
  use: { browserName: "chromium", colorScheme: "dark" },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 720 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true } },
  ],
});
