import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://localhost:5173",
    viewport: { width: 1440, height: 1000 },
    channel: "chrome",
    screenshot: "only-on-failure",
    trace: "off",
  },
  reporter: "list",
  webServer: {
    command: "node scripts/dev.cjs",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 20000,
  },
});
