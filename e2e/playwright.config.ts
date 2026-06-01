import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright visual layer for hive-mind wiki-web.
 *
 * This is the OPTIONAL screenshot/visual tier. The browserless backbone
 * (e2e/http-verify.mjs, `npm run e2e:http`) is what CI runs by default and needs
 * no browser binaries. Run this tier when you want real rendered screenshots:
 *
 *   npm i -D @playwright/test
 *   npx playwright install chromium
 *   npm run e2e:visual
 *
 * webServer seeds a dedicated fixture then boots the server on PORT 3942. The
 * seed + serve scripts shell out to the built CLI, so `npm run build` first.
 */
const PORT = 3942;
const DATA_DIR = './.e2e-tmp/mind-visual';

export default defineConfig({
  testDir: '.',
  testMatch: /visual\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  outputDir: './.e2e-tmp/playwright-output',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node seed.mjs ${DATA_DIR} && node serve.mjs ${DATA_DIR}`,
    env: { PORT: String(PORT) },
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    cwd: __dirname,
  },
});
