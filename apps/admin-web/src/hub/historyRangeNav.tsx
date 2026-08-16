import { useEffect, useRef, type ReactNode } from 'react';
import { HISTORY_RANGE_PRESETS, type HistoryRangeState } from './paymentReview.js';

const TEHRAN_OFFSET_MS = 3.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function tehranDayBoundsFromDate(dateStr: string): { start: number } {
  const [y, m, d] = dateStr.split('-').map(Number);
  const startUtc = new Date(Date.UTC(y!, m! - 1, d!, 12, 0, 0, 0));
  startUtc.setUTCHours(0, 0, 0, 0);
  return { start: startUtc.getTime() + TEHRAN_OFFSET_MS };
}

export function tehranAdjacentDay(dateStr: string, deltaDays: number): string {
  const { start } = tehranDayBoundsFromDate(dateStr);
  const tehranMs = start + deltaDays * DAY_MS + 12 * 60 * 60 * 1000 + TEHRAN_OFFSET_MS;
  const d = new Date(tehranMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function formatTehranDateLabel(dateStr: string): string {
  const { start } = tehranDayBoundsFromDate(dateStr);
  return new Date(start + 12 * 60 * 60 * 1000).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Tehran',
  });
}

export function tehranDayRelativeLabel(dateStr: string, nowMs = Date.now()): string | null {
  const today = tehranTodayDateString(nowMs);
  if (dateStr === today) return 'امروز';
  if (dateStr === tehranAdjacentDay(today, -1)) return 'دیروز';
  if (dateStr === tehranAdjacentDay(today, 1)) return 'فردا';
  return null;
}

export function tehranTodayDateString(nowMs = Date.now()): string {
  const tehranMs = nowMs + TEHRAN_OFFSET_MS;
  const d = new Date(tehranMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function HistoryDateNav({
  value,
  onChange,
}: {
  value: HistoryRangeState;
  onChange: (next: HistoryRangeState) => void;
}) {
  const day = value.day ?? tehranTodayDateString();
  const relative = value.preset === 'day' ? tehranDayRelativeLabel(day) : null;
  const presetLabel = HISTORY_RANGE_PRESETS.find((p) => p.value === value.preset)?.label ?? 'همه';

  function setPreset(preset: HistoryRangeState['preset']) {
    if (preset === 'day') {
      onChange({ preset: 'day', day: value.day ?? tehranTodayDateString() });
      return;
    }
    onChange({ preset });
  }

  return (
    <details className="unified-date-control">
      <summary className="unified-date-control__trigger" aria-label="بازهٔ تاریخ">
        {value.preset === 'day' ? (
          <>
            <span className="unified-date-control__date">{formatTehranDateLabel(day)}</span>
            {relative && (
              <>
                <span className="unified-date-control__sep">–</span>
                <span className="unified-date-control__relative">{relative}</span>
              </>
            )}
          </>
        ) : (
          <span className="unified-date-control__preset">{presetLabel}</span>
        )}
        <span className="unified-date-control__icon" aria-hidden>
          📅
        </span>
      </summary>
      <div className="unified-date-control__panel">
        <label className="unified-date-control__field">
          <span className="visually-hidden">بازهٔ آماده</span>
          <select
            value={value.preset}
            aria-label="بازهٔ آماده"
            onChange={(e) => setPreset(e.target.value as HistoryRangeState['preset'])}
          >
            {HISTORY_RANGE_PRESETS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {value.preset === 'day' && (
          <div className="unified-date-control__day" aria-label="پیمایش روز">
            <button
              type="button"
              className="ghost unified-date-control__nav"
              aria-label="روز قبل"
              onClick={() => onChange({ preset: 'day', day: tehranAdjacentDay(day, -1) })}
            >
              ←
            </button>
            <label className="unified-date-control__picker">
              <span className="visually-hidden">انتخاب تاریخ</span>
              <input
                type="date"
                value={day}
                aria-label="انتخاب تاریخ از تقویم"
                onChange={(e) => {
                  if (e.target.value) onChange({ preset: 'day', day: e.target.value });
                }}
              />
            </label>
            <button
              type="button"
              className="ghost unified-date-control__nav"
              aria-label="روز بعد"
              onClick={() => onChange({ preset: 'day', day: tehranAdjacentDay(day, 1) })}
            >
              →
            </button>
            <button
              type="button"
              className="ghost unified-date-control__today"
              onClick={() => onChange({ preset: 'day', day: tehranTodayDateString() })}
            >
              امروز
            </button>
          </div>
        )}
      </div>
    </details>
  );
}

export function BulkSelectionToolbar({
  itemIds,
  selectedIds,
  onChangeSelected,
  actions,
}: {
  itemIds: string[];
  selectedIds: Set<string>;
  onChangeSelected: (next: Set<string>) => void;
  actions?: ReactNode;
}) {
  const headerRef = useRef<HTMLInputElement>(null);
  const allSelected = itemIds.length > 0 && itemIds.every((id) => selectedIds.has(id));
  const someSelected = itemIds.some((id) => selectedIds.has(id));
  const indeterminate = someSelected && !allSelected;

  useEffect(() => {
    if (headerRef.current) headerRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <div className="bulk-toolbar">
      <label className="bulk-toolbar__select-all">
        <input
          ref={headerRef}
          type="checkbox"
          checked={allSelected}
          aria-label="انتخاب همهٔ ردیف‌ها"
          onChange={(e) => {
            if (e.target.checked) onChangeSelected(new Set(itemIds));
            else onChangeSelected(new Set());
          }}
        />
      </label>
      {actions}
    </div>
  );
}
