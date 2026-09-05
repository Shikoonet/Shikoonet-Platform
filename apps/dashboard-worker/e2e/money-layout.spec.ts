/**
 * The «پول» screens, measured rather than described.
 *
 * On 2026-08-24 Sam sent five screenshots of this section. The worst of them
 * showed a table column rendering a 36-character identifier **one character per
 * line**, straight down the page, with every other cell in the row floating in
 * the middle of the band it made. The section had a full unit suite and every
 * test was green, because not one of them lays anything out: jsdom computes no
 * widths, so a column collapsing to a single glyph is invisible to it.
 *
 * The cause was one declaration — `word-break: break-all` on
 * `.identifier-text code`. What that does is not "wrap sooner": it drops the
 * cell's MIN-CONTENT width to one glyph, after which an auto-layout table is
 * free to squeeze the column to its header width, and a wrapper's
 * `overflow-x: auto` never fires because the table dutifully shrank to fit.
 *
 * The sharper half of the story is why it survived. `IdentifierText.tsx`
 * documents this exact hazard in its own header and set an inline
 * `overflowWrap: 'break-word'` to prevent it — and that could never work,
 * because the killer was `word-break`, a different property no inline
 * `overflow-wrap` overrides. A defence written twice disagreed with itself for
 * as long as both halves existed, and nothing could tell.
 *
 * So these assertions are on GEOMETRY, in a real browser. A test that reads the
 * stylesheet and looks for the string `break-all` would pass the moment the
 * declaration moved to another selector, and it would be checking my edit
 * against the file my edit is in — the shape rule 6 exists to forbid. What is
 * checked here is the thing the operator actually suffers: how tall the row is.
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { createPostgresD1 } from '@shikoo/db';

/**
 * Long, unbroken, and shaped like the real thing.
 *
 * A UUID with its hyphens removed, because hyphens give `break-word` legal
 * break points and would let a broken build look healthy. This is the hostile
 * case: 32 characters with nowhere to break.
 */
const LONG_CODE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const DEVICE_ID = 'zz-e2e-layout-device';

async function withDb<T>(fn: (d: ReturnType<typeof createPostgresD1>['db']) => Promise<T>) {
  const { db, pool } = createPostgresD1({ connectionString: process.env['DATABASE_URL']! });
  try {
    return await fn(db);
  } finally {
    await pool.end();
  }
}

test.beforeAll(async () => {
  const now = Date.now();
  await withDb((d) =>
    d
      .prepare(
        `INSERT INTO devices (id, device_code, display_name, active, last_seen_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, 1, ?4, ?4, ?4)
         ON CONFLICT (id) DO NOTHING`,
      )
      .bind(DEVICE_ID, LONG_CODE, 'zz-e2e-layout', now)
      .run(),
  );
});

test.afterAll(async () => {
  await withDb((d) => d.prepare(`DELETE FROM devices WHERE id = ?1`).bind(DEVICE_ID).run());
});

/**
 * The card carrying our hostile identifier.
 *
 * This was `.data-table tbody tr`. The devices screen has no table any more —
 * nine columns at panel width gave the name about fifty pixels and shredded
 * «Staging Device» and the action buttons alike — so one card layout serves
 * every width, and the identifier lives in `.device-card__code`.
 */
function row(page: Page) {
  return page.locator('.device-card', { hasText: 'zz-e2e-layout' }).first();
}

/*
 * What this test STOPPED covering, said out loud.
 *
 * Its old selector was `.data-table td > code`, and that CSS rule — `nowrap`,
 * so the token joins the table's min-content width and the wrapper scrolls
 * instead of the column squeezing — is still in the sheet. This was its only
 * test. The rule now reaches exactly one place: `TodayView`'s
 * `<code class="parser-id">`, holding strings like `mellat-credit-v1`, which is
 * short enough that no column can shred it however narrow it gets.
 *
 * So nothing was silently left unguarded — the failure mode moved out from
 * under that rule with the markup. If a long identifier is ever put back into a
 * `.data-table` cell, this note is the one that says it needs a test of its
 * own, and that `break-word` will not be enough: the measurement on 2026-08-24
 * took the row from 32 lines to 13.6, not to 1.
 */

