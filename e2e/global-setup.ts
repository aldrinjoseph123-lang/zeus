import { request, type APIRequestContext } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';

/**
 * Take the instance past first-run setup, once, before any spec.
 *
 * A freshly seeded Zeus sends its administrator to /setup until the company details are
 * filled in — legal name, TRN, address, emirate, email, phone — because no tax invoice
 * can be issued without them. That is correct behaviour and the same thing CI's freshly
 * booted container does, so the specs have to get past it rather than pretend otherwise.
 *
 * Done over the API rather than by driving the wizard: it is setup for the tests, not a
 * test itself. Walking the wizard in the UI is worth its own spec later, against a
 * database that has never been configured.
 *
 * It also signs in exactly once and saves the session for every spec to reuse. Signing
 * in per test looks tidier and is wrong: the login route is rate limited on purpose, so
 * a suite that logs in repeatedly starts failing on 429 as it grows — which is the app
 * defending itself correctly, and a test design worth catching now rather than at test
 * number twenty.
 */
export const STORAGE_STATE = 'e2e/.auth/admin.json';
export const E2E_ACCOUNT = 'E2E Customer Ltd';
const EMAIL = process.env.E2E_EMAIL ?? 'admin@protect24x7.ae';
const PASSWORD = process.env.E2E_PASSWORD ?? 'CiBootCheck#2026';

/**
 * One customer to quote and invoice against. A freshly seeded Zeus has roles, a pipeline
 * and an administrator, and no accounts at all — so a journey that picks a customer has
 * nothing to pick without this.
 */
async function ensureFixtureAccount(api: APIRequestContext) {
  const res = await api.post('/api/accounts', {
    data: { name: E2E_ACCOUNT, type: 'CUSTOMER', ignoreDuplicates: true },
  });
  if (!res.ok() && res.status() !== 409) {
    throw new Error(`could not create the fixture account (${res.status()}): ${await res.text()}`);
  }
}

export default async function globalSetup() {
  const base = process.env.E2E_URL ?? 'http://localhost:4000';

  // Reuse a session that still works rather than signing in again. The login route is
  // rate limited, so a suite run repeatedly while iterating locks itself out after a
  // few goes — the app defending itself, and nothing a test should provoke once per run
  // when it does not have to. CI starts with no saved session and signs in once.
  let api = existsSync(STORAGE_STATE)
    ? await request.newContext({ baseURL: base, storageState: STORAGE_STATE })
    : await request.newContext({ baseURL: base });

  if (!(await api.get('/api/auth/me')).ok()) {
    await api.dispose();
    api = await request.newContext({ baseURL: base });
    const login = await api.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } });
    if (!login.ok()) {
      throw new Error(
        login.status() === 429
          ? `e2e sign-in was rate limited (429) against ${base}. The limiter is in memory, so restarting the API clears it — but a whole browser run legitimately exceeds the default 300/min from one address, so boot the instance under test with RATE_LIMIT_MAX set high (CI uses 5000).`
          : `e2e sign-in failed (${login.status()}) against ${base}. Check E2E_EMAIL / E2E_PASSWORD.`,
      );
    }
  }

  // Already configured? Then do nothing. Repeating the writes on every run burns the
  // global rate limit for no gain, which is what actually broke repeated local runs —
  // not the login limit it looked like at first.
  const status = await api.get('/api/setup/status');
  if (status.ok() && (await status.json()).finished) {
    await ensureFixtureAccount(api);
    mkdirSync('e2e/.auth', { recursive: true });
    await api.storageState({ path: STORAGE_STATE });
    await api.dispose();
    return;
  }

  const saved = await api.put('/api/settings', {
    data: {
      'company.legalName': 'Protect24x7 Information Technology L.L.C',
      'company.trn': '100123456700003',
      'company.addressLine1': 'Office 101, Business Bay',
      'company.emirate': 'Dubai',
      'company.email': 'accounts@protect24x7.example',
      'company.phone': '+971 4 000 0000',
    },
  });
  if (!saved.ok()) throw new Error(`could not complete setup (${saved.status()}): ${await saved.text()}`);

  // Filling the details is not the same as finishing the wizard: the layout bounces you
  // to /setup until setup.finishedAt is stamped, once per browser session. Every fresh
  // Playwright context is a fresh session, so without this each spec is redirected out
  // of whatever page it asked for — which is the app behaving correctly.
  const finished = await api.post('/api/setup/finish');
  if (!finished.ok()) throw new Error(`could not finish setup (${finished.status()}): ${await finished.text()}`);

  await ensureFixtureAccount(api);

  mkdirSync('e2e/.auth', { recursive: true });
  await api.storageState({ path: STORAGE_STATE });
  await api.dispose();
}
