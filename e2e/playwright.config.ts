import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests against a running Zeus.
 *
 * Points at the built container by default, which is what CI already boots on :4000 to
 * prove the image serves traffic — so these run against the real artefact rather than a
 * dev server that differs from it. Set E2E_URL to aim somewhere else while iterating.
 *
 * Deliberately small: no page objects, no fixture library, no helpers beyond signing in.
 * The value here is covering journeys that nothing else touches, not building a second
 * framework to maintain. 427 API tests already cover the routes underneath.
 */
export default defineConfig({
  testDir: '.',
  globalSetup: './global-setup.ts',
  // A failing browser test that "passes on retry" is a failing browser test. Retry once
  // in CI only, where a cold container can genuinely lose the first request.
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  // Generous on purpose. A dev server answering in seconds is not a failure worth
  // reporting, and a browser test that fails on a slow machine teaches people to rerun
  // rather than to read. Anything genuinely broken fails on the assertion, not the clock.
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_URL ?? 'http://localhost:4000',
    // Signed in once in global setup. The login form has a spec of its own; everything
    // else starts from a session, because the login route is rate limited by design.
    storageState: 'e2e/.auth/admin.json',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
