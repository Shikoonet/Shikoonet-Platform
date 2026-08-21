/**
 * What the process refuses to start without.
 *
 * The reason this file exists is a real afternoon lost on 2026-08-15. A bank
 * SMS was posted to a correctly running ingest, the parser read it, the
 * transaction candidate appeared — and no claim was ever decided. Nothing
 * failed, nothing logged, no 500. `MIRZABOT_INTEGRATION_ENABLED` and
 * `AUTO_MATCH_ENABLED` were simply absent, and absent means off.
 *
 * On this machine that costs an afternoon. On the new server it costs a
 * shop: every customer pays, every payment sits unverified, and the only
 * symptom is a queue that quietly stops moving.
 *
 * So these are the settings whose absence is indistinguishable from working,
 * and production is where guessing is not allowed.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { app } from '../src/index.js';
import { buildEnv } from '../src/server.js';
import type { Env } from '../src/index.js';

/** `buildEnv` only stores the handle; nothing here reaches the database. */
const NO_DB = {} as Env['DB'];

const KEYS = [
  'ENV_NAME',
  'MIRZABOT_INTEGRATION_ENABLED',
  'AUTO_MATCH_ENABLED',
  'AUTO_FULFILLMENT_ENABLED',
  'MIRZABOT_INTEGRATION_HMAC_SECRET',
  'MIRZABOT_INTEGRATION_ID',
  'INGEST_MAX_BODY_BYTES',
  'APP_VERSION',
  'SOURCE_COMMIT',
] as const;

