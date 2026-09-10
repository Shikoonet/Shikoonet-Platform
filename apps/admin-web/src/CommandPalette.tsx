/**
 * Say where you want to be, instead of finding it.
 *
 * Thirty-one sections in seven sidebar groups, and the 2026-09-07 review called
 * getting between them the panel's central gap. Slice 2 gave the rows doors —
 * a name in a ledger opens the customer it names — and this gives the keyboard
 * one: `Ctrl/⌘+K` anywhere, or `/` when you are not already typing into
 * something.
 *
 * ## Two sources, and not five
 *
 * A section is what an operator asks for by name a hundred times a day. A
 * customer is what they arrive holding — a telegram id pasted out of a support
 * chat. Everything else on this panel already has its own search box on its own
 * screen, and a palette that also searched orders, panels, plans and codes
 * would mostly return the wrong kind of thing.
 *
 * ## Why `showModal()`
 *
 * It traps the keyboard. `<dialog open>` does not: Tab walks out of the palette
 * into the page behind it, which for a control that exists to be used from the
 * keyboard is the whole point missed. It also brings the top layer and a real
 * `::backdrop`, so the hand-rolled backdrop this had is gone.
 *
 * The first version used the bare `open` attribute on the belief that happy-dom
 * has no `showModal`. Nobody checked. happy-dom implements it, and the belief
 * had been written into three comments and a pull request by then.
 *
 * ## Why the role filter is not optional
 *
 * `visible` is the same predicate the sidebar uses. Without it the palette is a
 * door around the menu into a screen the server answers 403 for — READ_ONLY
 * cannot open «کاربران», and offering it would be a promise the shop refuses.
 */

import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { NAV, pageLabel, type PageId } from './nav.js';

/** Long enough that a stray keystroke does not query fifteen thousand rows. */
const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;

interface CustomerHit {
  id: number;
  telegramId: number | string;
  username?: string | null;
}

type Row =
  | { kind: 'page'; id: PageId; label: string }
  | { kind: 'customer'; hit: CustomerHit };

function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

export function CommandPalette({
  go,
  visible,
}: {
  go: (id: PageId, search?: string) => void;
  visible: (id: PageId) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const [people, setPeople] = useState<CustomerHit[]>([]);
  const box = useRef<HTMLInputElement | null>(null);
  const shell = useRef<HTMLDialogElement | null>(null);

  const pages: Row[] = NAV.flatMap((g) => g.items)
    .filter((i) => visible(i.id))
    .filter((i) => q.trim() !== '' && pageLabel(i.id).includes(q.trim()))
    .map((i) => ({ kind: 'page', id: i.id, label: pageLabel(i.id) }));

  const rows: Row[] = [...pages, ...people.map((hit) => ({ kind: 'customer' as const, hit }))];

  function close(): void {
    setOpen(false);
    setQ('');
    setPeople([]);
    setCursor(0);
  }

  function choose(row: Row | undefined): void {
    if (!row) return;
    if (row.kind === 'page') go(row.id);
    else go('customers', `?id=${row.hit.id}`);
    close();
  }

  // One listener for the whole panel. `keydown` on the document rather than a
  // handler on the dialog: the point of the shortcut is that it works from
  // wherever you happen to be.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (!open) {
        // `/` is a real character in every search box on the panel, so it only
        // opens this when nothing is being typed into.
        if (e.key === '/' && !isTyping()) {
          e.preventDefault();
          setOpen(true);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Arrow and Enter are read off the live row list, so they are registered
  // separately from the shortcut above — that effect must not re-subscribe on
  // every keystroke.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => (rows.length === 0 ? 0 : (c + 1) % rows.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => (rows.length === 0 ? 0 : (c - 1 + rows.length) % rows.length));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        choose(rows[cursor]);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // `showModal()` rather than the `open` attribute, which is what this used
  // until CodeRabbit asked why. The difference is not cosmetic: a modal dialog
  // is in the top layer, gets a real `::backdrop`, and TRAPS THE KEYBOARD —
  // with `open` alone, Tab walks straight out of the palette into the page
  // behind it, which for a control that exists to be used from the keyboard is
  // the whole point missed.
  //
  // The comment that used to sit here said happy-dom has no `showModal`. That
  // was never checked, and it is false: happy-dom implements it and it sets
  // `open`. An assumption, written down three times and believed.
  useEffect(() => {
    if (!open) return;
    const el = shell.current;
    if (el && !el.open) el.showModal();
    box.current?.focus();
  }, [open]);

  // Customers are asked for, sections are not: the section list is already here
  // and filtering it is free.
  useEffect(() => {
    const term = q.trim();
    if (!open || term.length < MIN_QUERY || !visible('customers')) {
      setPeople([]);
      return undefined;
    }
    // Cleared before the request is even scheduled, not when its answer lands.
    // The debounce puts 250ms between the keystroke and the answer, and for
    // that whole window this list otherwise still held the LAST query's
    // customers — so Enter, at any normal typing speed, opened a customer who
    // does not match what is on screen. A palette that acts on something other
    // than what it shows is worse than a slow one.
    setPeople([]);
    let dropped = false;
    const t = setTimeout(() => {
      void api
        .customers({ q: term, page: 1, pageSize: 5 })
        .then((r) => {
          // The answer to a query the operator has already typed past is worse
          // than no answer: it replaces what they are looking at.
          if (!dropped && r.ok) setPeople((r.items ?? []) as CustomerHit[]);
        })
        .catch(() => {
          if (!dropped) setPeople([]);
        });
    }, DEBOUNCE_MS);
    return () => {
      dropped = true;
      clearTimeout(t);
    };
  }, [q, open, visible]);

  useEffect(() => {
    setCursor(0);
  }, [q]);

  if (!open) return null;

  return (
    <dialog
      ref={shell}
      className="palette"
      aria-label="رفتن به"
      // A modal dialog's backdrop is part of the dialog, so a click on it
      // arrives with the dialog itself as the target — anything inside reports
      // the child it landed on.
      onClick={(e) => {
        if (e.target === shell.current) close();
      }}
      // Escape is the browser's, and it closes the element without telling
      // React. Without this the state says open and nothing is on screen, and
      // the next Ctrl+K toggles it shut.
      onClose={close}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div className="palette__inner">
        <input
          ref={box}
          className="form-control palette__box"
          type="text"
          value={q}
          placeholder="نام بخش، یا آیدی عددی مشتری"
          aria-label="نام بخش یا مشتری"
          onChange={(e) => setQ(e.target.value)}
        />
        {rows.length === 0 ? (
          <p className="muted palette__empty">
            {q.trim() === '' ? 'نام بخشی را بنویس، یا آیدی یک مشتری.' : 'چیزی پیدا نشد.'}
          </p>
        ) : (
          <ul className="palette__rows" role="listbox">
            {rows.map((row, i) => (
              <li
                key={row.kind === 'page' ? row.id : `c${row.hit.id}`}
                role="option"
                aria-selected={i === cursor}
                className={i === cursor ? 'palette__row palette__row--on' : 'palette__row'}
                onMouseEnter={() => setCursor(i)}
                onClick={() => choose(row)}
              >
                {row.kind === 'page' ? (
                  <span>{row.label}</span>
                ) : (
                  <span className="ltr">
                    {row.hit.username ? `@${row.hit.username}` : row.hit.telegramId}
                  </span>
                )}
                <span className="muted palette__kind">
                  {row.kind === 'page' ? 'بخش' : 'مشتری'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </dialog>
  );
}
