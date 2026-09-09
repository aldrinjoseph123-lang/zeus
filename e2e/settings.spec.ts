import { test, expect } from '@playwright/test';

/**
 * One setting, one control.
 *
 * "Require the bot check to sign in to Zeus" shipped to production drawn twice on the
 * same page: the Sign-in card renders every `auth.*` key by prefix, and the Turnstile
 * panel renders that one key deliberately, beside the keys it depends on. Two controls,
 * one stored value — tick either and the other looks wrong until the page reloads.
 *
 * It cannot be settled by reading the source: a group renders a whole prefix, and the
 * keys it is told to skip arrive as a computed constant. On the rendered page it is just
 * a matter of counting, which is why this lives here rather than in the static checks.
 */
const SECTIONS = [
  'company', 'finance', 'lists', 'fields', 'pipelines', 'users', 'roles',
  'targets', 'notifications', 'integrations', 'portal', 'backups',
];

/**
 * Labels that legitimately repeat on one page, each for a stated reason. A new duplicate
 * is not on this list and fails, which is the point.
 */
const ALLOWED_REPEATS: Record<string, string[]> = {
  lists: ['Name'], // one row per editable list, each with its own name field
  pipelines: ['Name'], // one per stage
  fields: ['Name'], // one per custom field
  users: ['Name', 'Email'], // the user form and the team form sit on one page
  roles: ['Name'],
  targets: ['Target (AED)'], // one per person per quarter
};

test.describe('settings draw each setting once', () => {
  for (const section of SECTIONS) {
    test(`${section}: no two controls share a label`, async ({ page }) => {
      await page.goto(`/settings/${section}`);
      await expect(page.locator('main')).toBeVisible();
      // Panels load their own data; give the last of them a moment to draw.
      await page.waitForTimeout(1_500);

      // The visible name of every control a person could change. Field puts the label in
      // the first span and the hint after the control, both inside the same <label> — so
      // read the span rather than the element's whole text.
      const names = await page
        .locator('main input:not([type=hidden]), main select, main textarea')
        .evaluateAll((els) =>
          els.map((el) => {
            const label = el.closest('label');
            const text = label?.querySelector('span')?.textContent ?? label?.textContent ?? el.getAttribute('aria-label') ?? '';
            return text.replace(/\s+/g, ' ').replace(/\s*\*$/, '').trim();
          }).filter(Boolean),
        );

      // A setting with no entry in the labels map falls back to its own key, so the page
      // shows `poPaymentTermsDays` where it meant "Purchase order payment terms (days)".
      // Eight of the fourteen finance settings were doing exactly that.
      const rawKeys = [...new Set(names.filter((n) => /^[a-z]+[A-Z]/.test(n) && !n.includes(' ')))];
      expect(rawKeys, `these controls are labelled with their setting key on /settings/${section}`).toEqual([]);

      const allowed = new Set(ALLOWED_REPEATS[section] ?? []);
      const seen = new Map<string, number>();
      for (const n of names) seen.set(n, (seen.get(n) ?? 0) + 1);

      const duplicated = [...seen.entries()]
        .filter(([name, count]) => count > 1 && !allowed.has(name))
        .map(([name, count]) => `${name} ×${count}`);

      expect(duplicated, `two controls for one setting on /settings/${section}`).toEqual([]);
    });
  }
});
