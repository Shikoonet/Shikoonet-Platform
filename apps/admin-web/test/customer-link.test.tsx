/**
 * The link that turns thirty-one screens into a workflow.
 *
 * Every ledger row already names a customer and, until now, named them as dead
 * text: an operator reading «سفارش ناموفق، @reza_kh» had to select the handle,
 * open «کاربران», paste it, search, and press «مدیریت» — five steps to answer
 * «who is this and what else happened to them».
 *
 * Two things are asserted here and both are about what the operator gets, not
 * about how it is built:
 *
 *  1. It is a real `<a href>`, so middle-click and «open in new tab» work. A
 *     `<button onClick>` that pushes state looks identical and silently loses
 *     both, on a screen whose whole job is comparing two rows side by side.
 *  2. READ_ONLY gets the text and no link. That role cannot open «کاربران» at
 *     all — `READABLE_BY_READER` in `nav.ts` leaves it out and `mayRead`
 *     answers 403 — but it CAN open «پرداخت‌ها» and «امروز», which print
 *     telegram ids. A link there is a door to a 403.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CustomerLink } from '../src/CustomerLink.js';
import { RoleProvider } from '../src/role.js';

const at = (role: 'ADMIN' | 'REVIEWER' | 'READ_ONLY', node: React.ReactNode) =>
  render(<RoleProvider role={role}>{node}</RoleProvider>);

describe('a link to the customer a row is about', () => {
  it('addresses them by their internal id when the row carries one', () => {
    at('ADMIN', <CustomerLink customer={{ id: 5, telegramId: 7_137_494_513, username: 'reza_kh' }} />);
    const a = screen.getByRole('link', { name: '@reza_kh' });
    expect(a.getAttribute('href')).toBe('/customers?id=5');
  });

  it('falls back to a search when the row has only a telegram id', () => {
    // The hub's payment screens carry the telegram id and no user row id.
    // Searching for it lands on the same customer; it is one extra query, not
    // a broken link.
    at('ADMIN', <CustomerLink customer={{ telegramId: 7_137_494_513 }} />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('/customers?q=7137494513');
  });

  it('prints the telegram id when there is no username, never an empty link', () => {
    at('ADMIN', <CustomerLink customer={{ id: 5, telegramId: 7_137_494_513, username: null }} />);
    expect(screen.getByRole('link').textContent).toBe('7137494513');
  });

  it('gives a reviewer the same door, because a reviewer may open it', () => {
    at('REVIEWER', <CustomerLink customer={{ id: 5, telegramId: 1, username: 'sara' }} />);
    expect(screen.getByRole('link')).toBeTruthy();
  });

  it('gives READ_ONLY the name and no door', () => {
    at('READ_ONLY', <CustomerLink customer={{ id: 5, telegramId: 1, username: 'sara' }} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('@sara')).toBeTruthy();
  });
});
