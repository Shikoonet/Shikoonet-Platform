import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

type HeaderSlotName = 'center' | 'dateNav';

interface HeaderSlots {
  setSlot: (slot: HeaderSlotName, node: ReactNode) => void;
}

const HeaderSlotsContext = createContext<HeaderSlots | null>(null);

export function HeaderSlot({ slot, children }: { slot: HeaderSlotName; children: ReactNode }) {
  const ctx = useContext(HeaderSlotsContext);

  useEffect(() => {
    if (!ctx) return;
    ctx.setSlot(slot, children);
    return () => ctx.setSlot(slot, null);
  }, [ctx, slot, children]);

  if (ctx) return null;

  if (slot === 'center') {
    return <div className="payments-shell__header-slot">{children}</div>;
  }
  if (slot === 'dateNav') {
    return <div className="payments-shell__date-slot">{children}</div>;
  }
  return null;
}

/**
 * The two slots a finance screen fills in the panel's own header.
 *
 * `HeaderSlot` is unchanged — a screen still says «put this in the middle»
 * without knowing where the header is. What moved is the header: there is one
 * now, in `App`, and this is how the six finance screens still reach it.
 *
 * ## Why the filled slots are not lifted into the shell
 *
 * The obvious shape — hold `center`/`dateNav` in the provider and let `App`
 * read them — hangs, and it hung for real on 2026-09-08 before this comment
 * existed. Filling a slot sets state on the provider, which re-renders the whole
 * tree under it, which re-renders the screen, which produces a NEW `children`
 * element, whose `useEffect` fills the slot again. React elements are new
 * objects on every render, so the dependency never settles and the loop never
 * ends. Vitest simply stopped producing output.
 *
 * So the state stays put and only `HeaderSlotOutlet` subscribes to it: the
 * header re-renders, the screen does not, and the cycle has nowhere to close.
 */
export function HeaderSlotsProvider({ children }: { children: ReactNode }) {
  const [filled, setFilled] = useState<FilledSlots>({ center: null, dateNav: null });

  const slots = useMemo<HeaderSlots>(
    () => ({
      setSlot(slot, node) {
        setFilled((prev) => ({ ...prev, [slot]: node }));
      },
    }),
    [],
  );

  return (
    <HeaderSlotsContext.Provider value={slots}>
      <FilledSlotsContext.Provider value={filled}>{children}</FilledSlotsContext.Provider>
    </HeaderSlotsContext.Provider>
  );
}

interface FilledSlots {
  center: ReactNode;
  dateNav: ReactNode;
}

const FilledSlotsContext = createContext<FilledSlots>({ center: null, dateNav: null });

/**
 * What the current screen has put in one slot.
 *
 * A component of its own rather than a hook the header calls, so that filling a
 * slot re-renders THIS and not the shell around it — see the loop described
 * above.
 */
export function HeaderSlotOutlet({ slot }: { slot: HeaderSlotName }) {
  const filled = useContext(FilledSlotsContext);
  const node = filled[slot];
  if (!node) return null;
  return <div className={slot === 'center' ? 'app-header__center' : 'app-header__date'}>{node}</div>;
}