/**
 * The identifier itself — not the row around it.
 *
 * The first draft measured the ROW and was wrong in a way worth recording,
 * because it read as a passing-looking failure. A device card legitimately
 * stacks three action buttons («چرخش کلید», «ابطال کلید», «خاموش‌کردن»), so
 * it is many lines tall on a perfectly healthy build. The number never
 * moved when the CSS was fixed — identical to fifteen decimal places — which is
 * the tell: the quantity under test was not the quantity being changed.
 *
 * A test whose number does not move when the bug does is measuring the wrong
 * thing, and it would have been just as green with `break-all` back in place.
 */
function identifier(page: Page) {
  return row(page).locator('.device-card__code', { hasText: LONG_CODE }).first();
}

/**
 * A ceiling in LINES, not pixels.
 *
 * Pixels would make this a snapshot of today's font stack. What the bug did was
 * turn one line into thirty-two, so the question worth asking is how many lines
 * tall the identifier renders. Measured against the element's own computed
 * `line-height` so a font change moves both sides together.
 *
 * The ceiling moved from 2 to 3 when the table became cards, and the reason
 * matters: inside a table cell any wrap at all meant the column had been
 * squeezed, so 2 was the honest bound. A card is a fixed ~300px box and a long
 * code wrapping onto a second line there is correct behaviour, not damage. What
 * is still caught is the actual regression — `break-all` put this at
 * thirty-two — and 3 refuses that by a wide margin while letting an honest wrap
 * through.
 */
async function identifierLines(page: Page): Promise<number> {
  return identifier(page).evaluate((el) => {
    const style = getComputedStyle(el);
    const parsed = Number.parseFloat(style.lineHeight);
    // `normal` computes to the string on some engines; 1.4em is this sheet's
    // effective ratio and only used as a divisor, never as an assertion.
    const line = Number.isFinite(parsed) ? parsed : Number.parseFloat(style.fontSize) * 1.4;
    return el.getBoundingClientRect().height / line;
  });
}

test('a long identifier does not turn a table row into a column of letters', async ({ page }) => {
  await page.goto('/admin/devices');
  await expect(identifier(page)).toBeVisible();

  // Thirty-two characters at one per line is what the screenshot showed.
  expect(await identifierLines(page)).toBeLessThan(3);
});

test('the same row survives a phone-width viewport, and the page does not scroll sideways', async ({
  page,
}) => {
  // 375px now, not 800px. The old comment explained that below 640 the screen
  // swapped its table for cards, so a table assertion at phone width was a test
  // that could not fail — true then, and the reason 800 was chosen. There is
  // one layout at every width now, so the narrowest real viewport is the
  // honest one to press.
  //
  // The horizontal-scroll assertion goes with the wrapper it was about: a
  // `.data-table-wrapper` existed to let a too-wide table scroll INSIDE itself
  // rather than widening the document. A grid of cards has nothing to scroll,
  // and asserting that something scrolls when nothing should is how a test
  // starts demanding the bug back. What the pair was really protecting — the
  // document itself never scrolling sideways — is kept, and it is the half a
  // user actually feels.
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/admin/devices');
  await expect(identifier(page)).toBeVisible();

  expect(await identifierLines(page)).toBeLessThan(3);

  const bodyOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(bodyOverflow).toBeLessThanOrEqual(1);
});

