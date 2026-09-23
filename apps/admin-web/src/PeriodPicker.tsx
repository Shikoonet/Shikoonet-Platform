/**
 * A whole Jalali period — a month, a quarter, a half or a year — picked by
 * name rather than typed as two dates.
 *
 * Sam, 1 Mehr 1405: «می‌خوام درآمد و هزینه و سود رو توی ماه مهر ببینم یا شهریور
 * یا آبان. یه سه‌ماهه و ۶ ماهه و سالیانه». «بازهٔ دلخواه» could already reach
 * every one of those, one day-field at a time; this names them. It produces
 * the same first and last day the date fields would, so the server sees an
 * ordinary `between` and nothing below the page had to learn a new window.
 *
 * The quarters are the seasons (بهار = فروردین–خرداد), the halves are the
 * calendar's own (the first six months have 31 days, the last six 30 or 29).
 */

import { JALALI_MONTHS, jalaliMonthLength, toJalali, type JalaliDate } from '@shikoo/contracts';

export type PeriodKind = 'month' | 'quarter' | 'half' | 'year';

export interface Period {
  kind: PeriodKind;
  year: number;
  /** Month 1–12, quarter 1–4, half 1–2; ignored for a year. */
  index: number;
}

const KINDS: Array<{ id: PeriodKind; label: string }> = [
  { id: 'month', label: 'ماه' },
  { id: 'quarter', label: 'سه‌ماهه' },
  { id: 'half', label: 'شش‌ماهه' },
  { id: 'year', label: 'سال' },
];

const QUARTERS = ['بهار', 'تابستان', 'پاییز', 'زمستان'];
const HALVES = ['نیمهٔ اول', 'نیمهٔ دوم'];
const SPAN: Record<PeriodKind, number> = { month: 1, quarter: 3, half: 6, year: 12 };

/** The period this instant falls in. */
export function currentPeriod(kind: PeriodKind = 'month', nowMs = Date.now()): Period {
  const j = toJalali(nowMs);
  return { kind, year: j.year, index: Math.ceil(j.month / SPAN[kind]) };
}

/** Its first and last day, both inclusive — what «از» and «تا» would hold. */
export function periodDays(p: Period): { from: JalaliDate; to: JalaliDate } {
  const span = SPAN[p.kind];
  const first = p.kind === 'year' ? 1 : (p.index - 1) * span + 1;
  const last = first + span - 1;
  return {
    from: { year: p.year, month: first, day: 1 },
    to: { year: p.year, month: last, day: jalaliMonthLength(p.year, last) },
  };
}

export function PeriodPicker({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const today = toJalali(Date.now());
  const years = [today.year - 2, today.year - 1, today.year];
  const names =
    value.kind === 'month' ? JALALI_MONTHS : value.kind === 'quarter' ? QUARTERS : value.kind === 'half' ? HALVES : [];
  return (
    <div className="datefield" data-testid="period-picker">
      <span className="datefield__label">دوره</span>
      <div className="datefield__row">
        <select
          className="form-control"
          aria-label="نوع دوره"
          value={value.kind}
          onChange={(e) => {
            const kind = e.target.value as PeriodKind;
            // Keep the moment the old period started in: Aban → پاییز → نیمهٔ دوم.
            const firstMonth = periodDays(value).from.month;
            onChange({ kind, year: value.year, index: Math.ceil(firstMonth / SPAN[kind]) });
          }}
        >
          {KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
        {names.length > 0 && (
          <select
            className="form-control"
            aria-label="کدام"
            value={value.index}
            onChange={(e) => onChange({ ...value, index: Number(e.target.value) })}
          >
            {names.map((n, i) => (
              <option key={n} value={i + 1}>
                {n}
              </option>
            ))}
          </select>
        )}
        <select
          className="form-control"
          aria-label="سال دوره"
          value={value.year}
          onChange={(e) => onChange({ ...value, year: Number(e.target.value) })}
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y.toLocaleString('fa-IR', { useGrouping: false })}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
