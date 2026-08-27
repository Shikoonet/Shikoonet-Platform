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
import { ButtonGrid, GRID_HELP, type GridChip } from './ButtonGrid.js';
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

/** This screen's row, found again by the key the grid handed back. */
function toChip(b: LayoutButton): GridChip {
  return { key: String(b.id), label: b.label, hint: b.hint };
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

  if (items.length === 0) {
    return <p className="empty">این صفحه هنوز دکمه‌ای ندارد.</p>;
  }

  const byId = new Map(items.map((b) => [String(b.id), b]));

  return (
    <div className="arrange">
      <ButtonGrid
        rows={rows.map((row) => row.map(toChip))}
        onChange={(next) => {
          // Back to this screen's own shape. The grid knows about chips and
          // nothing about catalogue ids, so the map back lives here.
          setRows(next.map((row) => row.map((c) => byId.get(c.key)!)));
          setDone(null);
        }}
        screenText={screenText}
      />

      <div className="arrange__side">
        <p className="muted" style={{ margin: 0 }}>
          {GRID_HELP}
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