test('the «مرجع» column of the bot-verified table stays one line', async ({ page }) => {
  // The device screen above covers `.device-card__code`. This covers the
  // OTHER pairing — `.txn-table .identifier-text code` — which is the one in
  // Sam's screenshot, where «مرجع» came down the page a letter at a time.
  // Two selectors, two rules, two tests, and the first mutation run is why:
  // putting `break-all` back on `.identifier-text code` left the device test
  // perfectly green, because a device code is a bare `<code>` and never touches
  // that rule. Fixing one of these taught nothing about the other.
  //
  // The fixture promotes an existing claim rather than fabricating a chain.
  // «تایید خودکار ربات» wants `claim VERIFIED` + `match AUTO_VERIFIED`, and the
  // simulation shop already has forty claims carrying an AUTO_VERIFIED match —
  // so one UPDATE reaches the screen, and one puts it back. Building a claim, a
  // transaction and a match by hand would be inventing money to look at.
  const claim = await withDb((d) =>
    d
      .prepare(
        `SELECT c.id FROM payment_claims c
           JOIN reconciliation_matches m
             ON m.payment_claim_id = c.id AND m.status = 'AUTO_VERIFIED'
          WHERE c.status <> 'VERIFIED'
          ORDER BY c.id
          LIMIT 1`,
      )
      .first<{ id: string }>(),
  );
  if (!claim) throw new Error('no claim with an AUTO_VERIFIED match — run seed:sim');

  const before = await withDb((d) =>
    d
      .prepare(`SELECT status FROM payment_claims WHERE id = ?1`)
      .bind(claim.id)
      .first<{ status: string }>(),
  );

  // Only the status. The date filter is pinned to «همه» in the URL above
  // instead, and finding out why that was necessary was itself a preview of the
  // bug this branch exists for: under the tab's DEFAULT filter the badge read
  // «۱» while the list underneath said «در این بازه پرداختی با تایید خودکار
  // ربات نیست». The count ignores the date filter and the rows obey it, so the
  // two answer different questions — the same badge-versus-list divergence
  // being fixed on the review queue, sitting quietly in a second tab.
  await withDb((d) =>
    d.prepare(`UPDATE payment_claims SET status = 'VERIFIED' WHERE id = ?1`).bind(claim.id).run(),
  );
  try {
    await page.goto('/admin/payments?tab=bot_auto_verified&dateFilter=all');
    await expect(page.locator('.hub')).toBeVisible();

    const code = page.locator('.txn-table .identifier-text code').first();
    await expect(code).toBeVisible();

    // The transaction id is a 36-character UUID. One line, or the column
    // collapsed and we are looking at the screenshot again.
    const lines = await code.evaluate((el) => {
      const style = getComputedStyle(el);
      const parsed = Number.parseFloat(style.lineHeight);
      const line = Number.isFinite(parsed) ? parsed : Number.parseFloat(style.fontSize) * 1.4;
      return el.getBoundingClientRect().height / line;
    });
    expect(lines).toBeLessThan(2);
  } finally {
    // Put the money back exactly as it was, whatever happened above.
    await withDb((d) =>
      d
        .prepare(`UPDATE payment_claims SET status = ?2 WHERE id = ?1`)
        .bind(claim.id, before!.status)
        .run(),
    );
  }
});

test('the review is a page, at the size of the decision', async ({ page }) => {
  /*
   * This test used to open `.drawer` and assert its background was opaque —
   * the drawer resolved through `--panel` → `--surface` → `--surface-1`, which
   * is `rgba(20, 22, 30, 0.48)`, so the list read straight through the text on
   * top of it.
   *
   * The transparency is fixed and the drawer is gone: «بررسی پرداخت» is 493
   * lines about a real payment and it was living in `width: min(360px, 90vw)`.
   * So what is asserted now is the thing that replaced it, and the assertions
   * are the ones the drawer would fail — width, its own address, and nothing
   * from the queue left rendered underneath.
   */
  await page.goto('/admin/payments?tab=all');
  await expect(page.locator('.hub')).toBeVisible();

  const opener = page.locator('.hub-list-row__button').first();
  await expect(opener).toBeVisible();
  await opener.click();

  const review = page.locator('.review-page');
  await expect(review).toBeVisible();

  // Gone, not hidden. A drawer left the list mounted behind it — its fetches,
  // its focus and its scroll position all still live.
  await expect(page.locator('.drawer')).toHaveCount(0);
  await expect(page.locator('.hub-list-row__button')).toHaveCount(0);

  // Somewhere you went, so Back is how you leave.
  expect(new URL(page.url()).searchParams.get('claim')).toBeTruthy();

  const width = await review.evaluate((el) => el.getBoundingClientRect().width);
  // The drawer was 360. Anything in that neighbourhood means the panel is back
  // in a column, whatever the markup says.
  expect(width).toBeGreaterThan(700);

  await page.goBack();
  await expect(page.locator('.hub-list-row__button').first()).toBeVisible();
  expect(new URL(page.url()).searchParams.get('claim')).toBeNull();
});

