import type { EnvName } from '@shikoo/contracts';
/**
 * Banks: which one issued a card number, and which one sent an SMS.
 *
 * Both answers used to be untouchable without a deploy — card issuers were not
 * derived at all, and every bank's SMS layout was a regex compiled into the
 * bundle. The head admin asked on 2026-08-13 for both to be editable, with
 * somewhere to try a change before trusting it. That is what these routes are.
 *
 * Two rules run through the whole file:
 *
 *   Reading is open to any signed-in operator; changing is ADMIN only, and
 *   every change writes an `audit_logs` row. These tables decide how money is
 *   read out of an SMS, so "who changed this and when" has to survive.
 *
 *   The SMS test box never echoes what was pasted into it and never logs it.
 *   Somebody will paste a one-time password in there eventually — `parseSms`
 *   redacts it, and this endpoint must not undo that by handing the body back.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import {
  identifyBank,
  loadBankSmsPatterns,
  luhnOk,
  normalizeCardDigits,
  formatCardDigitsForDisplay,
  type BankPrefix,
} from '@shikoo/domain';
import {
  compilePatterns,
  compilePatternSource,
  normalizeText,
  parseSms,
  validatePattern,
} from '@shikoo/sms-parser';
import type { BankSmsPatternRow } from '@shikoo/sms-parser';

type Ident = { email: string; role: import('@shikoo/contracts').AccessRole };

/**
 * Bodies a pattern is run against before it is allowed to go live, and the
 * budget it has to finish them in.
 *
 * This is the real gate on a catastrophically backtracking regex. JavaScript
 * cannot interrupt a running match, so there is no timeout to fall back on at
 * ingest time — the only place to catch `(a+)+$` is before it is stored with
 * `enabled` set.
 *
 * Probe length is the whole trick, and both obvious choices are wrong.
 *
 * The first version used 2000 characters, on the theory that more input catches
 * a bad pattern more easily. It does the opposite: `^(a+)+$` on 2000 characters
 * is 2^2000 steps, so the check never returned and the validation request hung
 * the very server it was meant to protect. Shortening it to 20 then let
 * `^(a+)+$` through — 2^20 is only about 10ms, comfortably inside the budget.
 *
 * Measured on this machine, `^(a+)+$`, `^(a|a)+$` and `^(a*)*b` cost:
 *
 *     n=24   90–150 ms      n=26   370–580 ms      n=28   1.5–2.3 s
 *
 * So 26 it is: an exponential pattern lands several times over a 100ms budget
 * and is caught, the worst case still returns in under a second, and a sane
 * pattern finishes 26 characters in microseconds. The gap is four orders of
 * magnitude, so the threshold does not need to be precise.
 *
 * Each bait is a single repeated character, because an unbroken run is what
 * makes a nested quantifier blow up — and it keeps the bound the same whatever
 * alphabet the pattern is written in.
 *
 * ponytail: a wall-clock budget on short input, not an analysis of the pattern.
 * It catches exponential blowup, which is the shape that takes a service down.
 * A merely slow linear pattern gets through; if one ever does, the ingest loop
 * reports and skips the row rather than dying.
 */
const BAIT = 26;
const REDOS_PROBES = [
  'بانک نمونه\nمبلغ: 1,000,000 ریال\nحساب: 0201234567001\nمانده: 5,000,000',
  'کد تایید: 123456',
  `${'a'.repeat(BAIT)}!`,
  `${'1'.repeat(BAIT)}x`,
  `${'و'.repeat(BAIT)}!`,
];
const REDOS_BUDGET_MS = 100;

/**
 * Exported for `test/bankRoutes.test.ts` — this gate has already failed twice.
 *
 * Every field is probed on its own rather than by running the parser. Going
 * through `supports()` was the second bug: it is
 * `detect.test(text) && amount.test(text)`, so a catastrophic amount pattern
 * behind a detector that does not match the bait was never executed and sailed
 * through. At ingest it would run, on any message the detector did match.
 */
export function overBudget(row: BankSmsPatternRow): boolean {
  const sources = [row.detectRe, row.amountRe, row.balanceRe, row.accountRe].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  for (const source of sources) {
    const re = compilePatternSource(source);
    if (!re) continue; // it did not compile; validatePattern already said so
    const started = performance.now();
    for (const probe of REDOS_PROBES) {
      try {
        re.test(probe);
      } catch {
        return true;
      }
    }
    if (performance.now() - started > REDOS_BUDGET_MS) return true;
  }
  return false;
}

async function loadPrefixes(db: D1Database): Promise<BankPrefix[]> {
  const rows = await db
    .prepare(`SELECT prefix, bank_name FROM bank_card_prefixes ORDER BY prefix`)
    .all<{ prefix: string; bank_name: string }>();
  return (rows.results ?? []).map((r) => ({ prefix: r.prefix, bankName: r.bank_name }));
}

