/**
 * Where the migration is allowed to write.
 *
 * Every other value in `loadConfig` is a source: get one wrong and it fails to
 * connect, or reads the wrong rows and `verify` refuses to agree. `DATABASE_URL`
 * is the destination, and it used to default to the simulation database on this
 * laptop — so a cutover run with a forgotten export would have migrated
 * production into the wrong Postgres, reported zero Rial of difference, and
 * been telling the truth about a database nobody wanted.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/db.js';

const saved = process.env.DATABASE_URL;
afterEach(() => {
  if (saved === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = saved;
});

describe('loadConfig', () => {
  it('refuses to invent a destination', () => {
    delete process.env.DATABASE_URL;
    expect(() => loadConfig()).toThrow(/DATABASE_URL is required/);
  });

  it('treats an empty one as absent rather than as localhost', () => {
    process.env.DATABASE_URL = '';
    expect(() => loadConfig()).toThrow(/DATABASE_URL is required/);
  });

  it('uses exactly the destination it was given', () => {
    process.env.DATABASE_URL = 'postgres://someone@example.invalid:5432/elsewhere';
    expect(loadConfig().postgres.connectionString).toBe(
      'postgres://someone@example.invalid:5432/elsewhere',
    );
  });

  it('still defaults the sources, which are safe to guess wrong', () => {
    // Deliberately asymmetric: a wrong MySQL host cannot destroy anything, it
    // just fails to connect. Demanding five exports to read the dump would be
    // ceremony, and ceremony is what gets pasted in without reading.
    process.env.DATABASE_URL = 'postgres://x@127.0.0.1:5433/y';
    expect(loadConfig().mysql.port).toBe(3307);
    expect(loadConfig().mysql.database).toBe('mirzabot');
  });
});
