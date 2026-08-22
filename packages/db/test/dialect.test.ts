import { describe, expect, it } from 'vitest';
import { compactParameters, DialectError, parameterCount, toPostgres } from '../src/dialect.js';

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
    expect(toPostgres("SELECT ?1, 'literal ?1 stays'")).toBe("SELECT $1, 'literal ?1 stays'");
  });

  it('survives an escaped quote inside a literal', () => {
    expect(toPostgres("SELECT ?1 WHERE x = 'it''s ?2 here' AND y = ?3")).toBe(
      "SELECT $1 WHERE x = 'it''s ?2 here' AND y = $3",
    );
  });

  it('leaves ?N inside comments alone', () => {
    expect(toPostgres('SELECT ?1 -- not ?2\nFROM t')).toBe('SELECT $1 -- not ?2\nFROM t');
    expect(toPostgres('SELECT ?1 /* not ?2 */ FROM t')).toBe('SELECT $1 /* not ?2 */ FROM t');
  });

  it('numbers bare ? placeholders left to right', () => {
    // D1 accepts both styles; the hub's tests use this one.
    expect(toPostgres('INSERT INTO t (a, b, c) VALUES (?, ?, ?)')).toBe(
      'INSERT INTO t (a, b, c) VALUES ($1, $2, $3)',
    );
  });

  it('does not count a ? inside a literal as a placeholder', () => {
    expect(toPostgres("SELECT ? WHERE label = 'why? really'")).toBe(
      "SELECT $1 WHERE label = 'why? really'",
    );
  });

  it('refuses a statement that mixes both styles', () => {
    // SQLite's numbering rule for a bare ? after an explicit ?3 is subtle
    // enough that translating it would be a guess.
    expect(() => toPostgres('SELECT * FROM t WHERE a = ?1 AND b = ?')).toThrow(DialectError);
  });

  it('counts parameters for a translated statement', () => {
    expect(parameterCount('VALUES ($1, $8, $8, $3)')).toBe(8);
    expect(parameterCount("SELECT 'a $9'")).toBe(0);
  });
});

describe('INSERT OR IGNORE', () => {
  it('becomes ON CONFLICT DO NOTHING', () => {
    expect(toPostgres('INSERT OR IGNORE INTO t (a, b) VALUES (?1, ?2)')).toBe(
      'INSERT INTO t (a, b) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    );
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

describe('parameter gaps', () => {
  it('leaves a gapless statement untouched', () => {
    const plan = compactParameters('SELECT * FROM t WHERE a = $1 AND b = $2');
    expect(plan.sql).toBe('SELECT * FROM t WHERE a = $1 AND b = $2');
    expect(plan.keep).toEqual([1, 2]);
  });

  it('closes a gap left by an omitted SQL fragment', () => {
    // The hub concatenates optional fragments, so $2 can go missing while $3
    // stays. SQLite ignores the unused bound value; Postgres cannot infer a
    // type for it and fails the whole statement.
    const plan = compactParameters('SELECT $1 FROM t JOIN u ON u.e = $3');
    expect(plan.sql).toBe('SELECT $1 FROM t JOIN u ON u.e = $2');
    expect(plan.keep).toEqual([1, 3]);
  });

  it('treats a repeated parameter as one value', () => {
    const plan = compactParameters('SELECT $4 WHERE a = $4 AND b = $4');
    expect(plan.sql).toBe('SELECT $1 WHERE a = $1 AND b = $1');
    expect(plan.keep).toEqual([4]);
  });

  it('ignores a $n inside a string literal', () => {
    const plan = compactParameters("SELECT $1, 'costs $3 total'");
    expect(plan.sql).toBe("SELECT $1, 'costs $3 total'");
    expect(plan.keep).toEqual([1]);
  });
});
