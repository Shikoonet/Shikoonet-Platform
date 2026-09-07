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
 */

import { useEffect, useState } from 'react';

export function VersionBadge() {
  const [info, setInfo] = useState<{ version: string; env: string } | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    // Fetched once — the running build cannot change while the page is open.
    fetch('/api/v1/version', { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        // Validate the shape rather than trusting `ok` — an older worker, a
        // proxy, or a stubbed fetch can answer 200 with something else, and a
        // missing field here would crash the whole sidebar.
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
    // `dir="ltr"`: the content is `STAGING v1a2b3c4`, and in the RTL sidebar
    // the environment word and the version were drawn in the opposite order
    // from the one they are written in.
    <span
      dir="ltr"
      className={`env-badge${isProd ? '' : ' env-badge--nonprod'}`}
      title={`${info.env} — ${info.version}`}
    >
      {isProd ? `v${short}` : `${info.env.toUpperCase()} v${short}`}
    </span>
  );
}
