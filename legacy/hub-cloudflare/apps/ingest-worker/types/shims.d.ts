/**
 * Shims for runtime-only modules that the Vitest pool provides via the
 * `?raw` SQL loader and `cloudflare:test` namespace. These never ship in the
 * production bundle, and the test files are excluded from the production
 * typecheck.
 */
declare module '*?raw' {
  const content: string;
  export default content;
}

declare module 'cloudflare:test' {
  export const env: D1Database & { DB: D1Database; TEST_ACCESS_USER?: string };
  export const SELF: { fetch: (input: Request | string, init?: RequestInit) => Promise<Response> };
}
