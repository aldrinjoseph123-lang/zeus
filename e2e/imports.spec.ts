import { test, expect } from '@playwright/test';
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Importing contacts, with the accounts they belong to settled first.
 *
 * The file carries a note on its header, as Zeus's own template does — the shape that once
 * stopped every re-saved template from uploading. Its rows name an account Zeus has never seen,
 * one it has under a slightly different name, and none at all; the import must not run until
 * each is answered, and must not create a contact without an account.
 */
test('contacts import screens their accounts before anything is written', async ({ page, request }) => {
  const stamp = Date.now();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('contacts');
  [
    ['First name', 'Last name', 'Account name', 'Email'],
    ['Layla', 'Haddad', `Screening Partner ${stamp}`, `layla@screening${stamp}.ae`],
    ['Rana', '', '', `rana@blankrow${stamp}.co`],
    ['Sami', 'Khoury', '', ''],
  ].forEach((r) => ws.addRow(r));
  ws.getCell('A1').note = 'Required.';
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'zeus-e2e-')), 'contacts.xlsx');
  await wb.xlsx.writeFile(file);

  await page.goto('/imports');
  await page.locator('select').first().selectOption('contacts');
  await page.locator('input[type=file]').setInputFiles(file);
  await expect(page.getByText('2. Map the columns')).toBeVisible();
  await page.getByRole('button', { name: /^preview$/i }).click();

  await expect(page.getByText('3. Settle the accounts')).toBeVisible();
  const cont = page.getByRole('button', { name: /continue to preview/i });
  await expect(cont).toBeDisabled();

  // Everything new is a partner; the row with nothing to go on is left out.
  await page.getByLabel('Type for every new account').selectOption('PARTNER');
  await page.getByLabel('What to do with row 4').selectOption('skip');
  await expect(cont).toBeEnabled();
  await cont.click();

  await expect(page.getByText('Nothing has been written yet')).toBeVisible();
  await page.getByRole('button', { name: /^import$/i }).click();
  await expect(page.getByText('Import finished.')).toBeVisible();

  const layla = (await (await request.get(`/api/contacts?search=Haddad`)).json()).data.find((c: { email: string }) => c.email === `layla@screening${stamp}.ae`);
  expect(layla?.account?.name).toBe(`Screening Partner ${stamp}`);
  const accounts = (await (await request.get(`/api/accounts?search=${encodeURIComponent(`Screening Partner ${stamp}`)}`)).json()).data;
  expect(accounts[0].type).toBe('PARTNER');
  const rana = (await (await request.get(`/api/contacts?search=rana@blankrow${stamp}.co`)).json()).data;
  expect(rana[0]?.account?.name).toMatch(/^Blankrow/i);
  const sami = (await (await request.get('/api/contacts?search=Khoury')).json()).data;
  expect(sami).toHaveLength(0);

  // And it can be taken back from the history: the newest row is this import.
  const row = page.getByRole('row').filter({ hasText: 'contacts.xlsx' }).first();
  await row.getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('button', { name: 'Undo import' }).click();
  await expect(page.getByText('Import undone')).toBeVisible();
  await expect(page.getByText(/4 removed/)).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  const gone = (await (await request.get(`/api/contacts?search=layla@screening${stamp}.ae`)).json()).data;
  expect(gone).toHaveLength(0);
  await expect(page.getByRole('row').filter({ hasText: 'contacts.xlsx' }).first().getByText('undone')).toBeVisible();
});
