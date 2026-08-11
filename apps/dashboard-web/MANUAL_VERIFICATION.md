# Dashboard v2 — Manual Verification

The dashboard was hardened with: responsive layout (mobile/tablet/desktop/wide), polling cache with 5s refresh + visibility/focus/online triggers + exponential backoff, new-transaction banner, live-status header, ARIA roles, mobile-cards / desktop-tables split, AccessibleDrawer nav below 1024px, persisted selected match, and 401/403 session-expired surfacing.

## Deploy

```bash
cd /home/sam/Documents/mydev/smsverfication
pnpm --filter @shikoo/dashboard-web build
cd apps/dashboard-worker
pnpm exec wrangler deploy
```

## Manual verification steps

Each step is what the operator should observe after deploy.

### 1. Responsive layout (provider resize)

| Viewport            | Expected                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 320×568 (iPhone SE) | Hamburger visible. Tab navigation in a drawer. Cards stacked. CommentPanel under Matches. Header brand + LiveStatus wrap. |
| 768×1024 (tablet)   | Hamburger visible. Cards-as-list. Match + CommentPanel use split grid (1fr sidebar).                                      |
| 1280×800 (laptop)   | No hamburger. Tab nav inline header. Match + CommentPanel in 1fr / 320px split.                                           |
| 1440+ (wide)        | Tab nav inline. Match + CommentPanel in 1fr / 380px split. App max-width 1600px.                                          |

### 2. Automatic refresh

1. Open the dashboard at a desktop width.
2. Watch the "Live" indicator — it stays green.
3. Open DevTools → Network → filter `fetch(/api`. Confirm a request fires every ~5s.
4. Send a real SMS from `poyan-01` (or any registered device):
   - "1 new transaction received" banner appears in the Today tab within 5–10s.
   - The new row appears without a page reload.
5. Start a new device auth: the Devices tab badge count updates without manual refresh.

### 3. Visibility / focus / online

1. Open the dashboard. Switch tab to another browser tab. Wait 30s. Return.
   - On return, a fresh fetch fires immediately (focus event).
2. Toggle DevTools → Network → "Offline" for 10s, then back online.
   - Live indicator turns gray ("Offline") and back to green ("Live") on reconnect.
   - A fresh fetch fires the moment "Online" is re-enabled.
3. Resize the viewport from 1280 to 320 and back.
   - Tabs are replaced by the hamburger drawer at <1024px and reappear at ≥1024px.
   - No state is lost — the active tab + selected match are preserved.

### 4. 401 / 403 session expired

1. Sign in via Cloudflare Access.
2. Open the dashboard. Land on the Matches tab.
3. From a separate tab, manually revoke the access JWT (or wait for the cookie to expire).
4. The next poll fails with 401. The Matches tab shows "Session expired. Sign in again" with a link.
5. Click the link, re-authenticate, return to the tab. The next poll succeeds and the table re-populates.

### 5. Modal focus + keyboard

1. Open Accounts tab → "Sample SMS" on any account.
2. The modal mounts with `role="dialog"` + `aria-modal="true"`. Initial focus is on the container.
3. Press Escape. Modal closes.
4. Click the backdrop (outside the modal body). Modal closes.
5. Re-open. Tab through the fields — focus stays inside the modal until Cancel/Close.

### 6. New-transaction banner dedup

1. Open the Today tab. Send a real SMS. The banner appears: "1 new transaction received."
2. After 4 seconds, the banner disappears (auto-markSeen).
3. Refresh the page. The same row is no longer "new" — banner does not reappear.
4. Open a new tab, hit the page. The row is _not_ new for the new tab (per-session seen).
5. Wait for a second SMS. The banner appears again, this time for the new id only.

### 7. Mutation-driven refetch

1. Open Matches → Unmatched tab. Identify a transaction with no account. Click "Assign".
2. Pick an account. Confirm.
3. The row disappears from Unmatched within ~5s (refresh) and reappears in Today under the assigned account.
4. The Accounts tab total updates within ~5s for the current range.

### 8. ARIA + semantics

1. Open DevTools → Elements. Confirm:
   - `<header>` contains the brand + `<nav role="tablist">` containing the tabs.
   - Each tab has `role="tab"` and `aria-selected="true|false"`.
   - The hamburger has `aria-label="Open navigation"` and `aria-expanded` toggles correctly.
   - The Drawer has `role="dialog"` and `aria-modal="true"`.
2. With a screen reader (VoiceOver on macOS, NVDA on Windows), navigate. Tab names and columns are read.

### 9. Persistence

1. Open Matches tab. Click a row to select it. The CommentPanel on the right shows comments.
2. Switch to Today tab. Switch back to Matches. The previously selected row is still highlighted and the CommentPanel still shows its comments.
3. Reload the page. The selected match is restored (selected is in sessionStorage).

### 10. Endpoint safety

- The dashboard batches polling to the URLs that already existed before this change:
  - `/api/v1/today`
  - `/api/v1/matches/suggested`
  - `/api/v1/matches/unmatched`
  - `/api/v1/matches/reviewed`
  - `/api/v1/matches/reviewed/transactions`
  - `/api/v1/accounts`
  - `/api/v1/accounts/totals?range=...`
  - `/api/v1/devices`
- No endpoint is added or removed. No change to the ingest JSON contract. Cloudflare Access still wraps every request.

### 11. Automated tests

```bash
cd /home/sam/Documents/mydev/smsverfication
pnpm --filter @shikoo/dashboard-web test      # 29 tests pass
pnpm --filter @shikoo/dashboard-worker test   # 7 tests pass
pnpm -r typecheck                          # all packages green
```

## Rollback

If anything regresses in production:

```bash
cd /home/sam/Documents/mydev/smsverfication
git checkout HEAD~1 -- apps/dashboard-web apps/dashboard-worker
pnpm --filter @shikoo/dashboard-web build
cd apps/dashboard-worker
pnpm exec wrangler deploy
```

This restores the previous dashboard without touching the backend.
