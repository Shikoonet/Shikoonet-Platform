/**
 * An operator changing their own password, from inside the panel.
 *
 * Until 2026-08-22 there was no way to. The panel's whole auth surface was
 * login, logout and me, and the only thing that could write a password hash was
 * `apps/dashboard-worker/scripts/operator.ts` — which needs a shell on the
 * server. So the operator who suspected their password was known could not act
 * on it, and the one who forgot it had to find somebody with SSH. That was not
 * a decision: the CLI exists to create the *first* account, back when there was
 * no panel to create it from, and it had quietly been doing this job too.
 *
 * Reached from the header rather than from a page in the sidebar, because every
 * role needs it and the sidebar is filtered by role — `READ_ONLY` sees fifteen
 * of the twenty-four entries. Next to «خروج», which is the other thing you do
 * to your own session rather than to the shop.
 *
 * The confirmation field is here and not on the server on purpose. A typo in a
 * password you cannot see locks you out of a panel with no reset-by-email, and
 * the server cannot tell a typo from a choice; the browser is the only place
 * that has both strings.
 */

import { useEffect, useRef, useState } from 'react';

interface Props {
  onClose: () => void;
}

export function PasswordCard({ onClose }: Props) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (next !== again) {
      setError('رمز تازه با تکرارش یکی نیست.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/v1/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ current, next }),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        detail?: string;
        until?: string;
      } | null;

      if (res.ok) {
        setDone(true);
        setCurrent('');
        setNext('');
        setAgain('');
        return;
      }
      if (body?.error === 'account_locked') {
        const until = body.until ? new Date(body.until) : null;
        setError(
          until
            ? `حساب موقتاً قفل است. تا ${until.toLocaleTimeString('fa-IR')} صبر کنید.`
            : 'حساب موقتاً قفل است.',
        );
        return;
      }
      // `weak_password` and `unchanged` carry a sentence written next to the
      // rule that refused, so it cannot drift from what the server enforces.
      if (body?.detail) {
        setError(body.detail);
        return;
      }
      if (body?.error === 'unauthorized') {
        setError('نشست شما تمام شده. یک بار خارج و دوباره وارد شوید.');
        return;
      }
      // The only case left is a wrong current password. Said plainly: the
      // person is already signed in, so there is nothing to give away.
      setError('رمز فعلی درست نیست. پنج بار اشتباه، حساب را ۱۵ دقیقه قفل می‌کند.');
    } catch {
      setError('ارتباط با سرور برقرار نشد.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" role="group" aria-label="تغییر رمز عبور" onSubmit={submit}>
      <div className="card__head">
        <span className="card__title">تغییر رمز عبور</span>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          بستن
        </button>
      </div>

      {done ? (
        <p className="alert alert-info">
          رمز عوض شد. هر نشست دیگری از این حساب — روی هر دستگاه دیگری — بسته شد؛ همین یکی باز ماند.
        </p>
      ) : (
        <>
          <p className="muted">
            دست‌کم ۱۲ کاراکتر و ۴ حرف متفاوت. اجبار حرف بزرگ و عدد و علامت عمداً نیست — چهار کاراکتر
            بیشتر از هر کدامشان می‌ارزد.
          </p>
          <div className="filters">
            <div>
              <label className="form-label" htmlFor="pw-current">
                رمز فعلی
              </label>
              <input
                id="pw-current"
                ref={ref}
                className="form-control ltr"
                type="password"
                autoComplete="current-password"
                value={current}
                disabled={busy}
                onChange={(e) => setCurrent(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="form-label" htmlFor="pw-next">
                رمز تازه
              </label>
              <input
                id="pw-next"
                className="form-control ltr"
                type="password"
                autoComplete="new-password"
                value={next}
                disabled={busy}
                onChange={(e) => setNext(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="form-label" htmlFor="pw-again">
                تکرار رمز تازه
              </label>
              <input
                id="pw-again"
                className="form-control ltr"
                type="password"
                autoComplete="new-password"
                value={again}
                disabled={busy}
                onChange={(e) => setAgain(e.target.value)}
                required
              />
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? '…' : 'ثبت'}
            </button>
          </div>
        </>
      )}

      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}