test('a receipt the shape customers actually send is legible', async ({ page }) => {
  /*
   * `e2e/fixtures/receipt-portrait.svg` is drawn to the shape of a real one
   * Sam supplied: an «آسان پرداخت» report screenshotted from a phone,
   * 591×1280, portrait. His own file stays on disk and out of git — it carries
   * a customer's name and both card numbers — and nothing is lost, because
   * every assertion below is about SIZE and any 591×1280 image answers them
   * identically.
   *
   * The cap on this image was `max-height: 320px`, written against a landscape
   * placeholder I had drawn myself — the only receipt this code had ever been
   * shown. At that cap a 591×1280 image renders **148px wide**, and مبلغ,
   * شمارهٔ ارجاع and the last four digits of both cards become a few pixels
   * tall. Every unit test passed, because none of them has a viewport.
   *
   * The route is intercepted rather than reaching Telegram: this asserts our
   * layout, and a test that needs a bot token and a live third party to tell
   * you your CSS is wrong is a test that will be skipped.
   */
  const bytes = readFileSync(new URL('./fixtures/receipt-portrait.svg', import.meta.url));
  await page.route('**/api/v1/payment-claims/*/receipt', (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: bytes }),
  );

  /*
   * The claim is taken from the SCREEN, not from `ORDER BY id LIMIT 1`.
   *
   * The first version of this picked the lowest id and then opened
   * `?claim=<id>` directly, which passed on the seed I happened to have and
   * failed on the next one: the queue loads at most 200 rows, and a claim
   * outside them makes the review page say «این پرداخت در فهرست باز نیست» —
   * correctly. The test was asserting against whichever claim the seed's
   * random ids happened to sort first.
   *
   * Clicking the first row also exercises the path an operator uses, instead
   * of a URL nobody types.
   */
  await page.goto('/admin/payments?tab=open&dateFilter=all');
  const firstRow = page.locator('.hub-list-row__button').first();
  await expect(firstRow).toBeVisible();
  await firstRow.click();
  await expect(page.locator('.review-page')).toBeVisible();

  const claimId = new URL(page.url()).searchParams.get('claim');
  if (!claimId) throw new Error('opening a row did not put a claim in the address');

  const before = await withDb((d) =>
    d
      .prepare(`SELECT receipt_url_or_r2_key AS handle FROM payment_claims WHERE id = ?1`)
      .bind(claimId)
      .first<{ handle: string | null }>(),
  );

  // A well-formed handle so the route gets past its own validation; the
  // interception above means Telegram is never asked about it.
  await withDb((d) =>
    d
      .prepare(`UPDATE payment_claims SET receipt_url_or_r2_key = ?2 WHERE id = ?1`)
      .bind(claimId, 'AgACAgQAAxkBAAIe2etestreceipthandle01')
      .run(),
  );

  try {
    await page.goto(`/admin/payments?tab=open&dateFilter=all&claim=${claimId}`);
    const img = page.locator('.payment-receipt img');
    await expect(img).toBeVisible();

    // Visibility only describes the element's box; a lazily loaded image can
    // be visible for a frame while its intrinsic dimensions are still zero.
    await expect(img).toHaveJSProperty('naturalWidth', 591);
    await expect(img).toHaveJSProperty('naturalHeight', 1280);

    const size = await img.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const image = el as HTMLImageElement;
      return {
        w: r.width,
        h: r.height,
        naturalW: image.naturalWidth,
        naturalH: image.naturalHeight,
      };
    });

    // The fixture really is the portrait shape, not something that got swapped
    // for a square placeholder — without this the rest measures nothing.
    expect(size.naturalW).toBe(591);
    expect(size.naturalH).toBe(1280);

    // 148px is what the old cap produced. The width is what decides whether
    // the text on a 591px-wide phone screenshot can be read, so the width is
    // what is asserted — the first version of this capped the HEIGHT instead
    // and rendered 267px on a 720px-tall window without failing anything.
    expect(size.w).toBeGreaterThan(350);

    // And the box it sits in stays on screen. A tall receipt scrolls inside
    // its own frame rather than pushing the buttons that decide the money a
    // screen and a half down the page.
    const frame = await page
      .locator('.payment-receipt')
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(frame).toBeLessThanOrEqual(page.viewportSize()!.height);
  } finally {
    await withDb((d) =>
      d
        .prepare(`UPDATE payment_claims SET receipt_url_or_r2_key = ?2 WHERE id = ?1`)
        .bind(claimId, before?.handle ?? null)
        .run(),
    );
  }
});
