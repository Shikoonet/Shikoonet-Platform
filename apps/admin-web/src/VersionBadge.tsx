/**
 * Which build am I looking at? Dev and production sit behind the same Cloudflare
 * Access policy and serve the same SPA bundle, so without this an operator can
 * approve a real payment while believing they are in dev. Production stays quiet
 * (version only); anything else shouts.
 *
 * ## Why it lives here and not in the hub header
 *
 * It used to be rendered by `ShikoonetHeader`, which only `HubSection` mounts —
 * six of the twenty-nine entries in the sidebar. On the other twenty-three
 * («کاربران», «مدیریت پنل‌ها», «محصولات», «ایمپورت میرزابات» …) there was NO
 * environment indicator at all, which is precisely the failure the paragraph
 * above says this exists to prevent. The sidebar renders on every page, so that
 * is where the answer belongs.
 *
 * It replaced a hardcoded «نسخهٔ ۱» in the sidebar footer. Two things claiming
 * to be the version, one of them a literal that no build could ever change, is
 * worse than one: the false one occupies the place a reader looks.
 *
 * ## And it says when this page is older than the server
 *
 * The first answer is the build this page was loaded with — the server serves
 * the bundle, so the two start equal. The server can move on while the tab
 * stays open, and the tab keeps running the old code against the new API.
 * 1 Mehr 1405: Sam pressed «از نو باز کردن» in a tab opened before that
 * morning's release; the old page had no day picker, sent no `asOf`, and the
 * books opened at 15:22 instead of midnight. So it asks again every two
 * minutes and whenever the tab comes back into view, and when the answer
 * differs it says so over the whole page until it is reloaded.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

const RECHECK_MS = 2 * 60 * 1000;

type Info = { version: string; env: string };

async function probe(signal?: AbortSignal): Promise<Info | null> {
  const r = await fetch('/api/v1/version', signal ? { signal } : {});
  const d = r.ok ? await r.json() : null;
  // Validate the shape rather than trusting `ok` — an older worker, a proxy,
  // or a stubbed fetch can answer 200 with something else, and a missing field
  // here would crash the whole sidebar.
  return typeof d?.version === 'string' && typeof d?.env === 'string' ? { version: d.version, env: d.env } : null;
}

export function VersionBadge() {
  const [info, setInfo] = useState<Info | null>(null);
  const [newer, setNewer] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    probe(ac.signal)
      .then((d) => d && setInfo(d))
      .catch(() => {
        /* badge is cosmetic; a failed probe just hides it */
      });
    return () => ac.abort();
  }, []);

  useEffect(() => {
    if (!info) return;
    const check = () => {
      probe()
        .then((d) => {
          if (d && d.version !== info.version) setNewer(d.version);
        })
        .catch(() => {
          /* a deploy in progress answers nothing for a moment; ask again later */
        });
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    const timer = setInterval(check, RECHECK_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [info]);

  if (!info) return null;
  const isProd = info.env === 'production';
  /*
   * Seven characters, because `APP_VERSION` is a full git sha.
   *
   * On production the badge printed `v` followed by all forty of them, so the
   * header carried `v70fb1055bd5fff3e378c0296d4eb2887ae2d66ae` — wider than the
   * «بررسی» tab beside it, and unreadable at any width. Sam's screenshot of the
   * live panel on 2026-08-25 is a strip of hexadecimal where a version should
   * be.
   *
   * Seven is what git itself abbreviates to and what a person can compare
   * against `git log` at a glance. The whole value stays in `title`, so nothing
   * is lost for the one case that wants it — and the slice is harmless if the
   * value is ever a real version like `1.4.2`, which is shorter than seven.
   */
  const short = info.version.slice(0, 7);

  return (
    <>
      {/* `dir="ltr"`: the content is `STAGING v1a2b3c4`, and in the RTL sidebar
          the environment word and the version were drawn in the opposite order
          from the one they are written in. */}
      <span
        dir="ltr"
        className={`env-badge${isProd ? '' : ' env-badge--nonprod'}`}
        title={`${info.env} — ${info.version}`}
      >
        {isProd ? `v${short}` : `${info.env.toUpperCase()} v${short}`}
      </span>
      {/* To <body>: a fixed child under the sidebar's backdrop-filter is
          positioned inside the sidebar, not the page. Above everything —
          header 1001/1002, dialogs 1110 — because the local walk found it at
          1000, drawn under the header, its button unreachable. */}
      {newer !== null &&
        createPortal(
          <div
            role="alert"
            data-testid="new-version"
            className="alert alert-warning"
            style={{
              position: 'fixed',
              top: 12,
              insetInline: 16,
              zIndex: 1200,
              margin: 0,
              background: 'var(--bg-body)',
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
            }}
          >
            <span>
              نسخهٔ تازهٔ پنل منتشر شده ({newer.slice(0, 7)}) و این صفحه هنوز نسخهٔ قبلی است. پیش از هر کاری صفحه را
              تازه کن تا کاری با کد قدیمی ثبت نشود.
            </span>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => window.location.reload()}>
              تازه کردن صفحه
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
