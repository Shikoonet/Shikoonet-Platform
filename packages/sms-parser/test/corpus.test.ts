/**
 * Every shape in `corpus/` must be read by a NAMED parser — not guessed at by
 * a generic one, not left with no direction. See `corpus/README.md` for the
 * loop this test closes. A block is `# <sender> — <label>` then the body.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSms } from '../src/parsers/registry.js';
import { normalizeText } from '../src/normalize.js';

const DIR = join(__dirname, 'corpus');
// Any instant of the corpus month; the parsers fall back to the phone clock
// only when the bank's own is more than two days off, and that is asserted
// separately in each bank's test.
const AT = Date.UTC(2026, 8, 18, 12, 0, 0);

interface Block {
  file: string;
  sender: string;
  label: string;
  body: string;
}

function blocks(): Block[] {
  const out: Block[] = [];
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.txt'))) {
    const text = readFileSync(join(DIR, file), 'utf8').replace(/\r\n/g, '\n');
    for (const chunk of text.split(/\n{2,}/)) {
      const lines = chunk.split('\n').filter((l, i) => i === 0 || l.length > 0);
      if (lines.length < 2 || !lines[0]!.startsWith('#')) continue;
      const m = lines[0]!.match(/^#\s*(.+?)\s+—\s+(.+)$/);
      if (!m) throw new Error(`${file}: bad header «${lines[0]}»`);
      out.push({ file, sender: m[1]!, label: m[2]!, body: lines.slice(1).join('\n') });
    }
  }
  return out;
}

describe('corpus', () => {
  const all = blocks();
  it('has something in it', () => {
    expect(all.length).toBeGreaterThan(10);
  });
  for (const b of all) {
    it(`${b.sender} — ${b.label} is read by a named parser`, () => {
      const text = normalizeText(b.body).text;
      const r = parseSms({ raw: b.body, text, sender: b.sender, timestamp: AT, deviceId: 'corpus' });
      expect(r.parserId, 'a generic parser guessed at this').not.toMatch(/^generic-|^fallback-/);
      expect(r.classification).toBe('BANK_TRANSACTION');
      expect(['CREDIT', 'DEBIT']).toContain(r.direction);
      expect(r.amountIrr).toBeGreaterThan(0);
      expect(r.balanceIrr, 'a bank text with «مانده» must yield its balance').not.toBeNull();
    });
  }
});
