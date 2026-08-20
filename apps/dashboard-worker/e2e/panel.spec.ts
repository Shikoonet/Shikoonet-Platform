/**
 * One session opens every section.
 *
 * This is the assertion the merge was for, and it could not be written before
 * it. Until 2026-08-16 the shop ran on two builds behind two Cloudflare Access
 * applications with two audiences, and a bundle loaded from one path carries
 * exactly one token — so a walk like this was guaranteed to 401 on half of the
 * sections no matter which door it came through. That was the structural reason
 * the panels could not merge, and the reason the login had to be replaced
 * first.
 *
 * The list of sections is read off the sidebar rather than imported from
 * `nav.ts`. Importing it would prove the panel agrees with itself; reading it
 * means whatever the panel actually offers an operator has to open. If a
 * section is added and its screen refuses, this goes red without anyone
 * remembering to add a line.
 *
 * 401 and 403 specifically, not "every response is 200". A finance screen
 * against seeded data can answer 404 for a row that is not there, and that is a
 * fixture, not a boundary. An unauthorized answer on a page the sidebar drew is
 * the failure this exists to catch.
 */

import { expect, test } from '@playwright/test';

test('every section in the sidebar opens under one session', async ({ page }) => {
  const refused: string[] = [];
  page.on('response', (r) => {
    if (r.status() === 401 || r.status() === 403) {
      refused.push(`${r.status()} ${new URL(r.url()).pathname}`);
    }
  });

  await page.goto('/admin/');
  await expect(page.locator('.sidebar-link').first()).toBeVisible();

  const labels = await page.locator('.sidebar-link').allInnerTexts();
  // Seventeen shop sections plus the six that came from the payment hub. A
  // number rather than a range: if the sidebar quietly loses a group, the walk
  // below would still pass on whatever was left. The seventeenth is «ارسال
  // گروهی», which the bot could do and this panel could not.
  expect(labels.length).toBe(23);

  for (const label of labels) {
    const name = label.trim();
    await page.getByRole('button', { name, exact: true }).click();
    // The section is open when the sidebar says so. Waiting on page content
    // would mean knowing what twenty-two different screens draw.
    await expect(page.locator('.sidebar-link.active')).toHaveText(name);
    // And it is a section, not the login form behind a stale cookie.
    await expect(page.getByText('ورود به پنل مدیریت')).toHaveCount(0);
  }

  expect(refused).toEqual([]);
});

test('a finance section can be opened by its address alone', async ({ page }) => {
  // What a shared link has to do, and what neither panel could do before: every
  // screen used to be `/admin/` or `/`, so «look at this payment» could only be
  // an instruction to click.
  await page.goto('/admin/payments');
  await expect(page.locator('.sidebar-link.active')).toHaveText('پرداخت‌ها');
  await expect(page.getByRole('tablist', { name: 'بخش‌های پرداخت' })).toBeVisible();
});

test('the old payment hub address redirects into the panel', async ({ page }) => {
  // The hub lived at `/` for the whole life of the project and its own
  // notification links carry `?tab=`. Both are bookmarked.
  await page.goto('/');
  await expect(page).toHaveURL(/\/admin\/$/);

  await page.goto('/?tab=needs_review');
  await expect(page).toHaveURL(/\/admin\/payments\?tab=needs_review$/);
  await expect(page.locator('.sidebar-link.active')).toHaveText('پرداخت‌ها');
});

test('the finance screens are painted in the panel’s colours', async ({ page }) => {
  // Sam's instruction on 2026-08-16, after seeing the merged panel: make the
  // finance screens match. They were black-and-gold, a second design language
  // for what had been a second build.
  //
  // `css-scope.test.ts` reads the stylesheet and proves the selectors are
  // scoped. This is the browser agreeing about what the cascade actually
  // produces — the part no static check can see, and the part that was wrong
  // twice: `.hub button` outranked the hub's own row styling and turned two
  // hundred payment rows into solid gold blocks, which every unit test passed
  // through without noticing.
  await page.goto('/admin/');
  const panelAccent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  );
  expect(panelAccent).toBe('#3b82f6');

  await page.goto('/admin/payments');
  const hub = page.locator('.hub');
  await expect(hub).toBeVisible();

  const paint = await page.evaluate(() => {
    const el = document.querySelector('.hub')!;
    const row = document.querySelector('.hub .hub-list-row__button');
    return {
      accent: getComputedStyle(el).getPropertyValue('--accent').trim(),
      // Inherited from the panel's body rather than redeclared: the hub used to
      // set its own font stack, which made the two halves visibly different
      // documents.
      font: getComputedStyle(el).fontFamily,
      rowBg: row ? getComputedStyle(row).backgroundColor : null,
    };
  });

  expect(paint.accent).toBe(panelAccent);
  expect(paint.font).toContain('Vazirmatn');
  // Not the accent as a fill. A row is a surface; only a control is painted in
  // the accent colour, and this is the exact regression that shipped once.
  expect(paint.rowBg).not.toBe('rgb(59, 130, 246)');
});

