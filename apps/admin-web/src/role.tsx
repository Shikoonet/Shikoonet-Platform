/**
 * Who is signed in, for the controls rather than for the sidebar.
 *
 * `nav.ts` already keeps a READ_ONLY operator out of the sections they may not
 * read. This is the other half of the same sentence, and until now it did not
 * exist: inside the fifteen sections a reader *is* offered, every «ذخیره»,
 * «حذف» and «تازه» was drawn exactly as it is for the shop's owner, and
 * pressing one answered 403.
 *
 * The boundary is not here and never was — `write-roles.test.ts` asks all 114
 * write routes what they say to a reader, and the answer is what keeps data in.
 * What this file fixes is the thing `nav.ts` says about the sidebar, one level
 * down: «a panel that offers a door and then refuses it reads as broken rather
 * than as a boundary.»
 *
 * ## Why a context and not a prop
 *
 * `App.tsx` renders fifteen screens and hands `role` to exactly one of them.
 * Threading it through the other fourteen would put the same prop in fourteen
 * signatures for the benefit of a button three components down — and the first
 * page written afterwards would forget it silently. A context is read where it
 * is used.
 *
 * ## Why the default is «may write»
 *
 * With no provider — a unit test rendering one page on its own — the role is
 * unknown, and unknown means the control is drawn as it always was. Guessing
 * the other way would make every existing test assert against a disabled panel
 * that no operator ever sees. Nothing is protected by this file, so a wrong
 * guess here costs a confusing screen, never data.
 */

import { createContext, useContext, type ReactNode } from 'react';
import type { PanelRole } from './api.js';

const RoleContext = createContext<PanelRole | null>(null);

export function RoleProvider({ role, children }: { role: PanelRole | null; children: ReactNode }) {
  return <RoleContext.Provider value={role}>{children}</RoleContext.Provider>;
}

export function useRole(): PanelRole | null {
  return useContext(RoleContext);
}

/**
 * Whether this operator may write **on the payments surface**.
 *
 * REVIEWER may: approving a claim, declining an income row, rotating a device
 * token and editing the bank patterns are the job that role exists for, and
 * `write-roles.test.ts` proves the server lets them ("lets a REVIEWER do the
 * job a REVIEWER exists for"). READ_ONLY may not. Unknown counts as yes.
 */
export function useCanWrite(): boolean {
  return useContext(RoleContext) !== 'READ_ONLY';
}

/**
 * Whether this operator may write **on the admin surface** — `/api/v1/admin/*`.
 *
 * A narrower rule, and the first version of this file had only the wider one.
 * That was wrong in the case that matters most: every write under
 * `/api/v1/admin/` is ADMIN-only, so a REVIEWER opening «محصولات» would have
 * been shown a live «ذخیره» that answers 403 — exactly the bug this file is
 * here to remove, moved one role along rather than fixed.
 *
 * The rule was read off `write-roles.test.ts`, which enumerates `app.routes`
 * and asserts it ("keeps every admin-surface write for ADMIN, so a REVIEWER is
 * a payments role"), not off a sentence in a comment.
 *
 * The split follows the directory: `pages/` is the admin surface, `hub/` is the
 * payments surface. One exception on the server — previewing a bulk price
 * change is open to any operator while applying one is not — and previewing has
 * no control of its own here.
 */
export function useCanWriteAdmin(): boolean {
  const role = useContext(RoleContext);
  return role === null || role === 'ADMIN';
}

/**
 * Said on the control itself, because there is nowhere else to say it.
 *
 * A disabled button with no explanation is indistinguishable from a broken one.
 * `title` is what a mouse finds and `aria-label` is what a screen reader reads;
 * the banner in `App.tsx` is what everyone else finds, and the two are meant to
 * be read together.
 */
export const READ_ONLY_HINT = 'نقش شما فقط-خواندنی است و اجازهٔ تغییر ندارد';

/** The same sentence for the narrower rule, which stops a REVIEWER too. */
export const ADMIN_ONLY_HINT = 'تغییر این بخش فقط با نقش «مدیر» ممکن است';

/**
 * Spread onto any control that writes: `<button ... {...write}>`.
 *
 * Last in the attribute list on purpose. A control that is already
 * `disabled={busy}` keeps that behaviour for an operator who may write — the
 * spread is empty for them — and is unconditionally disabled for one who may
 * not, whatever `busy` happens to be.
 *
 * An empty object rather than `disabled={false}`: writing the attribute out
 * would override a `disabled={busy}` sitting to its left and re-enable a
 * button mid-save.
 */
export function useWriteProps(): WriteProps {
  return useCanWrite() ? {} : { disabled: true, title: READ_ONLY_HINT };
}

/** The same, for a control under `pages/` — the `/api/v1/admin/*` surface. */
export function useAdminWriteProps(): WriteProps {
  return useCanWriteAdmin() ? {} : { disabled: true, title: ADMIN_ONLY_HINT };
}

type WriteProps = { disabled?: true; title?: string };
