/**
 * «یادآوری تمدید» — Sam, 2026-09-20: «یه قسمت استاتیستیکس … لایو ویو … وقتی
 * ذخیره می‌زنم باید کوچیک بشه». The overview comes first with every rule on
 * a line, a saved rule is folded to that line, a new one is open, and the
 * half-minute re-read never touches what is being typed.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { RetentionPage } from '../src/pages/RetentionPage.js';

function rule(key: string, extra: Record<string, unknown>) {
  return {
    key,
    name: key,
    enabled: true,
    providerId: null,
    panelAdmin: 'mirzavip',
    daysBefore: 3,
    daysAfter: 0,
    onlyService: true,
    codeId: null,
    text: 'x {days}',
    textAfter: '',
    sendAt: '10:00',
    maxMessages: 0,
    everyDays: 1,
    lastActed: null,
    audience: 0,
    funnel: {
      sent: 0,
      usedCode: 0,
      usedOutside: 0,
      stayed: 0,
      left: 0,
      pending: 0,
      messages: { queued: 0, sent: 0, dead: 0, today: 0 },
    },
    ...extra,
  };
}

const RULES = [
  rule('r_one', {
    name: 'کاربرهای قدیمی',
    audience: 1161,
    funnel: {
      sent: 40,
      usedCode: 7,
      usedOutside: 2,
      stayed: 9,
      left: 20,
      pending: 11,
      messages: { queued: 5, sent: 90, dead: 3, today: 12 },
    },
  }),
  rule('r_two', { name: 'خرید اولی‌ها', enabled: false, audience: 30 }),
];

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function mock(items: unknown[]) {
  const posts: unknown[] = [];
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/retention/audience')) return json({ ok: true, count: 4 });
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return json({ ok: true, items });
      }
      reads += 1;
      return json({ ok: true, items, panels: [], admins: [{ admin: 'mirzavip', accounts: 3 }], codes: [] });
    }),
  );
  return { posts, reads: () => reads };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the overview', () => {
  it('totals the rules that are on and lists every rule on one line', async () => {
    mock(RULES);
    render(
      <RoleProvider role="ADMIN">
        <RetentionPage />
      </RoleProvider>,
    );
    const stats = await screen.findByTestId('retention-stats');
    expect(stats.textContent).toContain('۲ قانون · ۱ روشن');
    // Audience counts only rules that are on: 1161, not 1191.
    expect(stats.textContent).toContain('۱٬۱۶۱');
    expect(stats.textContent).not.toContain('۱٬۱۹۱');
    expect([...stats.querySelectorAll('.stat-card__value')].map((v) => v.textContent)).toEqual([
      '۱٬۱۶۱', '۵', '۱۲', '۳',
    ]);

    // The folded row says who, how many now, and what the reached people did.
    const one = screen.getByTestId('retention-summary-r_one');
    expect(one.textContent).toContain('mirzavip · ۳ روز مانده · ساعت ۱۰:۰۰ · روزی یک پیام · بدون کد');
    expect(one.textContent).toContain('۱٬۱۶۱ در بازه');
    expect(one.textContent).toContain('کد زدند ۷ از ۴۰');
    expect(one.textContent).toContain('۳ نرسیده');
    expect(screen.getByTestId('retention-summary-r_two').textContent).toContain('هنوز به کسی نرسیده');

    // The full figures live inside the opened rule.
    const figures = screen.getByTestId('retention-figures-r_one');
    expect([...figures.querySelectorAll('dd')].map((d) => d.textContent)).toEqual([
      '۵', '۱۲', '۹۰', '۳', '۴۰', '۷', '۳۳', '۲', '۹', '۲۰', '۱۱', 'در ۳۰ روز گذشته چیزی نفرستاده',
    ]);
  });
});

describe('folding', () => {
  it('a saved rule is folded to its line, a new one is open, and «ذخیره» folds everything', async () => {
    const { posts } = mock(RULES);
    render(
      <RoleProvider role="ADMIN">
        <RetentionPage />
      </RoleProvider>,
    );
    const one = (await screen.findByTestId('retention-rule-r_one')) as HTMLDetailsElement;
    expect(one.open).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '+ افزودن قانون' }));
    const details = [...document.querySelectorAll('details')] as HTMLDetailsElement[];
    expect(details).toHaveLength(3);
    expect(details[2]!.open).toBe(true);
    expect(details[2]!.textContent).toContain('هنوز ذخیره نشده');

    // A new rule is born with the Tehran clock of this moment as its send time.
    const at = details[2]!.querySelector('input[type="time"]') as HTMLInputElement;
    expect(at.value).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    fireEvent.change(at, { target: { value: '09:30' } });
    fireEvent.change(details[2]!.querySelector('input.form-control')!, { target: { value: 'تازه' } });
    // «هفت بار بیشتر نه، هر دو روز یک بار» — the cap and the pace go out as numbers.
    fireEvent.change(details[2]!.querySelector('input[id^="ret-max-"]')!, { target: { value: '7' } });
    fireEvent.change(details[2]!.querySelector('input[id^="ret-every-"]')!, { target: { value: '2' } });
    expect(details[2]!.textContent).toContain('هر ۲ روز یک پیام، حداکثر ۷ تا');
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    const body = posts[0] as { items: { name: string; sendAt: string | null }[] };
    expect(body.items.at(-1)).toMatchObject({ name: 'تازه', sendAt: '09:30', maxMessages: 7, everyDays: 2 });
    await vi.waitFor(() =>
      expect(([...document.querySelectorAll('details')] as HTMLDetailsElement[]).every((d) => !d.open)).toBe(true),
    );
  });

  it('the live re-read refreshes the numbers but not what is being typed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const m = mock(RULES);
    render(
      <RoleProvider role="ADMIN">
        <RetentionPage />
      </RoleProvider>,
    );
    const one = (await screen.findByTestId('retention-rule-r_one')) as HTMLDetailsElement;
    fireEvent.click(one.querySelector('summary')!);
    const name = one.querySelector('input.form-control') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'در حال تایپ' } });
    expect(m.reads()).toBe(1);

    vi.advanceTimersByTime(30_000);
    await vi.waitFor(() => expect(m.reads()).toBe(2));
    expect((one.querySelector('input.form-control') as HTMLInputElement).value).toBe('در حال تایپ');
  });
});