test('opening a customer shows the customer', async ({ page }) => {
  // «مدیریت» opens a card in the page flow rather than an overlay, and with a
  // full list that card starts below the fold: measured on 2026-08-17,
  // «تخفیف دائمی» rendered at y=1275 in a 950px viewport with the page still
  // at scrollY 0. Nothing was broken — the button worked, the request fired,
  // the card rendered — and pressing it looked like pressing a dead control.
  //
  // The same mistake the bulk confirmation card made, and neither one is
  // visible to a test that only asserts the element exists. So this asserts
  // where it is, not that it is.
  await page.goto('/admin/customers');
  const firstRow = page.locator('tbody tr').first();
  await expect(firstRow).toBeVisible();
  await firstRow.getByRole('button', { name: 'مدیریت' }).click();

  // The head of the drawer, which is the "something happened" signal. Not the
  // discount section: that sits below the ledger table inside the same card and
  // is *meant* to need scrolling — asserting it were on screen would demand the
  // drawer open past its own header, which is worse.
  const head = page.locator('.card__head', { hasText: '@' }).last();
  await expect(head).toBeVisible();
  // `toBeVisible` is true for anything painted, including 300px below the
  // window, which is exactly the state this test exists to reject.
  await expect
    .poll(async () =>
      head.evaluate((el) => {
        const top = el.getBoundingClientRect().top;
        return top >= 0 && top < window.innerHeight;
      }),
    )
    .toBe(true);

  // And the two controls the bulk work added are actually in there.
  await expect(page.getByRole('heading', { name: 'تخفیف دائمی' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'پیام به این کاربر' })).toBeVisible();
});

test('an ordinary hub button is painted like an ordinary panel button', async ({ page }) => {
  // The hub had one button style and it was the accent fill — fine while that
  // accent was gold and read as the hub's own chrome, wrong once it was the
  // panel's blue: «حذف» in a row of bank prefixes became the loudest control on
  // the page, louder than anything the panel paints. Three tones, one meaning
  // each, and this is the browser agreeing that the plain one matches.
  //
  // Read off `.btn` rather than hard-coded: if the panel restyles its buttons,
  // this should follow it, not go red.
  await page.goto('/admin/');
  await expect(page.locator('.btn').first()).toBeVisible();
  const panelBtn = await page.locator('.btn').first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, color: cs.color, border: cs.borderColor };
  });

  await page.goto('/admin/banks');
  await expect(page.locator('.hub')).toBeVisible();
  const tones = await page.evaluate(() => {
    const paint = (el: Element | null | undefined) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, color: cs.color, border: cs.borderColor };
    };
    const buttons = [...document.querySelectorAll('.hub button')];
    // A button wearing no tone and no component class of its own — the base
    // rule, undisturbed. Found rather than selected by name so it cannot
    // quietly become null and let the assertion pass on nothing.
    const plain = buttons.find((b) =>
      [...b.classList].every((c) => c === 'btn-sm'),
    );
    return {
      plain: paint(plain),
      primary: paint(document.querySelector('.hub button.primary')),
      danger: paint(document.querySelector('.hub button.danger')),
    };
  });

  expect(tones.primary?.bg).toBe('rgb(59, 130, 246)');
  // Tinted, not a solid red block — the panel's `.btn-danger` tone.
  expect(tones.danger?.bg).toBe('rgba(239, 68, 68, 0.15)');
  expect(tones.danger?.color).toBe('rgb(239, 68, 68)');
  expect(tones.plain).toEqual(panelBtn);
});

test('the bulk price preview lands on screen and shows real prices', async ({ page }) => {
  // Third card down on «ارسال گروهی», so its confirmation starts further from
  // the top than either of the two that already made this mistake once: the
  // operator presses «پیش‌نمایش», the request fires, the card renders below
  // the fold, and the button looks dead. Asserting it EXISTS would pass then.
  await page.goto('/admin/bulk');
  await expect(page.getByRole('heading', { name: 'تنظیم گروهی قیمت' })).toBeVisible();

  await page.locator('#bp-amount').fill('10');
  await page.getByRole('button', { name: 'پیش‌نمایش' }).click();

  const confirm = page.locator('.card', { hasText: 'تغییر قیمت اعمال شود؟' }).last();
  await expect(confirm).toBeVisible();
  await expect
    .poll(async () =>
      confirm.evaluate((el) => {
        const top = el.getBoundingClientRect().top;
        return top >= 0 && top < window.innerHeight;
      }),
    )
    .toBe(true);

  // And it says prices, not a percentage: «۱۹۵٬۰۰۰ تومان» is what an operator
  // can check against the shop, «+۱۰٪» is what they already typed.
  await expect(confirm).toContainText('تومان');
});
