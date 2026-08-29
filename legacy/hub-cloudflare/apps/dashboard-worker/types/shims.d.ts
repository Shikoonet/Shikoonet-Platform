/**
 * Shims for runtime-only modules that the production Worker uses via
 * dynamic `import()` (jose) or via the Vitest pool's `?raw` + `cloudflare:test`
 * plugins. These never ship in the production bundle — the bundler tree-shakes
 * the dynamic import when `TEST_ACCESS_USER` is unset in production, and the
 * test files are excluded from the production typecheck.
 */
declare module 'jose' {
  export function jwtVerify(
    jwt: string,
    key: unknown,
    options: { audience: string; issuer: string },
  ): Promise<{ payload: { email?: unknown } }>;
  export function createRemoteJWKSet(url: URL): unknown;
}

declare module '*?raw' {
  const content: string;
  export default content;
}

declare module 'cloudflare:test' {
  export const env: {
    DB: D1Database;
    TEST_ACCESS_USER?: string;
    ACCESS_AUD?: string;
    ACCESS_ISSUER?: string;
  };
  export const SELF: { fetch: (input: Request | string, init?: RequestInit) => Promise<Response> };
}
