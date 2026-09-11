import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The rules a machine can check, checked on the page the browser actually painted.
 *
 * This project has now shipped two contrast failures it could not see: a muted line at
 * 2.85:1 on the splash, and the dashboard's server-error banner at 2.10:1 in dark mode —
 * the most urgent thing on the screen, drawn in a light-mode red on a dark wash. Both
 * were found by reading CSS and doing the arithmetic by hand, which is not a process
 * that scales past the person willing to do it.
 *
 * Every page runs in both themes, because a token that resolves per theme fails in only
 * one of them, and the one it fails in is never the one being looked at.
 */
const PAGES = [
  '/dashboard', '/deals', '/leads', '/accounts', '/contacts',
  '/quotes', '/invoices', '/reports', '/settings/company', '/partners',
];

/**
 * Serious and critical only. axe's "moderate" bucket is largely landmark and
 * heading-order advice — worth doing, not worth blocking a release on while the
 * serious ones are still open.
 */
const IMPACTS = ['serious', 'critical'];

/**
 * Known debt, pinned rather than blocking — the same shape as the delete sweep's
 * NO_CHILDREN list: an entry needs a reason, and a reason for something that no longer
 * applies is a comment pretending to be a rule.
 *
 * Empty for the second time, and again because the entry it held got fixed rather than
 * tolerated. It first held sixty-eight contrast failures from the always-dark chrome;
 * then eight from the accent red being read as small text, which now has a readable
 * counterpart every screen uses. The mechanism stays for the next thing worth pinning.
 */
const KNOWN: Record<string, { max: number; why: string }> = {};

interface Hit { rule: string; impact: string; page: string; html: string }

/** One context per theme rather than one per page — 18 sign-ins is the slow way. */
async function sweep(browser: import('@playwright/test').Browser, theme: 'light' | 'dark'): Promise<Hit[]> {
  const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  await ctx.addInitScript((t) => localStorage.setItem('zeus.theme', t), theme);
  const page = await ctx.newPage();
  const hits: Hit[] = [];
  for (const path of PAGES) {
    await page.goto(path);
    await expect(page.locator('main')).toBeVisible();
    // Panels fetch their own data; let the last of them draw before scanning.
    await page.waitForTimeout(900);
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    for (const v of violations) {
      if (!IMPACTS.includes(v.impact ?? '')) continue;
      for (const node of v.nodes) {
        hits.push({ rule: v.id, impact: v.impact ?? '', page: `${theme}${path}`, html: node.html.slice(0, 90) });
      }
    }
  }
  await ctx.close();
  return hits;
}

test.describe('accessibility', () => {
  // One browser walk shared by both assertions below.
  let hits: Hit[];
  test.beforeAll(async ({ browser }) => {
    hits = [...(await sweep(browser, 'light')), ...(await sweep(browser, 'dark'))];
  });

  test('no serious or critical violation on any screen, in either theme', async () => {
    const unknown = hits.filter((h) => !KNOWN[h.rule]);
    const report = [...new Set(unknown.map((h) => `${h.rule} [${h.impact}] ${h.page}\n      ${h.html}`))];
    expect(unknown.map((h) => h.rule), `new accessibility violations:\n    ${report.join('\n    ')}`).toEqual([]);
  });

  test('the pinned debt does not grow, and is removed once it is gone', async () => {
    for (const [rule, { max, why }] of Object.entries(KNOWN)) {
      const n = hits.filter((h) => h.rule === rule).length;
      expect(n, `${rule} grew past its pinned ceiling — ${why}`).toBeLessThanOrEqual(max);
      /*
       * Deliberately not asserting this still occurs.
       *
       * When the pinned debt was sixty-eight nav elements it was structural — present on
       * every page, on every install, so a count of zero meant somebody had fixed it and
       * the exemption was stale. What is left is on data-driven rows, so an instance with
       * no partners and no quotes legitimately reports zero. CI boots exactly that
       * instance. A staleness check that cannot tell "fixed" from "nothing to render" is
       * a check that fails on an empty database, which is the one place it should not.
       */
    }
  });
});
