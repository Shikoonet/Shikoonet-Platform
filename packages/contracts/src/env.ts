/**
 * Which environment a process believes it is running in.
 *
 * ## Why this is a type and not a string
 *
 * Every security decision that separates a deployment from a laptop was written
 * as `ENV_NAME !== 'production'`, and `ENV_NAME` came from
 * `process.env.ENV_NAME ?? 'local'`. So `prod`, `Production`, `production ` and
 * a variable somebody forgot to set all read as **local**, and reading as local
 * means: the login bypass stays available, a state-changing request with no
 * Origin at all is accepted, the session cookie may go out without `Secure`,
 * and ingest stops demanding a decision on the two switches that decide whether
 * money is ever verified.
 *
 * Every one of those is fail-open, and all of them turn on one typo in a
 * variable nobody reads after the first deploy.
 *
 * Two things follow, and the second matters more than the first:
 *
 *   - **An unknown value is refused, and so is an absent one.** There is no way
 *     to ask "am I deployed?" that does not itself depend on this variable, so
 *     rather than guess, every process says which environment it is. That is
 *     one line in `deploy/README.md` and one in the run commands.
 *   - **The parsed value is a union type, not a string.** A comparison against
 *     `'prod'` stops compiling, in production code and in tests alike. The
 *     runtime check catches the environment; the type catches the next person.
 */

export const ENV_NAMES = ['local', 'test', 'staging', 'production'] as const;

export type EnvName = (typeof ENV_NAMES)[number];

/**
 * Environments where a developer convenience may be switched on.
 *
 * `TEST_ACCESS_USER` skips the login entirely, so the question is not "is this
 * production" — a staging box on the public internet with the login skipped is
 * just as open. Asked as an allowlist, a new environment name added later is
 * locked down by default rather than open by default.
 */
const RELAXED: readonly EnvName[] = ['local', 'test'];

export function isEnvName(value: unknown): value is EnvName {
  return typeof value === 'string' && (ENV_NAMES as readonly string[]).includes(value);
}

/**
 * Whether developer bypasses are permitted here. Anything unknown: no.
 *
 * Takes a plain string so a caller reading `process.env` directly — the seed
 * runner does — needs no cast to ask the same question the services ask.
 */
export function isRelaxedEnv(value: string | undefined): boolean {
  return value !== undefined && (RELAXED as readonly string[]).includes(value);
}

/**
 * Reads `ENV_NAME` from a raw environment value, or throws.
 *
 * Called once per process at startup, so the failure is a process that will not
 * boot rather than a wall that will not stand.
 */
export function parseEnvName(raw: string | undefined): EnvName {
  const value = raw?.trim();
  if (value === undefined || value === '') {
    throw new Error(
      `ENV_NAME is required and must be one of: ${ENV_NAMES.join(', ')}. It decides ` +
        'whether the login bypass, an Origin-less write and an insecure cookie are ' +
        'allowed, so there is no safe default to fall back to.',
    );
  }
  if (!isEnvName(value)) {
    throw new Error(
      `ENV_NAME=${JSON.stringify(raw)} is not one of: ${ENV_NAMES.join(', ')}. ` +
        'Near-misses like "prod" or "Production" used to read as "local", which ' +
        'silently switched off every guard that separates a deployment from a laptop.',
    );
  }
  return value;
}
