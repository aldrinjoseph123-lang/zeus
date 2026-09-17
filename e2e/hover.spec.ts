import { test, expect } from '@playwright/test';

/**
 * Hovering: a record's name previews it, a title becomes a Zeus tooltip, and a list row
 * offers its quick actions. All three come from one listener in components/hover.tsx, so a
 * change there can quietly break every screen at once. This test is the tripwire.
 */
test('hovering previews a record, shows a styled tooltip, and reveals row actions', async ({ page }) => {
  await page.goto('/accounts');
  const row = page.locator('tbody tr').first();
  const name = row.locator('[data-preview^="account:"]');
  await expect(name).toBeVisible();
  const card = page.locator('[data-hover-card]');

  await name.hover();
  await expect(card).toBeVisible();
  await expect(card).toContainText(await name.innerText());
  await expect(card).toContainText('Open deals');

  // Leaving the name closes the card.
  await page.mouse.move(2, 2);
  await expect(card).toBeHidden();

  // The row's actions appear on hover, and their title is a styled tooltip, not the browser's.
  const log = row.getByRole('button', { name: /log a call/i });
  await row.locator('td').nth(2).hover();
  await expect(log).toBeVisible();
  await log.hover();
  await expect(page.getByRole('tooltip')).toHaveText(/log a call/i);
  await expect(log).not.toHaveAttribute('title', /.+/);

  // Logging from the row opens the composer without leaving the list.
  await log.click();
  await expect(page.getByRole('dialog', { name: 'Log activity' })).toBeVisible();
  await expect(page).toHaveURL(/\/accounts$/);
});

/**
 * The long press. Three things have to hold at once and none of them is visible in the mouse
 * path: a finger lifting fires pointerout (which must not close the card), the tap that ends
 * the press must not follow the link, and a 10px slide must cancel the press instead. The
 * pointerout half was already wrong once during the build.
 */
test('a long press previews on a touch screen, and a tap still opens the record', async ({ browser }) => {
  const ctx = await browser.newContext({
    storageState: 'e2e/.auth/admin.json',
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const card = page.locator('[data-hover-card]');

  // Accounts, not leads: a freshly seeded container has accounts on day one and need not have leads.
  await page.goto('/accounts');
  const name = page.locator('tbody tr [data-preview^="account:"]').first();
  await expect(name).toBeVisible();
  const box = (await name.boundingBox())!;
  const x = box.x + 8;
  const y = box.y + box.height / 2;

  // Press and hold: the card opens and the tap that ends the press is swallowed.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(card).toBeVisible();
  await expect(page).toHaveURL(/\/accounts$/);

  // A tap elsewhere puts it away; a plain tap on the name opens the record. Read the name's
  // position again first: closing the card lets the page settle, and the row moves with it.
  await page.touchscreen.tap(20, 800);
  await expect(card).toBeHidden();
  const settled = (await name.boundingBox())!;
  await page.touchscreen.tap(settled.x + 8, settled.y + settled.height / 2);
  await expect(page).toHaveURL(/\/accounts\/.+/);
  await ctx.close();
});
