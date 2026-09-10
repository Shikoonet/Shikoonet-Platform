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
  // Sixteen shop sections, six from the payment hub, four for the bot. A number
  // rather than a range: if the sidebar quietly loses a group, the walk below
  // would still pass on whatever was left.
  //
  // Twenty-four until 2026-08-27, when «محصولات» and «دسته‌بندی‌ها» joined it.
  // Twenty-eight on 2026-08-29, two on the same day: «آمار فروشگاه», the
  // shop's own trade in the calendar its admin reads, and «ربات تلگرام»,
  // the first screen that says which bot the shop actually is.
  // Worth stating why this is bumped by hand rather than read off `NAV`: a
  // count derived from the module that draws the sidebar agrees with itself no
  // matter what it draws, which is the failure `CLAUDE.md` rule 6 is about. The
  // outside truth here is that a person decided there are twenty-six sections.
  // 28 -> 29 on 2026-08-30, and the sidebar did not change to make it so. The
  // set of items is byte-for-byte the one that existed before the regrouping
  // commit — `git show fe35ae7^:apps/admin-web/src/nav.ts` lists the same 29
  // ids — so this constant had been stale on `main` for some time, red in a
  // suite nobody could run because CI is off. Counted from `nav.ts` and checked
  // for duplicates, not adjusted until it went green.
  // 29 -> 30 on 2026-09-07 with «کرون‌جاب‌ها». Unlike the 28 -> 29 above,
  // this one IS a new section: the sidebar gained an item, so the number
  // moved for the reason a number should. Counted off `nav.ts`, which has
  // thirty `{ id:` entries.
  // 30 -> 31 on 2026-09-07 with «نمایندگان» — a new section, so the number
  // moved for the reason a number should. Counted off `nav.ts`.
  expect(labels.length).toBe(31);

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
  const panelBtn = await page
    .locator('.btn')
    .first()
    .evaluate((el) => {
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
    const plain = buttons.find((b) => [...b.classList].every((c) => c === 'btn-sm'));
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

test('a decrease that would zero a plan is refused on the screen, not after the press', async ({
  page,
}) => {
  // Zero is not free. `order.ts` refuses any order whose total is not positive,
  // so a plan repriced to zero keeps its button and refuses every press, for
  // ever and silently. The floor used to test `< 0` and let it through; this is
  // the operator's side of that fix, and it has to be readable before anything
  // is committed rather than as a 409 afterwards.
  await page.goto('/admin/bulk');
  await expect(page.getByRole('heading', { name: 'تنظیم گروهی قیمت' })).toBeVisible();

  await page.locator('#bp-dir').selectOption('DOWN');
  await page.locator('#bp-mode').selectOption('FIXED');
  // Toman, converted to IRR by the page. More than any plan in the catalogue.
  await page.locator('#bp-amount').fill('900000');
  await page.getByRole('button', { name: 'پیش‌نمایش' }).click();

  const confirm = page.locator('.card', { hasText: 'تغییر قیمت اعمال شود؟' }).last();
  await expect(confirm).toContainText('به صفر یا زیر صفر');
  // And the way out is closed: the operator cannot press through the warning.
  await expect(confirm.getByRole('button', { name: 'تایید' })).toBeDisabled();
});

/**
 * One header, in a browser.
 *
 * The unit test proves the bell mounts; only a real browser proves the header
 * is one bar rather than two stacked, and that the payment tab strip still
 * looks like a tab strip after moving into it. Both of those are layout, and
 * happy-dom has none.
 */
test('every section draws exactly one header, and it carries the bell', async ({ page }) => {
  for (const path of ['/admin/', '/admin/customers', '/admin/payments', '/admin/today']) {
    await page.goto(path);
    await expect(page.locator('header')).toHaveCount(1);
    // The one control that says «money has arrived», on a shop screen as well
    // as on a finance one.
    await expect(page.getByRole('button', { name: /اعلان/ })).toBeVisible();
  }
});

test('the payment tabs keep their own row inside the one header', async ({ page }) => {
  await page.goto('/admin/payments');
  const strip = page.locator('.app-header__center .ops-nav__strip--primary');
  await expect(strip).toBeVisible();

  // The starvation this panel has been bitten by twice: a wide thing in the
  // header's flex row squeezing the title out of existence. The title is the
  // one element that must survive whatever else is in there.
  const title = page.locator('.app-header__title');
  await expect(title).toBeVisible();
  const w = await title.evaluate((el) => el.getBoundingClientRect().width);
  expect(w).toBeGreaterThan(20);

  // And the header stays one row tall on a desk.
  const h = await page.locator('header.app-header').evaluate((el) => el.getBoundingClientRect().height);
  expect(h).toBeLessThan(140);
});

test('the header never covers the first thing on the page', async ({ page }) => {
  /*
   * On a phone the header wraps: the shop-state controls move to a row of
   * their own, so it is taller than the 64px `--header-h` that offsets the
   * content beneath it. Content sliding under a FIXED header is invisible and
   * unscrollable — the page looks like it starts at its second paragraph.
   *
   * Measured rather than reasoned about, and at both widths: the desk case is
   * the control that says the phone case is about wrapping.
   */
  for (const [w, h] of [
    [390, 844],
    [1440, 900],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const path of ['/admin/', '/admin/payments']) {
      await page.goto(path);
      await expect(page.locator('header.app-header')).toBeVisible();
      const gap = await page.evaluate(() => {
        const header = document.querySelector('header.app-header')!.getBoundingClientRect();
        const main = document.querySelector('#main-content')!.getBoundingClientRect();
        return Math.round(main.top - header.bottom);
      });
      expect(gap, `${path} at ${w}px`).toBeGreaterThanOrEqual(0);
    }
  }
});

/**
 * The palette, in a browser that has a real focus model.
 *
 * happy-dom covers the filtering, the debounce and the role check; what it
 * cannot answer is whether the thing opens over the page, takes the keyboard,
 * and hands it back. `<dialog open>` is not `showModal()` — there is no top
 * layer and no browser backdrop — so «is it actually in front and focused» is a
 * question only a browser settles.
 */
test('Ctrl+K opens the palette anywhere and takes the keyboard to a section', async ({ page }) => {
  await page.goto('/admin/payments');
  await expect(page.locator('header.app-header')).toBeVisible();
  await expect(page.locator('dialog.palette')).toHaveCount(0);

  await page.keyboard.press('Control+k');
  const box = page.getByLabel('نام بخش یا مشتری');
  await expect(box).toBeVisible();
  // Focused without anyone clicking it: a palette you have to click into is a
  // slower way of using the sidebar.
  await expect(box).toBeFocused();

  await box.fill('سفارشات');
  await page.keyboard.press('Enter');

  await expect(page.locator('.sidebar-link.active')).toHaveText('سفارشات');
  // And it closes behind itself, or the next keystroke lands in a box still
  // sitting on top of the screen it just opened.
  await expect(page.locator('dialog.palette')).toHaveCount(0);
});

test('the palette keeps the keyboard while it is open', async ({ page }) => {
  /*
   * The reason it is `showModal()` and not `<dialog open>`.
   *
   * With the bare attribute the dialog is an ordinary element in the flow and
   * Tab walks straight out of it into the sidebar behind — on a control whose
   * entire purpose is to be used without the mouse. A modal dialog sits in the
   * top layer and the browser confines Tab to it.
   *
   * Only a browser can answer this. happy-dom implements `showModal()` and sets
   * `open`, but not the top layer, so the unit tests pass either way — the
   * shape this repository keeps being caught by.
   */
  await page.goto('/admin/payments');
  await page.keyboard.press('Control+k');
  await expect(page.getByLabel('نام بخش یا مشتری')).toBeFocused();

  // Enough presses to have left a four-element dialog several times over.
  for (let i = 0; i < 12; i += 1) await page.keyboard.press('Tab');

  const stillInside = await page.evaluate(() => {
    const dialog = document.querySelector('dialog.palette');
    return !!dialog && !!document.activeElement && dialog.contains(document.activeElement);
  });
  expect(stillInside, 'focus left the palette').toBe(true);

  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.palette')).toHaveCount(0);
});

test('«/» opens the palette, but not while a search box has the keyboard', async ({ page }) => {
  await page.goto('/admin/orders');
  const search = page.locator('#ledger-q');
  await expect(search).toBeVisible();

  await search.click();
  await page.keyboard.press('/');
  await expect(page.locator('dialog.palette')).toHaveCount(0);
  // The character went where it was typed, which is the whole point.
  await expect(search).toHaveValue('/');

  await search.fill('');
  await search.blur();
  await page.keyboard.press('/');
  await expect(page.locator('dialog.palette')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.palette')).toHaveCount(0);
});
