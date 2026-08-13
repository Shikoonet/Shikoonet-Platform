/**
 * Banks — the two things about a bank this system has to get right, and a place
 * to try a change before trusting it.
 *
 * Card prefixes say which bank issued a card number. SMS patterns say which
 * bank sent a message when the built-in parsers no longer recognise it. Both
 * used to require a deploy to change; the head admin asked on 2026-08-13 for
 * both to be editable here, with somewhere to test by hand.
 *
 * The test boxes call the same endpoints ingest uses, so what they show is what
 * a real message would produce. Nothing pasted into the SMS box comes back in
 * the response — an operator will paste a one-time password in there sooner or
 * later, and it stops at the server.
 */

import { useEffect, useState } from 'react';

interface PrefixRow {
  prefix: string;
  bank_name: string;
  updated_at: number;
  updated_by: string | null;
}

interface PatternRow {
  id: string;
  bank_name: string;
  enabled: boolean;
  priority: number;
  detect_re: string;
  amount_re: string;
  amount_unit: 'IRR' | 'TOMAN';
  direction: 'CREDIT' | 'DEBIT';
  balance_re: string | null;
  account_re: string | null;
  notes: string | null;
  updated_by: string | null;
}

interface CardTestResult {
  normalized: string | null;
  display?: string;
  luhnOk?: boolean;
  matchedPrefix?: string | null;
  bankName?: string | null;
  message?: string;
}

interface SmsTestResult {
  matched: boolean;
  classification: string;
  direction: string;
  amountIrr: number | null;
  balanceIrr: number | null;
  accountHint: string | null;
  parserId: string | null;
  bankName: string | null;
  fromPattern: string | null;
  confidence: number;
  warnings: string[];
}

const EMPTY_PATTERN: PatternRow = {
  id: '',
  bank_name: '',
  enabled: false,
  priority: 100,
  detect_re: '',
  amount_re: '',
  amount_unit: 'IRR',
  direction: 'CREDIT',
  balance_re: null,
  account_re: null,
  notes: null,
  updated_by: null,
};

async function readJson<T>(r: Response): Promise<T & { error?: string; problems?: string[] }> {
  return (await r.json().catch(() => ({}))) as T & { error?: string; problems?: string[] };
}

export function BanksView() {
  return (
    <div className="banks-view">
      <CardPrefixesPanel />
      <SmsPatternsPanel />
    </div>
  );
}

function CardPrefixesPanel() {
  const [rows, setRows] = useState<PrefixRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prefix, setPrefix] = useState('');
  const [bankName, setBankName] = useState('');
  const [cardInput, setCardInput] = useState('');
  const [test, setTest] = useState<CardTestResult | null>(null);

  async function load() {
    const r = await fetch('/api/v1/banks/prefixes');
    if (!r.ok) {
      setErr(`Could not load prefixes (${r.status})`);
      return;
    }
    setRows((await readJson<{ items: PrefixRow[] }>(r)).items ?? []);
  }

  useEffect(() => {
    void load();
  }, []);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/v1/banks/prefixes/${prefix}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prefix, bankName }),
      });
      const j = await readJson(r);
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setPrefix('');
      setBankName('');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: string) {
    setBusy(true);
    const r = await fetch(`/api/v1/banks/prefixes/${p}`, { method: 'DELETE' });
    if (!r.ok) setErr(`Delete failed (${r.status})`);
    await load();
    setBusy(false);
  }

  async function runTest() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/v1/banks/test-card', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cardNumber: cardInput }),
      });
      const j = await readJson<CardTestResult>(r);
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setTest(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="banks-panel">
      <h3>Card number prefixes</h3>
      <p className="muted">
        The first six digits of a card name the bank that issued it. Longest matching prefix wins, so
        a bank that splits a range later needs one more row here and no code change.
      </p>
      {err && <div className="error">{err}</div>}

      <div className="banks-test">
        <h4>Try a card number</h4>
        <div className="row toolbar">
          <input
            placeholder="5054-1617-0627-7062"
            value={cardInput}
            onChange={(e) => setCardInput(e.target.value)}
            aria-label="Card number to test"
          />
          <button type="button" disabled={busy || !cardInput.trim()} onClick={() => void runTest()}>
            Test
          </button>
        </div>
        {test &&
          (test.normalized === null ? (
            <p className="muted">{test.message}</p>
          ) : (
            <dl className="banks-test__result">
              <dt>Number</dt>
              <dd>{test.display}</dd>
              <dt>Check digit</dt>
              <dd>
                {test.luhnOk ? (
                  'valid'
                ) : (
                  <span className="badge badge-danger">fails — this cannot be a real card</span>
                )}
              </dd>
              <dt>Prefix</dt>
              <dd>{test.matchedPrefix ?? 'no row matches'}</dd>
              <dt>Bank</dt>
              <dd>{test.bankName ?? 'unknown to this table'}</dd>
            </dl>
          ))}
      </div>

      <div className="table-wrap">
        <table className="banks-table">
          <thead>
            <tr>
              <th scope="col">Prefix</th>
              <th scope="col">Bank</th>
              <th scope="col">Last changed by</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.prefix}>
                <td>{r.prefix}</td>
                <td>{r.bank_name}</td>
                <td className="muted">{r.updated_by ?? '—'}</td>
                <td>
                  <button
                    type="button"
                    className="btn-sm"
                    disabled={busy}
                    onClick={() => void remove(r.prefix)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="row toolbar">
        <input
          placeholder="Prefix (4–8 digits)"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value.replace(/\D/g, '').slice(0, 8))}
          aria-label="Prefix"
        />
        <input
          placeholder="Bank name"
          value={bankName}
          onChange={(e) => setBankName(e.target.value)}
          aria-label="Bank name"
        />
        <button
          type="button"
          disabled={busy || prefix.length < 4 || !bankName.trim()}
          onClick={() => void save()}
        >
          Add or update
        </button>
      </div>
    </section>
  );
}

