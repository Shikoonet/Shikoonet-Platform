import { describe, expect, it } from 'vitest';
import { DialectError, parameterCount, toPostgres } from '../src/dialect.js';

describe('placeholders', () => {
  it('renumbers ?N to $N', () => {
    expect(toPostgres('SELECT * FROM t WHERE a = ?1 AND b = ?2')).toBe(
      'SELECT * FROM t WHERE a = $1 AND b = $2',
    );
  });

  it('keeps a reused number reused', () => {
    // mirzabotVerify binds ?8 into created_at, updated_at and reviewed_at.
    expect(toPostgres('VALUES (?1, ?8, ?8, ?8)')).toBe('VALUES ($1, $8, $8, $8)');
  });

  it('handles double-digit numbers', () => {
    expect(toPostgres('VALUES (?9, ?10, ?11, ?16)')).toBe('VALUES ($9, $10, $11, $16)');
  });

  it('leaves ?1 inside a string literal alone', () => {
    // Rewriting this would corrupt the stored value, not just the query.
    expect(toPostgres("SELECT ?1, 'literal ?1 stays'")).toBe(
      "SELECT $1, 'literal ?1 stays'",
    );
  });

  it('survives an escaped quote inside a literal', () => {
    expect(toPostgres("SELECT ?1 WHERE x = 'it''s ?2 here' AND y = ?3")).toBe(
      "SELECT $1 WHERE x = 'it''s ?2 here' AND y = $3",
    );
  });

  it('leaves ?N inside comments alone', () => {
    expect(toPostgres('SELECT ?1 -- not ?2\nFROM t')).toBe('SELECT $1 -- not ?2\nFROM t');
    expect(toPostgres('SELECT ?1 /* not ?2 */ FROM t')).toBe(
      'SELECT $1 /* not ?2 */ FROM t',
    );
  });

  it('refuses an anonymous ? rather than guessing its position', () => {
    expect(() => toPostgres('SELECT * FROM t WHERE a = ?')).toThrow(DialectError);
  });

  it('counts parameters for a translated statement', () => {
    expect(parameterCount('VALUES ($1, $8, $8, $3)')).toBe(8);
    expect(parameterCount("SELECT 'a $9'")).toBe(0);
  });
});

describe('INSERT OR IGNORE', () => {
  it('becomes ON CONFLICT DO NOTHING', () => {
    expect(
      toPostgres('INSERT OR IGNORE INTO t (a, b) VALUES (?1, ?2)'),
    ).toBe('INSERT INTO t (a, b) VALUES ($1, $2) ON CONFLICT DO NOTHING');
  });

  it('tolerates odd whitespace and a trailing semicolon', () => {
    expect(toPostgres('INSERT   OR\n IGNORE  INTO t VALUES (?1) ;')).toBe(
      'INSERT INTO t VALUES ($1) ON CONFLICT DO NOTHING',
    );
  });

  it('leaves a plain INSERT untouched', () => {
    // The consuming-match insert must keep raising on conflict so that a racing
    // approval aborts instead of silently doing nothing.
    const sql =
      'INSERT INTO reconciliation_matches (id) VALUES (?1) ' +
      'ON CONFLICT(transaction_candidate_id, payment_claim_id) DO UPDATE SET status = excluded.status';
    expect(toPostgres(sql)).toBe(sql.replace('?1', '$1'));
  });

  it('refuses to combine OR IGNORE with an explicit ON CONFLICT', () => {
    expect(() =>
      toPostgres('INSERT OR IGNORE INTO t VALUES (?1) ON CONFLICT (a) DO UPDATE SET b = 1'),
    ).toThrow(DialectError);
  });

  it('refuses OR IGNORE with RETURNING, which needs a real conflict target', () => {
    expect(() => toPostgres('INSERT OR IGNORE INTO t VALUES (?1) RETURNING id')).toThrow(
      DialectError,
    );
  });

  it('does not trip on the words inside a comment or literal', () => {
    const sql = "SELECT ?1 -- INSERT OR IGNORE INTO t\nFROM x WHERE s = 'INSERT OR IGNORE'";
    expect(toPostgres(sql)).toBe(sql.replace('?1', '$1'));
  });
});

describe('statements the hub already writes in valid Postgres', () => {
  it('passes ON CONFLICT ... DO UPDATE ... WHERE through unchanged', () => {
    const sql = `INSERT INTO transaction_reviews (id, transaction_candidate_id)
     VALUES (?1, ?2)
     ON CONFLICT(transaction_candidate_id) DO UPDATE SET
       decision = excluded.decision`;
    expect(toPostgres(sql)).toBe(sql.replace('?1', '$1').replace('?2', '$2'));
  });

  it('leaves a quoted identifier alone', () => {
    expect(toPostgres('SELECT "odd?1name" FROM t WHERE a = ?1')).toBe(
      'SELECT "odd?1name" FROM t WHERE a = $1',
    );
  });
});
