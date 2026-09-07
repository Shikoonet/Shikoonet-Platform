import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { NotificationBell } from './NotificationBell.js';
import type { Cache } from './query.js';
import { ContinuityBanner, ContinuityButton, useContinuityMode } from './ContinuityBanner.js';

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

interface ShikoonetHeaderProps {
  cache: Cache;
  onNavigate: (
    tab: 'payments' | 'statistics' | 'today',
    filter?: { kind: string; paymentTab?: string },
  ) => void;
  onRefresh: () => void;
  opsMode?: boolean;
  children?: ReactNode;
}

function OperatorMenu({ onRefresh }: { onRefresh: () => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="operator-menu" ref={wrapRef}>
      <button
        type="button"
        className="operator-menu__trigger"
        aria-label="منوی اپراتور"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="operator-menu__avatar" aria-hidden>
          OP
        </span>
        <span className="operator-menu__chevron" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="operator-menu__panel" role="menu">
          <button
            type="button"
            role="menuitem"
            className="operator-menu__item"
            onClick={() => {
              onRefresh();
              setOpen(false);
            }}
          >
            تازه‌سازی همهٔ نماها
          </button>
          {/* The section list that used to live here is the panel's sidebar
              now. Two menus offering the same six destinations is how the two
              panels drifted apart in the first place.

              The light/dark switch went the same way: the panel is dark, these
              screens take its palette, and a control that changes nothing is
              worse than no control. */}
        </div>
      )}
    </div>
  );
}

export function ShikoonetHeader({
  cache,
  onNavigate,
  onRefresh,
  opsMode = false,
  children,
}: ShikoonetHeaderProps) {
  const [center, setCenter] = useState<ReactNode>(null);
  const [dateNav, setDateNav] = useState<ReactNode>(null);

  // One poll for both children. They are never on screen together — the button
  // is the NORMAL state and the strip is the CONTINUITY one — but each mounting
  // its own timer would mean two requests every thirty seconds to answer one
  // question.
  const continuity = useContinuityMode();

  const slots = useMemo<HeaderSlots>(
    () => ({
      setSlot(slot, node) {
        if (slot === 'center') setCenter(node);
        else setDateNav(node);
      },
    }),
    [],
  );

  return (
    <HeaderSlotsContext.Provider value={slots}>
      <header className={`shikoonet-header${opsMode ? ' shikoonet-header--ops' : ''}`}>
        <div className="shikoonet-header__bar">
          {/* The brand block and the mobile hamburger were here. Both belong to
              the panel's own header and sidebar now — a second logo one row
              below the first is what «two panels» looks like after they have
              supposedly been merged. */}
          <div className="shikoonet-header__center">{center}</div>

          <div className="shikoonet-header__right">
            <ContinuityButton state={continuity.state} onChanged={continuity.refresh} />
            {dateNav && <div className="shikoonet-header__date">{dateNav}</div>}
            <NotificationBell cache={cache} onNavigate={onNavigate} />
            <OperatorMenu onRefresh={onRefresh} />
          </div>
        </div>
        {/* Its own row, under the bar, because it is a STRIP.
            It used to be a flex item inside `__right`, which is the `auto`
            track of a two-column grid: a paragraph of Persian in there opened
            that track to its full content width and starved the `minmax(0,1fr)`
            track next to it — the one holding the payment tabs. The warning
            broke the navigation of the screen it was warning about. */}
        <ContinuityBanner state={continuity.state} onChanged={continuity.refresh} />
      </header>
      {children}
    </HeaderSlotsContext.Provider>
  );
}
