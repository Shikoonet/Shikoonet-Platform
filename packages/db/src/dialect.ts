/**
 * SQLite-to-Postgres SQL translation.
 *
 * The hub's ~370 SQL statements were written for D1. Rather than rewrite them —
 * which would mean re-reviewing every money query — they are translated at
 * prepare() time. The gap turned out to be exactly two constructs; everything
 * else the hub uses (ON CONFLICT ... DO UPDATE, excluded.*, partial indexes,
 * window functions) is already valid Postgres.
 *
 * A scan of packages/ and apps/ found no strftime, julianday, IFNULL,
 * group_concat, AUTOINCREMENT, or SQLite-only rowid usage.
 */

/** Raised when a statement cannot be translated safely. */
export class DialectError extends Error {
  constructor(
    reason: string,
    readonly sql: string,
  ) {
    super(`${reason}\n  in: ${sql.slice(0, 200)}`);
    this.name = 'DialectError';
  }
}

/**
 * Splits SQL into alternating code and non-code (string literal / comment)
 * spans, so rewrites never touch the inside of a literal.
 *
 * `?1` inside a string is data, not a placeholder — for example a message
 * template or a LIKE pattern. Rewriting it would silently corrupt the value.
 */
function scan(sql: string): { text: string; code: boolean }[] {
  const spans: { text: string; code: boolean }[] = [];
  let i = 0;
  let start = 0;

  const push = (end: number, code: boolean) => {
    if (end > start) spans.push({ text: sql.slice(start, end), code });
    start = end;
  };

  while (i < sql.length) {
    const c = sql[i];
    // Single-quoted literal; '' is an escaped quote.
    if (c === "'") {
      push(i, true);
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
      push(i, false);
      continue;
    }
    // Double-quoted identifier.
    if (c === '"') {
      push(i, true);
      i++;
      while (i < sql.length && sql[i] !== '"') i++;
      i++;
      push(i, false);
      continue;
    }
    // Line comment.
    if (c === '-' && sql[i + 1] === '-') {
      push(i, true);
      while (i < sql.length && sql[i] !== '\n') i++;
      push(i, false);
      continue;
    }
    // Block comment.
    if (c === '/' && sql[i + 1] === '*') {
      push(i, true);
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      push(Math.min(i, sql.length), false);
      continue;
    }
    i++;
  }
  push(sql.length, true);
  return spans;
}

function mapCode(sql: string, fn: (code: string) => string): string {
  return scan(sql)
    .map((s) => (s.code ? fn(s.text) : s.text))
    .join('');
}

/**
 * `INSERT OR IGNORE INTO t (...) VALUES (...)`
 *   -> `INSERT INTO t (...) VALUES (...) ON CONFLICT DO NOTHING`
 *
 * A deliberate narrowing: SQLite's OR IGNORE swallows *every* constraint
 * violation, including CHECK and NOT NULL. `ON CONFLICT DO NOTHING` only
 * swallows a uniqueness conflict, which is the single case these statements
 * actually mean. A CHECK violation now raises instead of vanishing.
 *
 * Statements that already carry their own conflict handling are left alone —
 * the money-critical consuming-match insert in mirzabotVerify.ts is one of
 * those, and it must keep raising on conflict so a racing approval aborts.
 */
/** The statement with every literal and comment blanked out. */
function codeOnly(sql: string): string {
  return scan(sql)
    .map((s) => (s.code ? s.text : ' '))
    .join('');
}

function rewriteInsertOrIgnore(sql: string): string {
  // Detect on code only. Testing the raw string would append a conflict clause
  // to any statement that merely mentions the phrase in a comment — which the
  // `does not trip on the words inside a comment or literal` test proved.
  if (!/\bINSERT\s+OR\s+IGNORE\b/i.test(codeOnly(sql))) return sql;

  const stripped = mapCode(sql, (code) =>
    code.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT INTO'),
  );

  const remaining = codeOnly(stripped);

  if (/\bON\s+CONFLICT\b/i.test(remaining)) {
    throw new DialectError(
      'INSERT OR IGNORE combined with an explicit ON CONFLICT clause is ambiguous',
      sql,
    );
  }
  if (/\bRETURNING\b/i.test(remaining)) {
    throw new DialectError(
      'INSERT OR IGNORE with RETURNING needs a hand-written ON CONFLICT target',
      sql,
    );
  }

  const trimmed = stripped.replace(/\s*;\s*$/, '');
  return `${trimmed} ON CONFLICT DO NOTHING`;
}

