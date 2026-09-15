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