const saved = new Map<string, string | undefined>();
// Written out rather than `Partial<Record<…>>` so a test may pass an explicit
// `undefined` to mean "unset this one", which `exactOptionalPropertyTypes`
// otherwise refuses.
function set(values: { [K in (typeof KEYS)[number]]?: string | undefined }): void {
  for (const key of KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

const PRODUCTION_ON = {
  ENV_NAME: 'production',
  MIRZABOT_INTEGRATION_ENABLED: 'true',
  AUTO_MATCH_ENABLED: 'true',
  AUTO_FULFILLMENT_ENABLED: 'true',
  MIRZABOT_INTEGRATION_HMAC_SECRET: 'a-real-secret',
  MIRZABOT_INTEGRATION_ID: 'shikoo-prod',
} as const;

describe('starting in production', () => {
  it('refuses to start with the auto-matching switches undecided', () => {
    set({ ENV_NAME: 'production' });
    // Both named, so one restart fixes both rather than finding the second
    // only after the first is set.
    expect(() => buildEnv(NO_DB)).toThrow(/MIRZABOT_INTEGRATION_ENABLED.*AUTO_MATCH_ENABLED/s);
  });

  it('refuses to start with fulfilment undecided, even when matching is set', () => {
    // The third switch, added 2026-08-18. It is the one that decides whether a
    // verified payment ever reaches the legacy bot, and absent read as off —
    // so a deploy that forgot it verified payments correctly and delivered
    // nothing, with both systems reporting success.
    set({
      ...PRODUCTION_ON,
      AUTO_FULFILLMENT_ENABLED: undefined,
    });
    expect(() => buildEnv(NO_DB)).toThrow(/AUTO_FULFILLMENT_ENABLED/);
  });

  it('names the consequence, not just the variable', () => {
    // Whoever reads this at 3am has to learn what breaks from the message
    // itself. "X is required" would send them to the source to find out.
    set({ ENV_NAME: 'production' });
    // Each switch names its own consequence: they are three different
    // failures, and one shared sentence made the message wrong for two of them.
    expect(() => buildEnv(NO_DB)).toThrow(/verified/);
    expect(() => buildEnv(NO_DB)).toThrow(/looks like an outage/);
    expect(() => buildEnv(NO_DB)).toThrow(/pay and receive nothing/);
  });

  it('accepts an explicit no, because that is a decision', () => {
    // A shop that wants every payment reviewed by hand is entitled to one.
    // What is refused is silence, not caution.
    set({
      ...PRODUCTION_ON,
      MIRZABOT_INTEGRATION_ENABLED: 'false',
      AUTO_MATCH_ENABLED: 'false',
      AUTO_FULFILLMENT_ENABLED: 'false',
    });
    expect(() => buildEnv(NO_DB)).not.toThrow();
  });

  it('refuses a value that is neither, instead of reading it as no', () => {
    // `=== 'true'` everywhere downstream means `True` and `1` and `yes` are all
    // silently off — the same failure this whole file is about, wearing a typo.
    set({ ...PRODUCTION_ON, AUTO_MATCH_ENABLED: 'True' });
    expect(() => buildEnv(NO_DB)).toThrow(/AUTO_MATCH_ENABLED/);
    set({ ...PRODUCTION_ON, AUTO_MATCH_ENABLED: '1' });
    expect(() => buildEnv(NO_DB)).toThrow(/AUTO_MATCH_ENABLED/);
  });

  it('refuses to run the integration under its test identity', () => {
    // `MIRZABOT_INTEGRATION_ID` falls back to 'mirzabot-test' at the route, so
    // a production integration would sign and record itself as the test one.
    set({ ...PRODUCTION_ON, MIRZABOT_INTEGRATION_ID: undefined });
    expect(() => buildEnv(NO_DB)).toThrow(/MIRZABOT_INTEGRATION_ID/);
  });

  it('refuses to enable the integration with no HMAC secret', () => {
    // Without it every claim the PHP bot posts is answered 503, which reads
    // from the other end as the endpoint being down.
    set({ ...PRODUCTION_ON, MIRZABOT_INTEGRATION_HMAC_SECRET: undefined });
    expect(() => buildEnv(NO_DB)).toThrow(/MIRZABOT_INTEGRATION_HMAC_SECRET/);
  });

  it('does not ask for the integration secrets when the integration is off', () => {
    set({
      ENV_NAME: 'production',
      MIRZABOT_INTEGRATION_ENABLED: 'false',
      AUTO_MATCH_ENABLED: 'true',
      AUTO_FULFILLMENT_ENABLED: 'false',
    });
    expect(() => buildEnv(NO_DB)).not.toThrow();
  });

  it('starts when every one of them has been decided', () => {
    set(PRODUCTION_ON);
    const env = buildEnv(NO_DB);
    expect(env.MIRZABOT_INTEGRATION_ENABLED).toBe('true');
    expect(env.AUTO_MATCH_ENABLED).toBe('true');
  });
});

describe('the body cap', () => {
  it('refuses a value that is not a positive whole number of bytes', () => {
    // `Number.parseInt('8kb')` is `NaN`, and every comparison against NaN is
    // false — so this typo did not widen the cap on the only public endpoint,
    // it removed it. The plausible-looking spellings are the dangerous ones.
    for (const value of ['8kb', '8 KB', '0', '-1', '1.5', 'unlimited']) {
      set({ ENV_NAME: 'local', INGEST_MAX_BODY_BYTES: value });
      expect(() => buildEnv(NO_DB)).toThrow(/INGEST_MAX_BODY_BYTES/);
    }
  });

  it('accepts a real one, and leaves it unset alone', () => {
    set({ ENV_NAME: 'local', INGEST_MAX_BODY_BYTES: '16384' });
    expect(buildEnv(NO_DB).INGEST_MAX_BODY_BYTES).toBe('16384');
    set({ ENV_NAME: 'local' });
    expect(buildEnv(NO_DB).INGEST_MAX_BODY_BYTES).toBeUndefined();
  });
});

describe('which environment this is', () => {
  it('refuses to start with ENV_NAME unset', () => {
    // This used to default to `local`, and `local` is the setting under which
    // every guard in this file is skipped. So the whole of `assertProductionConfig`
    // hung on one variable that nobody had to remember to set — and there is no
    // way to detect "this is a deployment" that does not itself read it.
    set({});
    expect(() => buildEnv(NO_DB)).toThrow(/ENV_NAME is required/);
  });

  it('refuses a near miss instead of reading it as local', () => {
    // The failure this replaces: `prod` is not `production`, so a deploy with
    // this typo demanded no decision on the two switches above, and every
    // payment would sit unverified with nothing saying why.
    for (const value of ['prod', 'Production', 'production-space', 'PRODUCTION']) {
      set({ ...PRODUCTION_ON, ENV_NAME: value });
      expect(() => buildEnv(NO_DB)).toThrow(/is not one of/);
    }
  });

  it('accepts the four it knows', () => {
    // `local` and `test` stay effortless on purpose: the simulation is started
    // by hand a dozen times a day and demanding five variables there would only
    // teach everyone to export them blindly. What is refused is a guess.
    for (const value of ['local', 'test', 'staging']) {
      set({ ENV_NAME: value });
      expect(buildEnv(NO_DB).ENV_NAME).toBe(value);
    }
    set(PRODUCTION_ON);
    expect(buildEnv(NO_DB).ENV_NAME).toBe('production');
  });
});

describe('which build this is', () => {
  // A commit that is not the one in the release name, so a test that reads the
  // wrong variable cannot pass by accident.
  const SHA = '5a81153a36c4c629dd134b53a5c786fcea7a31f2';

  async function versionSays(): Promise<{ version: string; env: string }> {
    const res = await app.fetch(new Request('http://ingest.test/version'), buildEnv(NO_DB));
    expect(res.status).toBe(200);
    return (await res.json()) as { version: string; env: string };
  }

  it('answers the commit Coolify deployed', async () => {
    // The bug this closes. `APP_VERSION` was set by `scripts/release.sh` in the
    // Cloudflare deployment and by nothing after it, so `/version` answered the
    // literal string `dev` on production for months — and no test anywhere read
    // this route, which is why nobody found out.
    //
    // `SOURCE_COMMIT` is not a hopeful guess about what a container might have:
    // it was read out of the running ingest container on 2026-08-22 and matched
    // the image tag Coolify had built, character for character.
    set({ ...PRODUCTION_ON, SOURCE_COMMIT: SHA });
    expect((await versionSays()).version).toBe(SHA);
  });

  it('lets an explicit release name win', async () => {
    // Naming a release by hand still works, and still beats the sha — the sha
    // is the fallback for when nobody named one, not a replacement.
    set({ ...PRODUCTION_ON, APP_VERSION: 'v2.3.0', SOURCE_COMMIT: SHA });
    expect((await versionSays()).version).toBe('v2.3.0');
  });

  it('treats a variable defined as empty as one nobody filled in', async () => {
    // `?? ` would take the empty string and answer with nothing at all, which
    // reads as a broken endpoint rather than an unset variable.
    set({ ...PRODUCTION_ON, APP_VERSION: '   ', SOURCE_COMMIT: SHA });
    expect((await versionSays()).version).toBe(SHA);
  });

  it('still says dev when neither is set, rather than inventing one', async () => {
    set(PRODUCTION_ON);
    const body = await versionSays();
    expect(body.version).toBe('dev');
    // And it does say which environment, which is the half that always worked.
    expect(body.env).toBe('production');
  });
});
