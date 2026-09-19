/**
 * The word every permanent delete asks for — on the screen and on the route.
 *
 * Until 2026-09-19 each gate asked for something of its own: the account's
 * display name, the device's name or code, and the import screen's «fresh
 * start» the environment's name. Sam, who deletes things all day: «این
 * جمله‌ای که برای تایید پاک کردن می‌گیره اذیت‌کننده شده … اون کلمه همه جا
 * باشه: Delete» — and, asked whether the fresh start should keep its own,
 * «اونم delete کن». One word, the same everywhere, so the gate is a pause
 * and not a spelling test against a Persian name with ZWNJs in it.
 *
 * Case does not matter; the word does. Here rather than in the SPA because
 * the fresh-start route compares it on the server (`importRoutes.ts`), and
 * the screen and the route must agree on the one string.
 */
export const DELETE_WORD = 'Delete';

export function isDeleteWord(typed: string): boolean {
  return typed.trim().toLowerCase() === DELETE_WORD.toLowerCase();
}