function SmsPatternsPanel() {
  const [rows, setRows] = useState<PatternRow[]>([]);
  const [draft, setDraft] = useState<PatternRow>(EMPTY_PATTERN);
  const [err, setErr] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [smsInput, setSmsInput] = useState('');
  const [test, setTest] = useState<SmsTestResult | null>(null);

  async function load() {
    const r = await fetch('/api/v1/banks/sms-patterns');
    if (!r.ok) {
      setErr(`Could not load patterns (${r.status})`);
      return;
    }
    setRows((await readJson<{ items: PatternRow[] }>(r)).items ?? []);
  }

  useEffect(() => {
    void load();
  }, []);

  async function save() {
    setBusy(true);
    setErr(null);
    setProblems([]);
    try {
      const r = await fetch(`/api/v1/banks/sms-patterns/${draft.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: draft.id,
          bankName: draft.bank_name,
          enabled: draft.enabled,
          priority: draft.priority,
          detectRe: draft.detect_re,
          amountRe: draft.amount_re,
          amountUnit: draft.amount_unit,
          direction: draft.direction,
          balanceRe: draft.balance_re || null,
          accountRe: draft.account_re || null,
          notes: draft.notes || null,
        }),
      });
      const j = await readJson(r);
      if (!r.ok) {
        setProblems(j.problems ?? []);
        throw new Error(j.error ?? `${r.status}`);
      }
      setDraft(EMPTY_PATTERN);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    const r = await fetch(`/api/v1/banks/sms-patterns/${id}`, { method: 'DELETE' });
    if (!r.ok) setErr(`Delete failed (${r.status})`);
    await load();
    setBusy(false);
  }

  async function runTest() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/v1/banks/test-sms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: smsInput }),
      });
      const j = await readJson<SmsTestResult>(r);
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setTest(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="banks-panel">
      <h3>Bank SMS patterns</h3>
      <p className="muted">
        These only run where the built-in parsers named no bank. They can add a bank name, or read a
        message nothing else understood — they can never change an amount a built-in already read,
        and they never see a one-time password. Use them when a bank changes the wording of its SMS.
      </p>
      {err && <div className="error">{err}</div>}
      {problems.length > 0 && (
        <ul className="error">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="banks-test">
        <h4>Try a message</h4>
        <p className="muted">
          Runs the real pipeline, including every enabled pattern below. The text is not stored, not
          logged, and not sent back.
        </p>
        <textarea
          rows={6}
          placeholder={'بانک نمونه\nواریز مبلغ 1,000,000 ریال\nحساب: 0201234567001\nمانده: 5,000,000'}
          value={smsInput}
          onChange={(e) => setSmsInput(e.target.value)}
          aria-label="SMS text to test"
        />
        <div className="row toolbar">
          <button type="button" disabled={busy || !smsInput.trim()} onClick={() => void runTest()}>
            Test
          </button>
        </div>
        {test && (
          <dl className="banks-test__result">
            <dt>Read as</dt>
            <dd>
              {test.classification}
              {test.matched ? '' : ' (not matched)'}
            </dd>
            <dt>Parser</dt>
            <dd>
              {test.parserId ?? '—'}
              {test.fromPattern && <span className="badge">from pattern {test.fromPattern}</span>}
            </dd>
            <dt>Bank</dt>
            <dd>{test.bankName ?? '—'}</dd>
            <dt>Amount (IRR)</dt>
            <dd>{test.amountIrr === null ? '—' : test.amountIrr.toLocaleString('en-US')}</dd>
            <dt>Balance (IRR)</dt>
            <dd>{test.balanceIrr === null ? '—' : test.balanceIrr.toLocaleString('en-US')}</dd>
            <dt>Direction</dt>
            <dd>{test.direction}</dd>
            <dt>Account hint</dt>
            <dd>{test.accountHint ?? '—'}</dd>
            <dt>Warnings</dt>
            <dd>{test.warnings.length === 0 ? '—' : test.warnings.join(', ')}</dd>
          </dl>
        )}
      </div>

      <div className="table-wrap">
        <table className="banks-table">
          <thead>
            <tr>
              <th scope="col">Id</th>
              <th scope="col">Bank</th>
              <th scope="col">On</th>
              <th scope="col">Order</th>
              <th scope="col">Detects</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No patterns yet. Everything is handled by the built-in parsers.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td>{r.bank_name}</td>
                <td>{r.enabled ? 'yes' : <span className="muted">draft</span>}</td>
                <td>{r.priority}</td>
                <td>
                  <code>{r.detect_re}</code>
                </td>
                <td>
                  <button type="button" className="btn-sm" disabled={busy} onClick={() => setDraft(r)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn-sm"
                    disabled={busy}
                    onClick={() => void remove(r.id)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h4>{rows.some((r) => r.id === draft.id) ? `Editing ${draft.id}` : 'New pattern'}</h4>
      <div className="banks-form">
        <label>
          Id
          <input
            value={draft.id}
            onChange={(e) => setDraft({ ...draft, id: e.target.value })}
            placeholder="ayandeh-v1"
          />
        </label>
        <label>
          Bank
          <input
            value={draft.bank_name}
            onChange={(e) => setDraft({ ...draft, bank_name: e.target.value })}
            placeholder="AYANDEH"
          />
        </label>
        <label>
          Order
          <input
            type="number"
            value={draft.priority}
            onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })}
          />
        </label>
        <label>
          Amount is in
          <select
            value={draft.amount_unit}
            onChange={(e) =>
              setDraft({ ...draft, amount_unit: e.target.value as PatternRow['amount_unit'] })
            }
          >
            <option value="IRR">Rial</option>
            <option value="TOMAN">Toman (×10)</option>
          </select>
        </label>
        <label>
          Direction
          <select
            value={draft.direction}
            onChange={(e) =>
              setDraft({ ...draft, direction: e.target.value as PatternRow['direction'] })
            }
          >
            <option value="CREDIT">Money in</option>
            <option value="DEBIT">Money out</option>
          </select>
        </label>
        <label className="banks-form__wide">
          Detect (claims the message)
          <input
            value={draft.detect_re}
            onChange={(e) => setDraft({ ...draft, detect_re: e.target.value })}
            placeholder="بانک\s*آینده"
          />
        </label>
        <label className="banks-form__wide">
          Amount — group 1 is the digits
          <input
            value={draft.amount_re}
            onChange={(e) => setDraft({ ...draft, amount_re: e.target.value })}
            placeholder="^مبلغ\s*:\s*([\d,]+)"
          />
        </label>
        <label className="banks-form__wide">
          Balance (optional)
          <input
            value={draft.balance_re ?? ''}
            onChange={(e) => setDraft({ ...draft, balance_re: e.target.value })}
          />
        </label>
        <label className="banks-form__wide">
          Account (optional)
          <input
            value={draft.account_re ?? ''}
            onChange={(e) => setDraft({ ...draft, account_re: e.target.value })}
          />
        </label>
        <label className="banks-form__wide">
          Notes
          <input
            value={draft.notes ?? ''}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          />
        </label>
        <label className="banks-form__check">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />
          Live — leave off to save a draft
        </label>
      </div>
      <div className="row toolbar">
        <button
          type="button"
          disabled={busy || !draft.id.trim() || !draft.bank_name.trim() || !draft.amount_re.trim()}
          onClick={() => void save()}
        >
          Save pattern
        </button>
        <button type="button" className="btn-sm" onClick={() => setDraft(EMPTY_PATTERN)}>
          Clear
        </button>
      </div>
    </section>
  );
}
