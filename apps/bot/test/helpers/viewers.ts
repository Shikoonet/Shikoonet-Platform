/**
 * Who is looking at the main menu, for the tests that draw it.
 *
 * Named rather than written inline, because `mainMenu({is_reseller: false,
 * is_admin: false})` in forty places is the shape a reader skims past — and the
 * whole point of the object is that the two answers are given together.
 */
import type { MenuViewer } from '../../src/keyboard.js';

/** The ordinary case: not a reseller, not an admin. */
export const CUSTOMER: MenuViewer = {
  is_reseller: false,
  is_admin: false,
  has_reseller_account: false,
};

export const RESELLER: MenuViewer = {
  is_reseller: true,
  is_admin: false,
  has_reseller_account: false,
};

/** Owns a panel admin on one of our panels (#474) — sees «🏢 پنل نمایندگی». */
export const PANEL_OWNER: MenuViewer = {
  is_reseller: true,
  is_admin: false,
  has_reseller_account: true,
};

export const ADMIN: MenuViewer = {
  is_reseller: false,
  is_admin: true,
  has_reseller_account: false,
};
