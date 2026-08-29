/**
 * Helpers that exist so this package's TypeScript compiles cleanly in a
 * plain Node environment (no Workers runtime). The real seed is wired
 * through `wrangler d1 execute --local --file=-` in CI/local; see
 * docs/local-development.md.
 *
 * ponytail: this exists. The seed runs via `wrangler d1 execute` so the
 * D1 binding is provided by wrangler, not imported here.
 */
export async function applyD1Migrations(_db: unknown): Promise<void> {
  /* no-op — wrangler applies migrations */
}
export function getD1Binding(_name: string): unknown {
  throw new Error('seed: use wrangler d1 execute — see docs/local-development.md');
}
