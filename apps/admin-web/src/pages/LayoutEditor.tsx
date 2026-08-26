/**
 * Where a shop screen breaks its rows — the categories, or the configs in one.
 *
 * One component for both levels, because the two screens are the same problem
 * with different labels, and two copies would be two places for the rule to
 * drift.
 *
 * WHY THIS DOES NOT LOOK LIKE «چیدمان کیبورد». That screen has a row box and a
 * column box per button, and it can: `bot_keyboard_buttons` positions a closed
 * set of buttons that never changes underneath it, so absolute `(row, col)`
 * cells mean something. Here the buttons are database rows — they come and go,
 * and half of them are invisible to any particular customer. So the stored
 * position is one number and a list order, and this editor works in ROWS
 * directly rather than exposing that number.
 *
 * That is not a presentation choice. `checkCatalogLayout` refuses a gap, a row
 * number that goes backwards, and a half-arranged screen; a pair of number
 * boxes makes all three one keystroke away and each of them is a refusal the
 * admin has to read and decode. Editing rows instead makes those states
 * unreachable: the arrangement is SERIALISED from the rows at save time, so
 * it is monotonic and gapless by construction. What is left for the server to
 * refuse is a row wider than Telegram accepts and a screen longer than a phone
 * can read, and both are refused HERE first, with the button disabled rather
 * than the save rejected.
 *
 * The preview is not a preview. It is the editor — the same rows, the same
 * order, with the controls on the chips. A separate preview panel would be a
 * second rendering of the same state and therefore a second thing that can be
 * wrong.
 */

import { useEffect, useState } from 'react';
import { MAX_CATALOG_ROWS, MAX_ROW_WIDTH, groupIntoRows } from '@shikoo/contracts';
import { api, ApiError, type LayoutItem, type LayoutScope } from '../api.js';
import { count } from '../format.js';
import { useAdminWriteProps } from '../role.js';

export interface LayoutButton {
  id: number;
  label: string;
  /** A second line on the chip — a price, a service name, a count. */
  hint?: string | null;
  rowIndex: number | null;
}

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'forbidden') return 'برای این کار دسترسی ادمین لازم است.';
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Move `item` out of `rows` and drop the row if it was the last one in it. */
function without(rows: LayoutButton[][], id: number): LayoutButton[][] {
  return rows.map((row) => row.filter((b) => b.id !== id)).filter((row) => row.length > 0);
}

