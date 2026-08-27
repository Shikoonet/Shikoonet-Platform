/**
 * A button that says whether the copy actually happened.
 *
 * It lived in `EventsPage` and was welded to `AppEventRow[]`. It is here now
 * because the second thing an admin wanted to copy — a customer's Telegram id —
 * is not an event, and a second button would have been a second answer to «did
 * the copy work», on a panel where that question has a real answer.
 *
 * ## Why the state, and why it can say «کپی نشد»
 *
 * `copyText` reports failure rather than throwing, because on a panel opened
 * directly over plain http the clipboard API is missing entirely — see the note
 * in `clipboard.ts`. A button that always said «کپی شد» would have an admin
 * pasting whatever was on the clipboard before, and not noticing until it was
 * in a message to a customer.
 *
 * ## Why the text is a function
 *
 * The caller's payload can be expensive — `eventText` serialises a whole event
 * to JSON — and a button drawn once per row in a 25-row table would build all
 * 25 strings on every render, for a click that happens to one of them. The
 * thunk is evaluated when the button is pressed and never otherwise.
 */

import { useEffect, useRef, useState } from 'react';

import { copyText } from './clipboard.js';

export function CopyButton({
  getText,
  label,
  title,
  small = true,
}: {
  /** Built on click, never on render. */
  getText: () => string;
  label: string;
  title: string;
  small?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => (timer.current ? clearTimeout(timer.current) : undefined), []);

  return (
    <button
      type="button"
      className={small ? 'btn btn-sm' : 'btn'}
      title={title}
      onClick={() => {
        void copyText(getText()).then((ok) => {
          // Reported, not assumed.
          setState(ok ? 'done' : 'failed');
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setState('idle'), 2000);
        });
      }}
    >
      {state === 'done' ? 'کپی شد ✓' : state === 'failed' ? 'کپی نشد' : label}
    </button>
  );
}
