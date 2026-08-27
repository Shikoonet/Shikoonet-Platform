/**
 * A keyboard, arranged with the mouse.
 *
 * Lifted out of `LayoutEditor` when «چیدمان کیبورد» needed the same gesture and
 * had number inputs for row and column instead. Two screens arranging buttons
 * by two different means is how they drift: the catalogue editor already knew
 * that dropping on the fourth chip in a row means «go in front of it», and the
 * keyboard editor would have had to learn it again.
 *
 * ## What stayed behind
 *
 * Saving. `LayoutEditor` writes a catalogue arrangement through
 * `saveCatalogLayout`; the keyboard screen writes a whole menu through
 * `bot-keyboard/:menu`, refuses actions this build does not know, and has a
 * «required button» rule. Those are not the same operation and pretending they
 * were would have needed a mode flag threaded through both.
 *
 * So this file owns the board and the gestures, and nothing about where the
 * result goes.
 *
 * ## Chips are keyed by string
 *
 * The catalogue's rows have numeric ids and the keyboard's have `action`. One
 * string key covers both, and the callers convert — a `Map` back to their own
 * row is a line each, and neither has to care what the other's identity is.
 */

import type { ReactNode } from 'react';
import { useState } from 'react';
import { MAX_CATALOG_ROWS, MAX_ROW_WIDTH } from '@shikoo/contracts';

import { useAdminWriteProps } from '../role.js';

export interface GridChip {
  /** Unique on the board. The caller's own identity, as a string. */
  key: string;
  label: ReactNode;
  /** A second line on the chip — a price, an action name, why it is off sale. */
  hint?: string | null | undefined;
  /** Painted onto the chip, so the board shows the colours against each other. */
  tint?: string | null | undefined;
  /**
   * Drawn faded — on the board, but not on the customer's screen.
   *
   * The keyboard editor needs it: a hidden button still has a position, and
   * leaving it off the board would make the board the only way to arrange
   * buttons and then refuse to arrange one of them.
   */
  dim?: boolean | undefined;
}

export type GridRows = GridChip[][];

/** Where a chip is, as `[row, column]`. `[-1, -1]` if it is not on the board. */
export function locate(rows: GridRows, key: string): [number, number] {
  for (let r = 0; r < rows.length; r++) {
    const c = rows[r]!.findIndex((b) => b.key === key);
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
 * a button is in it.
 */
export function move(
  rows: GridRows,
  key: string,
  toRow: number,
  toCol: number,
  asNewRow: boolean,
): GridRows {
  const [from, fromCol] = locate(rows, key);
  if (from === -1) return rows;
  const chip = rows[from]!.find((b) => b.key === key)!;

  const vanishes = rows[from]!.length === 1;
  const lifted = rows.map((row) => row.filter((b) => b.key !== key)).filter((row) => row.length > 0);
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

/** The instructions, said once so both screens say them the same way. */
export const GRID_HELP =
  'دکمه‌ها را با ماوس بگیرید و جابه‌جا کنید: روی یک دکمهٔ دیگر بیندازید تا کنارش بنشیند، یا روی فاصلهٔ بین دو ردیف تا ردیف تازه بسازد. با صفحه‌کلید هم می‌شود — روی دکمه Tab بزنید و با کلیدهای جهت‌دار جابه‌جایش کنید.';

export function ButtonGrid({
  rows,
  onChange,
  screenText,
}: {
  rows: GridRows;
  /** The whole board, after a move. The caller decides what to do with it. */
  onChange: (next: GridRows) => void;
  /** The message the bot sends above these buttons, so the frame is the real screen. */
  screenText: string;
}) {
  const w = useAdminWriteProps();
  const [dragging, setDragging] = useState<string | null>(null);
  /** Where a drop would land right now: a row and column, or a new row before `row`. */
  const [over, setOver] = useState<{ row: number; col: number; asNewRow: boolean } | null>(null);

  function drop(row: number, col: number, asNewRow: boolean) {
    if (dragging === null) return;
    onChange(move(rows, dragging, row, col, asNewRow));
    setDragging(null);
    setOver(null);
  }

  /** The four moves, for anyone reaching this screen without a mouse. */
  function key(e: React.KeyboardEvent, id: string) {
    const keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const [r, c] = locate(rows, id);
    // Right is BACK in an RTL row, so the arrows match what the eye sees rather
    // than what the array index does.
    if (e.key === 'ArrowRight') onChange(move(rows, id, r, c - 1, false));
    if (e.key === 'ArrowLeft') onChange(move(rows, id, r, c + 1, false));
    if (e.key === 'ArrowUp') onChange(move(rows, id, r - 1, -1, false));
    if (e.key === 'ArrowDown') onChange(move(rows, id, r + 1, -1, false));
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
    <div className="phone">
      <div className="phone__message">{screenText}</div>
      <div className="phone__keyboard" onDragEnd={() => setOver(null)}>
        {splitAt(0)}
        {rows.map((row, r) => (
          <div key={row[0]!.key}>
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
                  key={b.key}
                  type="button"
                  draggable
                  className={[
                    'kb-chip',
                    dragging === b.key ? 'kb-chip--dragging' : '',
                    over && !over.asNewRow && over.row === r && over.col === c
                      ? 'kb-chip--before'
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{
                    ...(b.tint ? { background: b.tint, borderColor: b.tint, color: '#fff' } : {}),
                    ...(b.dim ? { opacity: 0.45 } : {}),
                  }}
                  onDragStart={() => setDragging(b.key)}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  onDragOver={(e) => {
                    if (dragging === null || dragging === b.key) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setOver({ row: r, col: c, asNewRow: false });
                  }}
                  onKeyDown={(e) => key(e, b.key)}
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
  );
}
