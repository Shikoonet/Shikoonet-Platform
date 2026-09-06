/**
 * The name this panel wears, resolved once before the page draws.
 *
 * ## Why a module variable and not state
 *
 * Every surface that shows the name — the sign-in card, the header crumb, the
 * sidebar square, the browser tab — is drawn on the very first paint, and the
 * name never changes while the tab is open. React state would mean rendering
 * «شیکو» and replacing it a moment later, which is precisely the failure this
 * is fixing: a reseller's operator watching our name flash across their panel.
 *
 * So `main.tsx` awaits {@link loadBrand} before it mounts anything, and every
 * caller reads a value that is already there. No context, no provider, no
 * prop threaded through four components for a string that is constant.
 *
 * ## Why the failure path draws the default
 *
 * If the request fails the panel still has to open — the operator is most
 * likely about to sign in and read an error, and a blank page tells them
 * nothing. So a network failure means «شیکو», the same as an unset variable.
 * That is a wrong name on a reseller's box for as long as their own server is
 * unreachable, which is a state in which they have a larger problem.
 *
 * ## And why the deadline is not optional
 *
 * «Fails» has to include «never answers». `main.tsx` mounts React inside this
 * promise's `.then()`, so a request that hangs — a captive portal that accepts
 * the connection and never replies, a proxy holding the socket open, a
 * container that is up but not yet serving — leaves the operator staring at a
 * blank page with no error and nothing to click. `fetch` has no timeout of its
 * own; only the browser's, which is minutes. So this one carries its own.
 */

import { brandMark, brandName, DEFAULT_BRAND_NAME } from '@shikoo/contracts';

let name = DEFAULT_BRAND_NAME;

/**
 * How long the page waits for its own name before drawing under the default.
 *
 * Three seconds is chosen against what is behind this call: a route on the
 * same origin that reads one environment variable and returns. It is not a
 * budget for a slow server — nothing that answers this route is slow — it is
 * the point past which «slow» is really «never», and the operator is better
 * served by a panel with the wrong name than by no panel.
 */
export const BRAND_TIMEOUT_MS = 3000;

/**
 * Asks the server whose panel this is. Called once, from `main.tsx`.
 *
 * `credentials` is deliberately absent: this is the one route the page calls
 * before there is a session, and sending one it does not need would make a
 * public endpoint look like an authenticated one to anybody reading the
 * network tab.
 */
export async function loadBrand(timeoutMs = BRAND_TIMEOUT_MS): Promise<void> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch('/api/v1/brand', { signal: abort.signal });
    if (!res.ok) return;
    const body = (await res.json()) as { name?: unknown };
    // Sanitised again on this side. The server already does it, and doing it
    // here as well costs one call and means the page cannot be broken by a
    // response it did not expect — a proxy, a captive portal, an older build.
    name = brandName(typeof body.name === 'string' ? body.name : null);
  } catch {
    // Left at the default. See the header. An abort lands here too, which is
    // the point: a request that times out and one that is refused are the
    // same answer to the page.
  } finally {
    clearTimeout(timer);
  }
}

/** Whose panel this is. Ready from the first render. */
export function brand(): string {
  return name;
}

/** The single character the sidebar square draws. */
export function mark(): string {
  return brandMark(name);
}
