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
 */

import { brandMark, brandName, DEFAULT_BRAND_NAME } from '@shikoo/contracts';

let name = DEFAULT_BRAND_NAME;

/**
 * Asks the server whose panel this is. Called once, from `main.tsx`.
 *
 * `credentials` is deliberately absent: this is the one route the page calls
 * before there is a session, and sending one it does not need would make a
 * public endpoint look like an authenticated one to anybody reading the
 * network tab.
 */
export async function loadBrand(): Promise<void> {
  try {
    const res = await fetch('/api/v1/brand');
    if (!res.ok) return;
    const body = (await res.json()) as { name?: unknown };
    // Sanitised again on this side. The server already does it, and doing it
    // here as well costs one call and means the page cannot be broken by a
    // response it did not expect — a proxy, a captive portal, an older build.
    name = brandName(typeof body.name === 'string' ? body.name : null);
  } catch {
    // Left at the default. See the header.
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
