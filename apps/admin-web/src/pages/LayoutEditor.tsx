/**
 * چیدمان — where a shop screen breaks its rows.
 *
 * One component for both levels of the shop, because the categories screen and
 * a category's products are the same problem with different labels.
 *
 * WHAT THIS DRAWS, AND WHY IT IS A PHONE. An admin arranging a shop screen is
 * asking one question: what will the customer see. The first version answered a
 * different one — a column of admin cards, each carrying five glyph buttons —
 * and it was rejected on sight, correctly. So this draws the message and the
 * inline keyboard at the width Telegram gives them, and the buttons are moved
 * by dragging them, which is the gesture the panel this is modelled on uses.
 *
 * WHY THERE IS NO ROW NUMBER ANYWHERE. `checkCatalogLayout` refuses a gap, a
 * row number that goes backwards, and a half-arranged screen. A pair of number
 * boxes puts all three one keystroke away, and each is a refusal the admin has
 * to read and decode. Here the arrangement is SERIALISED from the rows at save
 * time, so those states are unreachable rather than refused. What is left is a
 * row wider than Telegram accepts and a screen longer than a phone can read,
 * and both are refused by the drop itself.
 *
 * KEYBOARD. Native drag and drop reaches a mouse and nothing else, so every
 * chip is a real `<button>` and the arrow keys do the same four moves. That is
 * not a courtesy: it is the only way this screen works on a laptop trackpad
 * with a stuck drag, and it costs eleven lines.
 */

import { useEffect, useState } from 'react';
import { MAX_CATALOG_ROWS, MAX_ROW_WIDTH, groupIntoRows } from '@shikoo/contracts';
import { api, ApiError, type LayoutItem, type LayoutScope } from '../api.js';
import { count } from '../format.js';
import { useAdminWriteProps } from '../role.js';

