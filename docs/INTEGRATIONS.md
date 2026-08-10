# Zeus — Integrations setup

Everything lives in **Settings → Integrations**. Each integration shows a live
**heartbeat** badge (Healthy / Error / Not set up) and collapses to keep the page
short — click a header to expand its fields.

Replace `http://localhost:5174` below with your real `APP_URL` in production.

---

## 1. Microsoft 365

One Entra app registration powers **sign-in (SSO)**, **Outlook email** (quotes &
alerts), **Teams cards**, and **OneDrive/SharePoint backup**.

### In the Entra admin centre (entra.microsoft.com)

1. **App registrations → New registration**
   - Name: `Zeus CRM`
   - Supported account types: **Single tenant** (this org only)
   - Register.

2. **Authentication → Add a platform → Web.** Add **both** redirect URIs under the
   **Web** platform (not SPA):
   ```
   http://localhost:5174/api/auth/microsoft/callback
   http://localhost:5174/api/auth/microsoft/consent-callback
   ```
   > Missing/misplaced URIs → `AADSTS500113: No reply address is registered`.

3. **Certificates & secrets → New client secret.** Copy the **Value** column
   immediately (shown once) — **not** the Secret ID.
   > Pasting the ID (a GUID) → `AADSTS7000215: Invalid client secret`.

4. **API permissions → Microsoft Graph → Application permissions.** Add:
   - `Mail.Send`
   - `Files.ReadWrite.All`
   - `User.Read.All`

   Delegated permissions for SSO (usually present by default): `openid`,
   `profile`, `email`, `offline_access`, `User.Read`.

5. Copy the three IDs from the app **Overview**: Directory (tenant) ID,
   Application (client) ID, and the secret Value.

### In Zeus (Settings → Integrations → Microsoft 365)

1. Paste **Directory (tenant) ID**, **Application (client) ID**, **Client secret**.
2. Fill the delivery fields:
   - **Sending mailbox** — shared mailbox Zeus sends from, e.g. `crm@protect24x7.com`
   - **Backup OneDrive account** — UPN whose OneDrive receives the nightly backup
   - **Backup folder** — created automatically if missing (default `Zeus CRM Backups`)
   - **SharePoint drive ID** — optional, use instead of a personal OneDrive
3. **Save** → **Grant admin consent** (a tenant admin approves the app permissions).
4. **Test connection** → expect *Mailbox found*. Heartbeat turns **Healthy**.
5. **Send test email** to confirm Mail.Send end-to-end.

### SSO behaviour

- Accounts outside your tenant are rejected.
- Unknown Microsoft users are refused unless **Settings → Integrations → Sign-in →
  "Create users automatically on first Microsoft sign-in"** is enabled.

---

## 2. WhatsApp alerts

Meta Cloud API. Sends the same events as Teams/email to a handset. Alerts are
**business-initiated**, so Meta requires a pre-approved **template**, billed per
message on a production number (free on a test number, to 5 verified recipients).

### In Meta (developers.facebook.com)

1. **My Apps → Create App → Business.**
2. **Add product → WhatsApp → Set up.** This creates a free **test phone number**.
3. **WhatsApp → API Setup** — collect:
   - **Phone number ID** — the long ID in the *From* section (not the +1 555… number)
   - **Access token** — the temporary token shown (24h), or a permanent one (below)
4. **Approve a template** — WhatsApp Manager → **Message templates → Create**:
   - Category **Utility**, one **body** with a single variable `{{1}}`
   - Name it `zeus_alert` (or whatever you enter in Zeus)
   - Wait for **Approved**.
5. **Verify recipients** (test number only) — API Setup → *To* → **Manage phone
   number list** → add + verify each number (max 5).

### Permanent token (production)

Business Settings → **System users** → create one → **Generate token** with
`whatsapp_business_messaging` + `whatsapp_business_management`. This one doesn't
expire (the API-Setup token dies in 24h).

### In Zeus (Settings → Integrations → WhatsApp alerts)

1. Paste **Phone number ID**, **Access token**, **Template name**, **Template
   language** (exactly as Meta lists it — `en` ≠ `en_US`).
2. Keep **"This is a Meta test number"** checked while on the test number; uncheck
   once on a production number.
3. **Save** → enter a **verified** number in *Send a test to* → **Test** → check the
   handset. Heartbeat turns **Healthy**.

Users receive alerts on the WhatsApp number set in their **profile**.

---

## 3. Outbound webhooks

Tell another system when something happens in Zeus. Payloads are HMAC-signed so the
receiver can prove they came from Zeus.

1. Settings → Integrations → **Outbound webhooks → Add webhook**.
2. Enter a **name**, the receiver **URL**, and tick the **events** to send.
3. On save, Zeus shows the **signing secret once** — copy it into the receiver; it
   is encrypted afterwards and cannot be shown again.
4. **Test** posts a sample event; a hook that fails repeatedly auto-disables and the
   heartbeat flags it.

---

## Heartbeat

`GET /api/integrations/health` checks each integration live (M365 app token,
WhatsApp credential read, webhook state) and drives the header badges. It runs while
the Settings page is open; move it to a scheduled job if you need alerting when no
one is watching.

## Backups

Nightly `pg_dump → gzip → local copy → OneDrive/SharePoint`. Configure the
destination in the Microsoft 365 fields above, set the cron in **Backup schedule**,
or press **Back up now**. A failed dump is marked *failed* and raises a
`backup_failed` notification — it is never recorded as an empty success.
