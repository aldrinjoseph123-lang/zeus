import { test, expect } from '@playwright/test';
import { E2E_ACCOUNT } from './global-setup';

/**
 * The quote worksheet, in a browser.
 *
 * The arithmetic is pinned by the API tests (quoteWorksheet.test.ts). What only a page can
 * show is that the working reaches the screen: the columns render, the live preview agrees
 * with what the server stores, and changing the default markup moves the lines that use
 * it before and after a save.
 */
test.describe('quote worksheet', () => {
  test('shows the working, reprices on a new default markup, and keeps it after saving', async ({ page, request }) => {
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    const accounts = await (await request.get(`/api/accounts?search=${encodeURIComponent(E2E_ACCOUNT)}`)).json();
    const customerId = accounts.data[0].id as string;
    const vendor = await (await request.post('/api/accounts', {
      data: { name: `E2E Vendor ${Date.now()}`, type: 'VENDOR', ignoreDuplicates: true },
    })).json();

    // The design's worksheet: USD and AED vendors, and an internal line.
    const created = await request.post('/api/quotes', {
      data: {
        accountId: customerId,
        defaultMarkupPct: 20,
        lines: [
          { description: 'FortiGate 3100F', vendorId: vendor.id, vendorCode: 'FG-3100', quantity: 2, vendorCurrency: 'USD', vendorUnitCost: 1250, fxRate: 3.6725 },
          { description: 'EDR licence, per endpoint', quantity: 100, vendorUnitCost: 42, markupPct: 15 },
          { description: 'Installation & commissioning', isInternal: true, quantity: 1, vendorUnitCost: 3500, markupPct: 30 },
        ],
      },
    });
    expect(created.status()).toBe(201);
    const quote = await created.json();

    await page.goto(`/quotes/${quote.id}`);
    await page.getByRole('button', { name: 'Worksheet' }).click();

    const sheet = page.locator('table').filter({ hasText: 'Vendor price' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('5,508.75')).toBeVisible();
    const foot = sheet.locator('tfoot');
    await expect(foot).toContainText('16,881.26');
    await expect(foot).toContainText('20,397.50');
    await expect(foot).toContainText('17.2%');

    // Nothing may push the page sideways: the sheet scrolls inside its own box.
    const widths = await page.evaluate(() => {
      const main = document.querySelector('main')!;
      return { scroll: main.scrollWidth, client: main.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    expect(widths.scroll, 'the page body scrolled sideways').toBeLessThanOrEqual(widths.client);
    expect(widths.page).toBeLessThanOrEqual(0);

    if (process.env.E2E_SCREENSHOT) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await sheet.scrollIntoViewIfNeeded();
      await page.screenshot({ path: process.env.E2E_SCREENSHOT });
    }

    // 4,590.625 × 1.25 — the FortiGate line takes the default; the other two keep their own.
    const markup = page.getByLabel('Default markup on cost, percent');
    await markup.fill('25');
    await expect(sheet.getByText('5,738.28')).toBeVisible();
    await expect(sheet.getByText('48.30')).toBeVisible();

    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(page.getByText('Quote saved.')).toBeVisible();

    await page.reload();
    await page.getByRole('button', { name: 'Worksheet' }).click();
    await expect(page.getByLabel('Default markup on cost, percent')).toHaveValue('25');
    await expect(page.locator('table').filter({ hasText: 'Vendor price' }).getByText('5,738.28')).toBeVisible();

    // The customer view shows the same prices, with the cells the worksheet owns locked.
    await page.getByRole('button', { name: 'Customer view' }).click();
    await expect(page.locator('input[value="5738.28"]')).toBeDisabled();

    expect(errors).toEqual([]);
  });
});