export function LayoutEditor({
  scope,
  items,
  onSaved,
  note,
}: {
  scope: LayoutScope;
  /** The WHOLE screen, in its saved order. A partial list is refused by the server. */
  items: LayoutButton[];
  onSaved: () => void;
  /** One sentence about what this particular screen is, above the rows. */
  note?: string;
}) {
  const w = useAdminWriteProps();
  const [rows, setRows] = useState<LayoutButton[][]>(() => groupIntoRows(items));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Reloading when the screen's contents change — a config added, a category
  // renamed — rather than keeping edits across it. Unsaved edits about rows
  // that no longer exist are not edits worth keeping.
  useEffect(() => {
    setRows(groupIntoRows(items));
    setDone(null);
  }, [items]);

  const at = (id: number): [number, number] => {
    for (const [r, row] of rows.entries()) {
      const c = row.findIndex((b) => b.id === id);
      if (c !== -1) return [r, c];
    }
    return [-1, -1];
  };

  function swapInRow(id: number, delta: number) {
    const [r, c] = at(id);
    const row = rows[r];
    if (!row || c + delta < 0 || c + delta >= row.length) return;
    const next = rows.map((x) => [...x]);
    const line = next[r]!;
    [line[c], line[c + delta]] = [line[c + delta]!, line[c]!];
    setRows(next);
    setDone(null);
  }

  /** Move a button into the row above or below, joining the end of it. */
  function toRow(id: number, delta: number) {
    const [r] = at(id);
    const target = r + delta;
    if (target < 0 || target >= rows.length) return;
    const button = rows[r]!.find((b) => b.id === id)!;
    if ((rows[target]?.length ?? 0) >= MAX_ROW_WIDTH) return;
    const stripped = without(rows, id);
    // `without` may have removed an empty row above the target, which shifts it.
    const shift = rows[r]!.length === 1 && r < target ? -1 : 0;
    const next = stripped.map((row, i) => (i === target + shift ? [...row, button] : row));
    setRows(next);
    setDone(null);
  }

  /** Give a button a line of its own, immediately below the one it is on. */
  function split(id: number) {
    const [r] = at(id);
    if (rows.length >= MAX_CATALOG_ROWS) return;
    const button = rows[r]!.find((b) => b.id === id)!;
    const stripped = rows.map((row) => row.filter((b) => b.id !== id));
    const next: LayoutButton[][] = [];
    for (const [i, row] of stripped.entries()) {
      if (row.length > 0) next.push(row);
      if (i === r) next.push([button]);
    }
    setRows(next);
    setDone(null);
  }

  /** The arrangement as the server takes it: array order is column order. */
  function serialise(): LayoutItem[] {
    return rows.flatMap((row, r) => row.map((b) => ({ id: b.id, rowIndex: r })));
  }

  async function save(payload: LayoutItem[], message_: string) {
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      await api.saveCatalogLayout(scope, payload);
      // Not «تا نیم دقیقهٔ دیگر» like the keyboard screen says. That one is
      // true there — `loadBotContent` caches for thirty seconds — and false
      // here: these rows are read live on every screen the customer opens.
      // Promising less than the truth teaches an admin to save twice.
      setDone(message_);
      onSaved();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  const tooWide = rows.some((row) => row.length > MAX_ROW_WIDTH);
  const tooMany = rows.length > MAX_CATALOG_ROWS;
  const arranged = items.some((b) => b.rowIndex !== null);

  if (items.length === 0) {
    return <p className="muted">این صفحه هنوز دکمه‌ای ندارد.</p>;
  }

  return (
    <>
      {note && (
        <p className="muted" style={{ marginBlockStart: 0 }}>
          {note}
        </p>
      )}
      {err && <div className="alert alert-error">{err}</div>}
      {done && <div className="alert alert-info">{done}</div>}
      {tooWide && (
        <div className="alert alert-error">
          تلگرام بیش از {count(MAX_ROW_WIDTH)} دکمه در یک ردیف را رد می‌کند و کلِ پیام را نمی‌فرستد.
        </div>
      )}
      {tooMany && (
        <div className="alert alert-error">
          بیش از {count(MAX_CATALOG_ROWS)} ردیف روی گوشی خوانده نمی‌شود.
        </div>
      )}

      <div className="preview-keyboard">
        {rows.map((row, r) => (
          <div key={row[0]!.id} className="preview-row">
            {row.map((b, c) => (
              <span key={b.id} className="preview-button">
                <span>{b.label}</span>
                {b.hint && <small className="page-head__sub">{b.hint}</small>}
                <span className="layout-chip__tools">
                  <button
                    type="button"
                    className="btn btn-sm"
                    title="یک جا به راست"
                    disabled={c === 0}
                    onClick={() => swapInRow(b.id, -1)}
                    {...w}
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    title="یک جا به چپ"
                    disabled={c === row.length - 1}
                    onClick={() => swapInRow(b.id, 1)}
                    {...w}
                  >
                    ›
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    title="به ردیف بالا"
                    disabled={r === 0 || (rows[r - 1]?.length ?? 0) >= MAX_ROW_WIDTH}
                    onClick={() => toRow(b.id, -1)}
                    {...w}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    title="به ردیف پایین"
                    disabled={r === rows.length - 1 || (rows[r + 1]?.length ?? 0) >= MAX_ROW_WIDTH}
                    onClick={() => toRow(b.id, 1)}
                    {...w}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    title="ردیف تازه، زیر همین ردیف"
                    disabled={row.length === 1 || rows.length >= MAX_CATALOG_ROWS}
                    onClick={() => split(b.id)}
                    {...w}
                  >
                    ⏎
                  </button>
                </span>
              </span>
            ))}
          </div>
        ))}
      </div>

      <div className="filters" style={{ marginBlockStart: 12 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || tooWide || tooMany}
          onClick={() => void save(serialise(), 'چیدمان ذخیره شد و ربات همین حالا همین را می‌کشد.')}
          {...w}
        >
          ذخیرهٔ چیدمان
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !arranged}
          onClick={() => {
            if (!window.confirm('چیدمان برداشته شود؟ هر دکمه دوباره ردیف خودش را می‌گیرد.')) return;
            // Every position null is what «never arranged» means, and the bot
            // reads it as one button per row — the shape this screen had before
            // anybody arranged it.
            void save(
              items.map((b) => ({ id: b.id, rowIndex: null })),
              'چیدمان برداشته شد؛ هر دکمه دوباره ردیف خودش را دارد.',
            );
          }}
          {...w}
        >
          برداشتن چیدمان
        </button>
      </div>
    </>
  );
}
