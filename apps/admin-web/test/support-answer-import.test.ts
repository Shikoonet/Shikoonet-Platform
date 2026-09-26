/**
 * «وارد کردن از فایل» reads the support-chat reader's own records, so the file
 * that comes out of the pipeline goes into the panel unchanged. What an admin
 * reviews by — why a person is needed, which values go out of date — comes
 * from the record, not from anyone retyping it.
 */
import { describe, expect, it } from 'vitest';
import { parseAnswerFile } from '../src/supportAnswerImport.js';

const faqLine = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id,
    text: 'for embedding',
    metadata: {},
    entry: {
      id,
      category: 'payment_receipt',
      question: 'واریز کردم ولی سرویس نیومد',
      answer: 'کد پیگیری را بفرستید.',
      variants: ['پول ریختم نیومد', '  ', 'رسید دادم ولی خبری نشد'],
      needs_human: true,
      human_reason: 'واریزی باید در حساب پیدا شود.',
      volatile_values: [{ value: 'تأیید معمولاً چند دقیقه', last_seen: '2026-09-25' }],
      ...extra,
    },
  });

describe('reading a support-answer file', () => {
  it('takes the reader’s own records, one per line', () => {
    const got = parseAnswerFile(`﻿${faqLine('payment_receipt-01')}\r\n\r\n${faqLine('x-2', { needs_human: false, human_reason: '', volatile_values: [] })}\n`);
    expect(got).toEqual({
      ok: true,
      items: [
        {
          sourceKey: 'payment_receipt-01',
          question: 'واریز کردم ولی سرویس نیومد',
          answer: 'کد پیگیری را بفرستید.',
          variants: 'پول ریختم نیومد\nرسید دادم ولی خبری نشد',
          category: 'payment_receipt',
          handOff: true,
          note: 'چرا همکار: واریزی باید در حساب پیدا شود.\nمقدارهای متغیر: تأیید معمولاً چند دقیقه',
        },
        expect.objectContaining({ sourceKey: 'x-2', handOff: false, note: '' }),
      ],
    });
  });

  it('takes plain rows as a JSON array', () => {
    const got = parseAnswerFile(
      JSON.stringify([{ sourceKey: 'k1', question: 'س', answer: 'ج', handOff: true }]),
    );
    expect(got).toEqual({
      ok: true,
      items: [{ sourceKey: 'k1', question: 'س', answer: 'ج', variants: '', category: '', handOff: true, note: '' }],
    });
  });

  it('names the line that is not JSON, and the row that lacks a field', () => {
    expect(parseAnswerFile(`${faqLine('a')}\n{oops`)).toEqual({ ok: false, error: 'خط 2 JSON درستی نیست.' });
    expect(parseAnswerFile(faqLine('b', { answer: '' }))).toEqual({
      ok: false,
      error: 'ردیف 1 شناسه، پرسش یا جواب ندارد.',
    });
    expect(parseAnswerFile('  ')).toEqual({ ok: false, error: 'فایل خالی است.' });
  });
});
