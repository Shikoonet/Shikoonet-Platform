/**
 * «کمپین‌ها» (#471) — what the page does with what the server says.
 *
 * The numbers are the server's (`campaigns.test.ts` pins them against hand-
 * summed orders); this file pins the screen's own jobs: the link a campaign is
 * put on an ad with, the warning when that link cannot be built, and that only
 * an admin is offered the writes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CampaignsPage } from '../src/pages/CampaignsPage.js';
import { RoleProvider } from '../src/role.js';
import type { CampaignList } from '../src/api.js';

const SPRING = {
  id: 1,
  slug: 'spring-insta',
  name: 'اینستاگرام بهار',
  source: 'اینستاگرام',
  note: '',
  status: 'ACTIVE' as const,
  createdAt: Date.UTC(2026, 8, 1),
  starts: 12,
  newUsers: 5,
  buyers: 3,
  newBuyers: 2,
  revenueIrr: 45_000_000,
  newRevenueIrr: 30_000_000,
};

let listed: CampaignList = {
  ok: true,
  startMs: null,
  endMs: null,
  botUsername: 'shikoonet_bot',
  items: [SPRING],
};
const campaigns = vi.fn(async () => listed);
const add = vi.fn(async (_body: unknown) => ({ ok: true, id: 2 }));

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      campaigns: () => campaigns(),
      campaign: vi.fn(),
      addCampaign: (body: unknown) => add(body),
      editCampaign: vi.fn(async () => ({ ok: true })),
    },
  };
});

function draw(role: 'ADMIN' | 'REVIEWER' = 'ADMIN') {
  render(
    <RoleProvider role={role}>
      <CampaignsPage />
    </RoleProvider>,
  );
}

afterEach(() => {
  listed = { ...listed, botUsername: 'shikoonet_bot' };
  vi.clearAllMocks();
});

describe('«کمپین‌ها»', () => {
  it('draws the funnel and the link the campaign goes out on', async () => {
    draw();

    await screen.findByText('اینستاگرام بهار');
    expect(screen.getByText('c_spring-insta')).toBeTruthy();
    // The exact link, carried where a hover finds it and a copy takes it.
    expect(screen.getByTitle('https://t.me/shikoonet_bot?start=c_spring-insta')).toBeTruthy();
  });

  it('says so when the bot has no username, instead of offering a broken link', async () => {
    listed = { ...listed, botUsername: null };
    draw();

    await screen.findByText(/نام کاربری ربات/);
    expect(screen.queryByText('کپی لینک')).toBeNull();
  });

  it('offers the writes to an admin only', async () => {
    draw('REVIEWER');

    await screen.findByText('اینستاگرام بهار');
    expect((screen.getByText('کمپین تازه') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('بایگانی') as HTMLButtonElement).disabled).toBe(true);
  });

  it('creates a campaign from its slug and name', async () => {
    draw();
    await screen.findByText('اینستاگرام بهار');

    fireEvent.click(screen.getByText('کمپین تازه'));
    fireEvent.change(screen.getByLabelText('شناسه در لینک'), {
      target: { value: 'autumn-channel' },
    });
    fireEvent.change(screen.getByLabelText('نام'), { target: { value: 'کانال پاییز' } });
    fireEvent.click(screen.getByText('بساز'));

    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(add.mock.calls[0]![0]).toMatchObject({ slug: 'autumn-channel', name: 'کانال پاییز' });
  });
});
