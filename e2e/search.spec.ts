import { test, expect } from '@playwright/test';

/** The palette finds an invoice by its number — something it could not do before. */
test('⌘K finds an invoice by number', async ({ page, request }) => {
  const invoices = await (await request.get('/api/invoices?pageSize=1')).json();
  test.skip(!invoices.data.length, 'no invoice to look for');
  const number: string = invoices.data[0].number;

  await page.goto('/dashboard');
  await page.keyboard.press('ControlOrMeta+k');
  const box = page.getByPlaceholder(/Search or jump/);
  await box.fill(number);
  // The palette, not the sidebar: the group heading and the row sit beside the box.
  const palette = box.locator('..');
  const row = palette.getByRole('button', { name: new RegExp(number) }).first();
  await expect(row).toBeVisible();
  await expect(palette.locator('p.eyebrow', { hasText: /^Invoices$/ })).toBeVisible();
  if (process.env.E2E_SCREENSHOT) await page.screenshot({ path: process.env.E2E_SCREENSHOT, clip: { x: 200, y: 0, width: 700, height: 420 } });
  await row.click();
  await expect(page).toHaveURL(/\/invoices\/[a-z0-9]+$/);
});