export interface LayoutButton {
  id: number;
  label: string;
  /** A second line on the chip — a price, or why it is not on sale. */
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

type Rows = LayoutButton[][];

/** Where a chip is, as `[row, column]`. `[-1, -1]` if it is not on the board. */
function locate(rows: Rows, id: number): [number, number] {
  for (const [r, row] of rows.entries()) {
    const c = row.findIndex((b) => b.id === id);
    if (c !== -1) return [r, c];
  }
  return [-1, -1];
}

/**
 * Move one chip, and tidy up after it.
 *
 * `toRow` and `toCol` are positions in the board the admin is LOOKING at, and
 * the conversion below is the whole of why this is a function rather than three
 * lines at each call site: lifting a chip out can delete its row, and then
 * every row after it has shifted by one. Handing the callers the post-lift
 * indexing instead would make «drop it on the strip below its own row» land a
 * row too far, and only sometimes — which is the shape of bug that survives a
 * demo.
 *
 * An emptied row is dropped rather than kept, because a row exists only because
 * a button is in it. That is the same rule `groupIntoRows` reads the saved
 * arrangement by.
 */
function move(rows: Rows, id: number, toRow: number, toCol: number, asNewRow: boolean): Rows {
  const [from, fromCol] = locate(rows, id);
  if (from === -1) return rows;
  const chip = rows[from]!.find((b) => b.id === id)!;

  const vanishes = rows[from]!.length === 1;
  const lifted = rows.map((row) => row.filter((b) => b.id !== id)).filter((row) => row.length > 0);
  const shifted = toRow - (vanishes && toRow > from ? 1 : 0);

  if (asNewRow) {
    if (lifted.length >= MAX_CATALOG_ROWS) return rows;
    const at = Math.max(0, Math.min(shifted, lifted.length));
    return [...lifted.slice(0, at), [chip], ...lifted.slice(at)];
  }

  const at = Math.max(0, Math.min(shifted, lifted.length - 1));
  const target = lifted[at];
  if (!target || target.length >= MAX_ROW_WIDTH) return rows;
  // Same conversion one axis down: dropping on the chip that is fourth in a row
  // means «go in front of it», and after lifting a chip from in front of it,
  // it is third.
  const wanted = toCol < 0 ? target.length : toCol - (toRow === from && toCol > fromCol ? 1 : 0);
  const col = Math.max(0, Math.min(wanted, target.length));
  return lifted.map((row, i) => (i === at ? [...row.slice(0, col), chip, ...row.slice(col)] : row));
}

export function LayoutEditor({
  scope,
  items,
  screenText,
  onSaved,
}: {
  scope: LayoutScope;
  /** The WHOLE screen, in its saved order. A partial list is refused by the server. */
  items: LayoutButton[];
  /** The message the bot sends above these buttons, so the frame is the real screen. */
  screenText: string;
  onSaved: () => void;
}) {
  const w = useAdminWriteProps();
  const [rows, setRows] = useState<Rows>(() => groupIntoRows(items));
  const [dragging, setDragging] = useState<number | null>(null);
  /** Where a drop would land right now: a row and column, or a new row before `row`. */
  const [over, setOver] = useState<{ row: number; col: number; asNewRow: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Reloading when the screen's contents change — a product added, a category
  // renamed — rather than keeping edits across it. Unsaved positions for rows
  // that no longer exist are not edits worth keeping.
  useEffect(() => {
    setRows(groupIntoRows(items));
    setDone(null);
  }, [items]);

  const dirty = JSON.stringify(serialise(rows)) !== JSON.stringify(serialise(groupIntoRows(items)));

  function drop(row: number, col: number, asNewRow: boolean) {
    if (dragging === null) return;
    setRows((current) => move(current, dragging, row, col, asNewRow));
    setDragging(null);
    setOver(null);
    setDone(null);
  }

  /** The four moves, for anyone reaching this screen without a mouse. */
  function key(e: React.KeyboardEvent, id: number) {
    const keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const [r, c] = locate(rows, id);
    // Right is BACK in an RTL row, so the arrows match what the eye sees rather
    // than what the array index does.
    if (e.key === 'ArrowRight') setRows(move(rows, id, r, c - 1, false));
    if (e.key === 'ArrowLeft') setRows(move(rows, id, r, c + 1, false));
    if (e.key === 'ArrowUp') setRows(move(rows, id, r - 1, -1, false));
    if (e.key === 'ArrowDown') setRows(move(rows, id, r + 1, -1, false));
    setDone(null);
  }

  async function save(payload: LayoutItem[], said: string) {
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      await api.saveCatalogLayout(scope, payload);
      // Not «تا نیم دقیقهٔ دیگر» like the bot-keyboard screen says. That is true
      // there — `loadBotContent` caches for thirty seconds — and false here:
      // these rows are read live on every screen a customer opens. Promising
      // less than the truth teaches an admin to save twice.
      setDone(said);
      onSaved();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  const arranged = items.some((b) => b.rowIndex !== null);

  if (items.length === 0) {
    return <p className="empty">این صفحه هنوز دکمه‌ای ندارد.</p>;
  }

  /** A place a dragged chip can land, drawn between two rows. */
  const splitAt = (row: number) => (
    <div
      className={`kb-split${over?.asNewRow && over.row === row ? ' kb-split--over' : ''}`}
      onDragOver={(e) => {
        if (dragging === null) return;
        e.preventDefault();
        setOver({ row, col: -1, asNewRow: true });
      }}
      onDrop={(e) => {
        e.preventDefault();
        drop(row, -1, true);
      }}
    />
  );

  return (
    <div className="arrange">
      <div className="phone">
        <div className="phone__message">{screenText}</div>
        <div className="phone__keyboard" onDragEnd={() => setOver(null)}>
          {splitAt(0)}
          {rows.map((row, r) => (
            <div key={row[0]!.id}>
              <div
                className={`kb-row${over && !over.asNewRow && over.row === r ? ' kb-row--over' : ''}`}
                onDragOver={(e) => {
                  if (dragging === null || row.length >= MAX_ROW_WIDTH) return;
                  e.preventDefault();
                  setOver({ row: r, col: -1, asNewRow: false });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  drop(r, over?.asNewRow ? -1 : (over?.col ?? -1), false);
                }}
              >
                {row.map((b, c) => (
                  <button
                    key={b.id}
                    type="button"
                    draggable
                    className={[
                      'kb-chip',
                      dragging === b.id ? 'kb-chip--dragging' : '',
                      over && !over.asNewRow && over.row === r && over.col === c
                        ? 'kb-chip--before'
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onDragStart={() => setDragging(b.id)}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                    }}
                    onDragOver={(e) => {
                      if (dragging === null || dragging === b.id) return;
                      e.preventDefault();
                      e.stopPropagation();
                      setOver({ row: r, col: c, asNewRow: false });
                    }}
                    onKeyDown={(e) => key(e, b.id)}
                    {...w}
                  >
                    <span>{b.label}</span>
                    {b.hint && <span className="kb-chip__hint">{b.hint}</span>}
                  </button>
                ))}
              </div>
              {splitAt(r + 1)}
            </div>
          ))}
        </div>
      </div>

      <div className="arrange__side">
        <p className="muted" style={{ margin: 0 }}>
          دکمه‌ها را با ماوس بگیرید و جابه‌جا کنید: روی یک دکمهٔ دیگر بیندازید تا کنارش بنشیند، یا
          روی فاصلهٔ بین دو ردیف تا ردیف تازه بسازد. با صفحه‌کلید هم می‌شود — روی دکمه Tab بزنید و
          با کلیدهای جهت‌دار ببریدش.
        </p>

        {err && <div className="alert alert-error">{err}</div>}
        {done && <div className="alert alert-ok">{done}</div>}

        <div className="row-actions" style={{ justifyContent: 'flex-start' }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !dirty}
            onClick={() =>
              void save(serialise(rows), 'چیدمان ذخیره شد. ربات همین حالا همین را می‌کشد.')
            }
            {...w}
          >
            ذخیرهٔ چیدمان
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || !arranged}
            onClick={() => {
              if (!window.confirm('چیدمان برداشته شود؟ هر دکمه دوباره ردیف خودش را می‌گیرد.')) {
                return;
              }
              // Every position null is what «never arranged» means, and the bot
              // reads it as one button per row — the shape a screen ships in.
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

        <p className="muted" style={{ margin: 0 }}>
          {count(rows.length)} ردیف · حداکثر {count(MAX_ROW_WIDTH)} دکمه در هر ردیف و{' '}
          {count(MAX_CATALOG_ROWS)} ردیف در کل صفحه.
        </p>
      </div>
    </div>
  );
}

/**
 * The arrangement as the server takes it.
 *
 * The array ORDER is the column order and `sortOrder` is never sent — the
 * server writes it as the array index. There is no second place for the order
 * to live, so there is nothing for it to disagree with, and the whole class of
 * «two buttons claim column 2» stops existing rather than being validated
 * against.
 */
function serialise(rows: Rows): LayoutItem[] {
  return rows.flatMap((row, r) => row.map((b) => ({ id: b.id, rowIndex: r })));
}
