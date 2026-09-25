import { test, expect } from '@playwright/test';
import { E2E_ACCOUNT } from './global-setup';

/** A customer, with no account in Zeus, accepts a quotation from its link. */
test('a customer accepts a quotation from the link, and the quote turns Accepted', async ({ browser, request }) => {
  const accounts = await (await request.get(`/api/accounts?search=${encodeURIComponent(E2E_ACCOUNT)}`)).json();
  const quote = await (await request.post('/api/quotes', {
    data: { accountId: accounts.data[0].id, lines: [{ description: 'Firewall support, one year', quantity: 1, unitPrice: 1000 }] },
  })).json();
  await request.post(`/api/approvals/quotes/${quote.id}/submit`, { data: {} });
  await request.post(`/api/approvals/quotes/${quote.id}/approve`, { data: {} });
  const link = await (await request.post(`/api/quotes/${quote.id}/accept-link`, { data: {} })).json();

  // A fresh browser with no Zeus session: the customer.
  const customer = await (await browser.newContext()).newPage();
  await customer.goto(new URL(link.url).pathname);
  await expect(customer.getByRole('heading', { name: quote.number })).toBeVisible();
  await expect(customer.getByText('1,050.00')).toBeVisible();
  await expect(customer.getByText(/margin|cost/i)).toHaveCount(0);
  await customer.getByLabel('Your name').fill('Fatima Al Hashimi');
  await customer.getByLabel('Your email').fill('fatima@example.com');
  await customer.getByRole('button', { name: `Accept quotation ${quote.number}` }).click();
  await expect(customer.getByText(/Accepted by Fatima Al Hashimi on/)).toBeVisible();
  if (process.env.E2E_SCREENSHOT) await customer.screenshot({ path: process.env.E2E_SCREENSHOT, fullPage: true });

  const after = await (await request.get(`/api/quotes/${quote.id}`)).json();
  expect(after.status).toBe('ACCEPTED');
  expect(after.acceptedByName).toBe('Fatima Al Hashimi');
});
