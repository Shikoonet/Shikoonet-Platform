/**
 * Reading a support-answer dataset file for «وارد کردن از فایل».
 *
 * Two shapes are accepted, one JSON object per line or one JSON array:
 *
 *  - the support-chat reader's own `faq.jsonl` record, `{ entry: { id,
 *    question, answer, variants[], category, needs_human, human_reason,
 *    volatile_values[] } }` — what `.notes/support-kb/` holds;
 *  - a plain row, `{ sourceKey, question, answer, variants?, category?,
 *    handOff?, note? }`.
 *
 * Nothing here decides what the bot says; the server validates every field
 * again. What this does decide is the note an admin reviews by: why a person
 * is needed, and which values in the answer go out of date.
 */
import type { SupportAnswerImportItem } from './api.js';

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

interface FaqEntry {
  id?: unknown;
  question?: unknown;
  answer?: unknown;
  variants?: unknown;
  category?: unknown;
  needs_human?: unknown;
  human_reason?: unknown;
  volatile_values?: unknown;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

function fromEntry(e: FaqEntry): SupportAnswerImportItem {
  const volatile = Array.isArray(e.volatile_values)
    ? e.volatile_values.map((v) => str((v as { value?: unknown })?.value)).filter(Boolean)
    : [];
  const note = [
    str(e.human_reason) && `چرا همکار: ${str(e.human_reason)}`,
    volatile.length > 0 && `مقدارهای متغیر: ${volatile.join(' | ')}`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    sourceKey: str(e.id),
    question: cut(str(e.question), 300),
    answer: cut(str(e.answer), 1500),
    variants: cut(
      Array.isArray(e.variants) ? e.variants.map(str).filter(Boolean).join('\n') : '',
      4000,
    ),
    category: cut(str(e.category), 60),
    handOff: e.needs_human === true,
    note: cut(note, 1000),
  };
}

function fromAny(o: unknown): SupportAnswerImportItem {
  const rec = (o ?? {}) as { entry?: FaqEntry } & Partial<SupportAnswerImportItem>;
  if (rec.entry && typeof rec.entry === 'object') return fromEntry(rec.entry);
  return {
    sourceKey: str(rec.sourceKey),
    question: str(rec.question),
    answer: str(rec.answer),
    variants: typeof rec.variants === 'string' ? rec.variants : '',
    category: str(rec.category),
    handOff: rec.handOff === true,
    note: typeof rec.note === 'string' ? rec.note : '',
  };
}

/** The file's rows, or a Persian sentence naming the first line that is not one. */
export function parseAnswerFile(
  text: string,
): { ok: true; items: SupportAnswerImportItem[] } | { ok: false; error: string } {
  const body = text.replace(/^﻿/, '').trim();
  if (body === '') return { ok: false, error: 'فایل خالی است.' };
  let records: unknown[];
  try {
    records = body.startsWith('[')
      ? (JSON.parse(body) as unknown[])
      : body
          .split(/\r?\n/)
          .filter((l) => l.trim() !== '')
          .map((l, i) => {
            try {
              return JSON.parse(l) as unknown;
            } catch {
              throw new Error(`خط ${i + 1} JSON درستی نیست.`);
            }
          });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const items = records.map(fromAny);
  const bad = items.findIndex((it) => !it.sourceKey || !it.question || !it.answer);
  if (bad >= 0) {
    return { ok: false, error: `ردیف ${bad + 1} شناسه، پرسش یا جواب ندارد.` };
  }
  return { ok: true, items };
}
