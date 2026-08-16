/**
 * The sign-in screen.
 *
 * There has never been one before: Cloudflare Access stood in front of the
 * origin and the panel only ever saw people who were already through it. This
 * is what replaced it (Sam, 2026-08-16), which makes this one form the whole
 * front door.
 *
 * The second factor appears in place rather than on a second screen. The server
 * takes the password and the code in one request and answers `totp_required`
 * when it needs one, so there is no half-authenticated state to hold anywhere —
 * the field simply appears and the same credentials are sent again.
 */

import { useEffect, useRef, useState } from 'react';

interface Props {
  onSignedIn: () => void;
}

export function LoginPage({ onSignedIn }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (needsCode) codeRef.current?.focus();
  }, [needsCode]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password, ...(needsCode ? { code } : {}) }),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        until?: string;
      } | null;

      if (res.ok) {
        onSignedIn();
        return;
      }
      if (body?.error === 'totp_required') {
        // Not a failure — the password was right and one more field is needed.
        setNeedsCode(true);
        setError(null);
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
      // Everything else is one sentence on purpose. Telling apart "no such
      // address" from "wrong password" hands half the answer to whoever is
      // guessing, and the server already refuses to distinguish them.
      setError('ایمیل یا رمز درست نیست.');
      setCode('');
    } catch {
      setError('ارتباط با سرور برقرار نشد.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login__card" onSubmit={submit}>
        <div className="login__brand">شیکو</div>
        <div className="login__sub">ورود به پنل مدیریت</div>

        <label className="login__label" htmlFor="login-email">
          ایمیل
        </label>
        <input
          id="login-email"
          className="login__input"
          type="email"
          autoComplete="username"
          dir="ltr"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          disabled={needsCode}
        />

        <label className="login__label" htmlFor="login-password">
          رمز عبور
        </label>
        <input
          id="login-password"
          className="login__input"
          type="password"
          autoComplete="current-password"
          dir="ltr"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          disabled={needsCode}
        />

        {needsCode && (
          <>
            <label className="login__label" htmlFor="login-code">
              کد تایید دو مرحله‌ای
            </label>
            <input
              id="login-code"
              ref={codeRef}
              className="login__input login__input--code"
              inputMode="numeric"
              autoComplete="one-time-code"
              dir="ltr"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              required
            />
          </>
        )}

        {error && (
          <div className="login__error" role="alert">
            {error}
          </div>
        )}

        <button className="login__submit" type="submit" disabled={busy}>
          {busy ? '…' : 'ورود'}
        </button>

        {needsCode && (
          <button
            type="button"
            className="login__back"
            onClick={() => {
              setNeedsCode(false);
              setCode('');
              setError(null);
            }}
          >
            بازگشت
          </button>
        )}
      </form>
    </div>
  );
}
