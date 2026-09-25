/**
 * The dashboard's sections — one per sidebar page — and what a custom access
 * group may do in each (issue #363).
 *
 * The worker enforces these and the SPA draws its sidebar from them, so the
 * list lives here rather than in either. `apps/admin-web/src/nav.ts` holds the
 * labels and order; a page added there without an id here fails typecheck.
 */
export const SECTION_IDS = [
  'dashboard',
  'stats',
  'profit',
  'customers',
  'referrals',
  'orders',
  'subscriptions',
  'requests',
  'resellers',
  'bulk',
  'panels',
  'catalog',
  'categories',
  'discounts',
  'stock',
  'payments',
  'today',
  'transactions',
  'expenses',
  'parties',
  'books',
  'accounts',
  'banks',
  'devices',
  'bot',
  'texts',
  'keyboard',
  'content',
  'cron',
  'retention',
  'settings',
  'access',
  'events',
  'import',
] as const;

export type SectionId = (typeof SECTION_IDS)[number];

/** An absent key is «none». */
export type SectionLevel = 'view' | 'edit';

export type SectionPerms = Partial<Record<SectionId, SectionLevel>>;

/** The groups migration 0100 seeds; their meaning is the legacy role's. */
export const BUILT_IN_GROUPS = ['admin', 'reviewer', 'read_only'] as const;
export type BuiltInGroup = (typeof BUILT_IN_GROUPS)[number];

export function isBuiltInGroup(id: string): id is BuiltInGroup {
  return (BUILT_IN_GROUPS as readonly string[]).includes(id);
}
