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
 * Which build am I looking at? Dev and production sit behind the same Cloudflare
 * Access policy and serve the same SPA bundle, so without this an operator can
 * approve a real payment while believing they are in dev. Production stays quiet
 * (version only); anything else shouts.
 */
function VersionBadge() {
  const [info, setInfo] = useState<{ version: string; env: string } | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    // Fetched once — the running build cannot change while the page is open.
    fetch('/api/v1/version', { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        // Validate the shape rather than trusting `ok` — an older worker, a
        // proxy, or a stubbed fetch can answer 200 with something else, and a
        // missing field here would crash the whole header.
        if (typeof d?.version === 'string' && typeof d?.env === 'string') {
          setInfo({ version: d.version, env: d.env });
        }
      })
      .catch(() => {
        /* badge is cosmetic; a failed probe just hides it */
      });
    return () => ac.abort();
  }, []);

  if (!info) return null;
  const isProd = info.env === 'production';

  return (
    <span
      className={`env-badge${isProd ? '' : ' env-badge--nonprod'}`}
      title={`${info.env} — v${info.version}`}
    >
      {isProd ? `v${info.version}` : `${info.env.toUpperCase()} v${info.version}`}
    </span>
  );
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
            <VersionBadge />
            {dateNav && <div className="shikoonet-header__date">{dateNav}</div>}
            <NotificationBell cache={cache} onNavigate={onNavigate} />
            <OperatorMenu onRefresh={onRefresh} />
          </div>
        </div>
      </header>
      {children}
    </HeaderSlotsContext.Provider>
  );
}