async function audit(
  db: D1Database,
  ident: Ident,
  action: string,
  entityType: string,
  entityId: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_logs
         (id, actor_email, actor_role, action, entity_type, entity_id,
          before_json, after_json, reason, request_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL, ?9)`,
    )
    .bind(
      crypto.randomUUID(),
      ident.email,
      ident.role,
      action,
      entityType,
      entityId,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      Date.now(),
    )
    .run();
}

const PrefixBody = z
  .object({
    prefix: z.string().regex(/^[0-9]{4,8}$/, 'prefix must be 4 to 8 digits'),
    bankName: z.string().trim().min(1).max(64),
  })
  .strict();

const PatternBody = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    bankName: z.string().trim().min(1).max(64),
    enabled: z.boolean(),
    priority: z.number().int().min(0).max(10_000),
    detectRe: z.string().min(1).max(500),
    amountRe: z.string().min(1).max(500),
    amountUnit: z.enum(['IRR', 'TOMAN']),
    direction: z.enum(['CREDIT', 'DEBIT']),
    balanceRe: z.string().max(500).nullable(),
    accountRe: z.string().max(500).nullable(),
    notes: z.string().max(2000).nullable(),
  })
  .strict();

export function registerBankRoutes(
  app: Hono<{ Bindings: { DB: D1Database; ENV_NAME: EnvName }; Variables: { identity: Ident } }>,
) {
  // --- card prefixes ------------------------------------------------------

  app.get('/api/v1/banks/prefixes', async (c) => {
    const rows = await c.env.DB.prepare(
      `SELECT prefix, bank_name, updated_at, updated_by
         FROM bank_card_prefixes ORDER BY bank_name, prefix`,
    ).all<{ prefix: string; bank_name: string; updated_at: number; updated_by: string | null }>();
    return c.json({ ok: true, items: rows.results ?? [] });
  });

  app.put('/api/v1/banks/prefixes/:prefix', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const parsed = PrefixBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    if (parsed.data.prefix !== c.req.param('prefix')) {
      return c.json({ ok: false, error: 'prefix_mismatch' }, 400);
    }
    const before = await c.env.DB.prepare(
      `SELECT prefix, bank_name FROM bank_card_prefixes WHERE prefix = ?1`,
    )
      .bind(parsed.data.prefix)
      .first<{ prefix: string; bank_name: string }>();

    await c.env.DB.prepare(
      `INSERT INTO bank_card_prefixes (prefix, bank_name, updated_at, updated_by)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (prefix) DO UPDATE
         SET bank_name = EXCLUDED.bank_name,
             updated_at = EXCLUDED.updated_at,
             updated_by = EXCLUDED.updated_by`,
    )
      .bind(parsed.data.prefix, parsed.data.bankName, Date.now(), ident.email)
      .run();
    await audit(
      c.env.DB,
      ident,
      before ? 'bank_prefix.updated' : 'bank_prefix.created',
      'BANK_PREFIX',
      parsed.data.prefix,
      before,
      { prefix: parsed.data.prefix, bank_name: parsed.data.bankName },
    );
    return c.json({ ok: true });
  });

  app.delete('/api/v1/banks/prefixes/:prefix', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const prefix = c.req.param('prefix');
    const before = await c.env.DB.prepare(
      `SELECT prefix, bank_name FROM bank_card_prefixes WHERE prefix = ?1`,
    )
      .bind(prefix)
      .first<{ prefix: string; bank_name: string }>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);
    await c.env.DB.prepare(`DELETE FROM bank_card_prefixes WHERE prefix = ?1`).bind(prefix).run();
    await audit(c.env.DB, ident, 'bank_prefix.deleted', 'BANK_PREFIX', prefix, before, null);
    return c.json({ ok: true });
  });

  // --- SMS patterns -------------------------------------------------------

  app.get('/api/v1/banks/sms-patterns', async (c) => {
    const rows = await c.env.DB.prepare(
      `SELECT id, bank_name, enabled, priority, detect_re, amount_re, amount_unit,
              direction, balance_re, account_re, notes, updated_at, updated_by
         FROM bank_sms_patterns ORDER BY priority, id`,
    ).all();
    return c.json({ ok: true, items: rows.results ?? [] });
  });

  app.put('/api/v1/banks/sms-patterns/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const parsed = PatternBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    if (parsed.data.id !== c.req.param('id')) {
      return c.json({ ok: false, error: 'id_mismatch' }, 400);
    }
    const row: BankSmsPatternRow = {
      id: parsed.data.id,
      bankName: parsed.data.bankName,
      priority: parsed.data.priority,
      detectRe: parsed.data.detectRe,
      amountRe: parsed.data.amountRe,
      amountUnit: parsed.data.amountUnit,
      direction: parsed.data.direction,
      balanceRe: parsed.data.balanceRe,
      accountRe: parsed.data.accountRe,
    };

    const problems = validatePattern(row);
    if (problems.length > 0) return c.json({ ok: false, error: 'invalid_pattern', problems }, 400);
    // A broken pattern is only allowed to exist while it is switched off, so an
    // operator can save a draft. Turning it on is what has to be earned.
    if (parsed.data.enabled && overBudget(row)) {
      return c.json(
        {
          ok: false,
          error: 'pattern_too_slow',
          problems: [
            'This pattern took too long on test input and could stall SMS ingestion. Avoid nested repetition like (a+)+.',
          ],
        },
        400,
      );
    }

    const before = await c.env.DB.prepare(
      `SELECT id, bank_name, enabled, priority, detect_re, amount_re, amount_unit,
              direction, balance_re, account_re, notes
         FROM bank_sms_patterns WHERE id = ?1`,
    )
      .bind(parsed.data.id)
      .first();

    await c.env.DB.prepare(
      `INSERT INTO bank_sms_patterns
         (id, bank_name, enabled, priority, detect_re, amount_re, amount_unit,
          direction, balance_re, account_re, notes, updated_at, updated_by)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
       ON CONFLICT (id) DO UPDATE
         SET bank_name = EXCLUDED.bank_name, enabled = EXCLUDED.enabled,
             priority = EXCLUDED.priority, detect_re = EXCLUDED.detect_re,
             amount_re = EXCLUDED.amount_re, amount_unit = EXCLUDED.amount_unit,
             direction = EXCLUDED.direction, balance_re = EXCLUDED.balance_re,
             account_re = EXCLUDED.account_re, notes = EXCLUDED.notes,
             updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
    )
      .bind(
        row.id,
        row.bankName,
        parsed.data.enabled,
        row.priority,
        row.detectRe,
        row.amountRe,
        row.amountUnit,
        row.direction,
        row.balanceRe,
        row.accountRe,
        parsed.data.notes,
        Date.now(),
        ident.email,
      )
      .run();
    await audit(
      c.env.DB,
      ident,
      before ? 'bank_sms_pattern.updated' : 'bank_sms_pattern.created',
      'BANK_SMS_PATTERN',
      row.id,
      before,
      { ...row, enabled: parsed.data.enabled, notes: parsed.data.notes },
    );
    return c.json({ ok: true });
  });

  app.delete('/api/v1/banks/sms-patterns/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const id = c.req.param('id');
    const before = await c.env.DB.prepare(`SELECT * FROM bank_sms_patterns WHERE id = ?1`)
      .bind(id)
      .first();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);
    await c.env.DB.prepare(`DELETE FROM bank_sms_patterns WHERE id = ?1`).bind(id).run();
    await audit(c.env.DB, ident, 'bank_sms_pattern.deleted', 'BANK_SMS_PATTERN', id, before, null);
    return c.json({ ok: true });
  });

  // --- the two test boxes -------------------------------------------------

  const TestCardBody = z.object({ cardNumber: z.string().min(1).max(64) }).strict();
  app.post('/api/v1/banks/test-card', async (c) => {
    const parsed = TestCardBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const digits = normalizeCardDigits(parsed.data.cardNumber);
    if (!digits) {
      return c.json({
        ok: true,
        normalized: null,
        message: 'Not 16 digits. Persian and Arabic digits, spaces and dashes are all fine.',
      });
    }
    const prefixes = await loadPrefixes(c.env.DB);
    const bankName = identifyBank(digits, prefixes);
    const matched = prefixes
      .filter((p) => digits.startsWith(p.prefix))
      .sort((a, b) => b.prefix.length - a.prefix.length)[0];
    return c.json({
      ok: true,
      normalized: digits,
      display: formatCardDigitsForDisplay(digits),
      luhnOk: luhnOk(digits),
      matchedPrefix: matched?.prefix ?? null,
      bankName,
    });
  });

  const TestSmsBody = z.object({ text: z.string().min(1).max(4000) }).strict();
  app.post('/api/v1/banks/test-sms', async (c) => {
    const parsed = TestSmsBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);

    // Exactly what ingest does, in the same order, with the same patterns. A
    // test box that runs a different pipeline is a test box that lies.
    const text = normalizeText(parsed.data.text).text;
    const { parsers, skipped } = compilePatterns(await loadBankSmsPatterns(c.env.DB));
    const result = parseSms(
      { raw: parsed.data.text, text, sender: 'TEST', timestamp: Date.now(), deviceId: 'dashboard' },
      parsers,
    );

    // The pasted text does not come back and is not logged. If it was an OTP,
    // `parseSms` has already classified it as one and the body stops here.
    return c.json({
      ok: true,
      matched: result.matched,
      classification: result.classification,
      direction: result.direction,
      amountIrr: result.amountIrr,
      balanceIrr: result.balanceIrr,
      accountHint: result.classification === 'OTP' ? null : result.accountHint,
      parserId: result.parserId,
      bankName: result.evidence['bank'] ?? null,
      fromPattern: result.evidence['bankFromPattern'] ?? null,
      confidence: result.confidence,
      warnings: result.warnings,
      skippedPatterns: skipped,
    });
  });
}
