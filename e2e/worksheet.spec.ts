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

    // Excel: refused until a manager signs the quote off, then handed over.
    await page.getByRole('button', { name: 'Worksheet' }).click();
    await page.getByRole('button', { name: /^excel$/i }).click();
    await expect(page.getByText(/has not been approved yet/)).toBeVisible();

    expect((await request.post(`/api/approvals/quotes/${quote.id}/submit`, { data: {} })).status()).toBe(200);
    expect((await request.post(`/api/approvals/quotes/${quote.id}/approve`, { data: {} })).status()).toBe(200);

    const [file] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /with formulas/i }).click(),
    ]);
    expect(file.suggestedFilename()).toBe(`${quote.number}-worksheet-formulas.xlsx`);

    // Re-pricing an approved quote voids the sign-off, and the bar says why.
    await page.getByLabel('Default markup on cost, percent').fill('30');
    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(page.getByText(/prices changed after it was approved/)).toBeVisible();

    expect(errors.filter((e) => !/status of 400/.test(e))).toEqual([]);
  });

  test('a new VAT rate moves the totals on screen before saving, to what the server then stores', async ({ page, request }) => {
    const accounts = await (await request.get(`/api/accounts?search=${encodeURIComponent(E2E_ACCOUNT)}`)).json();
    const quote = await (await request.post('/api/quotes', {
      data: { accountId: accounts.data[0].id, lines: [{ description: 'Firewall support, one year', quantity: 1, unitPrice: 1000 }] },
    })).json();

    await page.goto(`/quotes/${quote.id}`);
    const total = page.getByText('Total', { exact: true }).locator('..');
    await expect(total).toContainText('1,050.00');

    // Zero-rated: the quote's rate governs every line, so the total drops at once.
    await page.getByLabel('VAT percent').fill('0');
    await expect(total).toContainText('1,000.00');

    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(page.getByText('Quote saved.')).toBeVisible();
    const saved = await (await request.get(`/api/quotes/${quote.id}`)).json();
    expect(Number(saved.total)).toBe(1000);
  });

  test('reads a pasted vendor quote in, checks it against the vendor total, and applies it', async ({ page, request }) => {
    const accounts = await (await request.get(`/api/accounts?search=${encodeURIComponent(E2E_ACCOUNT)}`)).json();
    const created = await request.post('/api/quotes', { data: { accountId: accounts.data[0].id, defaultMarkupPct: 20, lines: [] } });
    const quote = await created.json();

    await page.goto(`/quotes/${quote.id}`);
    await page.getByRole('button', { name: 'Worksheet' }).click();
    await page.getByRole('button', { name: 'Vendor quote' }).click();

    const pasted = [
      'Part Number\tDescription\tQty\tUnit Price\tTotal',
      'FG-3100F-BDL-950-12\tFortiGate-3100F Hardware\t2\t1,250.00\t2,500.00',
      '\tFortiCare onboarding\t1\t300.00\t300.00',
      '\tGrand Total (USD)\t\t\t2,800.00',
    ].join('\n');
    await page.getByLabel('Paste').fill(pasted);
    await page.getByRole('button', { name: 'Read it' }).click();

    await expect(page.getByText(/Nothing was missed/)).toBeVisible();
    await page.getByRole('button', { name: /apply 2 lines/i }).click();
    await expect(page.getByText(/2 lines added/)).toBeVisible();

    // 1,250 USD at the stored rate, marked up by the quote's 20%: the line is priced, not typed.
    const sheet = page.locator('table').filter({ hasText: 'Vendor price' });
    await expect(sheet.locator('input[value="FG-3100F-BDL-950-12"]')).toBeVisible();
    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(page.getByText('Quote saved.')).toBeVisible();

    const saved = await (await request.get(`/api/quotes/${quote.id}`)).json();
    expect(saved.lines.map((l: { vendorCode: string | null }) => l.vendorCode)).toEqual(['FG-3100F-BDL-950-12', null]);
    expect(Number(saved.lines[0].vendorUnitCost)).toBe(1250);
    // The pasted text is kept with the quote.
    await expect(page.getByText('vendor-quote.txt')).toBeVisible();
  });

  test('on a new quote, a vendor quote is read at once and kept when the quote is created', async ({ page, request }) => {
    const accounts = await (await request.get(`/api/accounts?search=${encodeURIComponent(E2E_ACCOUNT)}`)).json();
    await page.goto(`/quotes/new?accountId=${accounts.data[0].id}`);
    await page.getByRole('button', { name: 'Worksheet' }).click();
    await page.getByRole('button', { name: 'Vendor quote' }).click();

    await page.getByLabel('Paste').fill([
      'Part Number\tDescription\tQty\tUnit Price\tTotal',
      'LIC-EDR-100\tEDR licence, per endpoint\t100\t42.00\t4,200.00',
      '\tTotal\t\t\t4,200.00',
    ].join('\n'));
    await page.getByRole('button', { name: 'Read it' }).click();
    await expect(page.getByText(/Nothing was missed/)).toBeVisible();
    await page.getByRole('button', { name: /apply 1 line/i }).click();

    await expect(page.getByText('Kept with the quote when you create it.')).toBeVisible();
    await page.getByRole('button', { name: /create quote/i }).click();
    await expect(page).toHaveURL(/\/quotes\/(?!new)[a-z0-9]+$/);

    const id = page.url().split('/').pop()!;
    const documents = await (await request.get(`/api/attachments?parent=quote&parentId=${id}`)).json();
    expect(documents.map((d: { filename: string }) => d.filename)).toEqual(['vendor-quote.txt']);
  });
});
