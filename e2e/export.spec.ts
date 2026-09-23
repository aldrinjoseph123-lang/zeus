import { test, expect } from '@playwright/test';

/** The Excel button hands over the list as filtered: the file arrives, named for the list and the day. */
test('the deals list exports to Excel', async ({ page }) => {
  await page.goto('/deals?view=list');
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Excel', exact: true }).click(),
  ]);
  expect(file.suggestedFilename()).toMatch(/^zeus-deals-\d{4}-\d{2}-\d{2}\.xlsx$/);
  await expect(page.getByText('Excel downloaded.')).toBeVisible();
});