/**
 * `?1, ?2` -> `$1, $2`, and bare `?, ?` -> `$1, $2`.
 *
 * D1 accepts both styles. Numbered placeholders may repeat a number, which
 * Postgres also allows, so those translate one-for-one. Anonymous ones bind
 * left to right, so they are numbered in the order they appear.
 *
 * Mixing the two in one statement is refused rather than guessed: SQLite's rule
 * for what `?` means after an explicit `?3` is subtle enough that any
 * translation would be a coin flip with someone's money on it.
 */
function rewritePlaceholders(sql: string): string {
  const spans = scan(sql);
  const code = spans
    .filter((s) => s.code)
    .map((s) => s.text)
    .join('');
  const hasNumbered = /\?[0-9]/.test(code);
  const hasAnonymous = /\?(?![0-9])/.test(code.replace(/\?[0-9]+/g, ''));

  if (hasNumbered && hasAnonymous) {
    throw new DialectError(
      'statement mixes ?N and bare ? placeholders — number them consistently',
      sql,
    );
  }

  if (hasAnonymous) {
    let next = 0;
    return mapCode(sql, (part) => part.replace(/\?/g, () => `$${++next}`));
  }
  return mapCode(sql, (part) => part.replace(/\?([0-9]+)/g, '$$$1'));
}

const cache = new Map<string, string>();

/** Translates one SQLite statement to Postgres. Memoised — statements repeat. */
export function toPostgres(sql: string): string {
  const hit = cache.get(sql);
  if (hit !== undefined) return hit;
  const out = rewritePlaceholders(rewriteInsertOrIgnore(sql));
  cache.set(sql, out);
  return out;
}

/** Highest `$n` in a translated statement — used to size the bound array. */
export function parameterCount(translated: string): number {
  let max = 0;
  for (const span of scan(translated)) {
    if (!span.code) continue;
    for (const m of span.text.matchAll(/\$([0-9]+)/g)) {
      max = Math.max(max, Number(m[1]));
    }
  }
  return max;
}

export interface ParameterPlan {
  /** SQL with parameters renumbered to a gapless $1..$n. */
  sql: string;
  /** Original 1-based positions, in their new order. */
  keep: number[];
}

/**
 * Removes gaps in the parameter numbering.
 *
 * The hub builds several statements by concatenating optional fragments, so a
 * query can bind three values while referencing only `?1` and `?3` — the
 * fragment that would have used `?2` was omitted. SQLite ignores a bound
 * parameter nothing refers to. Postgres cannot: it has to infer a type for
 * every `$n` up to the highest one used, and an unreferenced `$2` has no
 * context to infer from, so the whole statement fails with "could not
 * determine data type of parameter $2".
 *
 * Renumbering to a gapless sequence and dropping the matching values
 * reproduces SQLite's behaviour exactly, in one place, rather than editing
 * every conditional query.
 */
export function compactParameters(translated: string): ParameterPlan {
  const used = new Set<number>();
  for (const span of scan(translated)) {
    if (!span.code) continue;
    for (const m of span.text.matchAll(/\$([0-9]+)/g)) used.add(Number(m[1]));
  }
  const keep = [...used].sort((a, b) => a - b);
  // Already gapless and in order — the common case, so do no work.
  if (keep.every((n, i) => n === i + 1)) return { sql: translated, keep };

  const renumber = new Map(keep.map((old, i) => [old, i + 1]));
  const sql = mapCode(translated, (code) =>
    code.replace(/\$([0-9]+)/g, (_, n: string) => `$${renumber.get(Number(n)) ?? n}`),
  );
  return { sql, keep };
}
