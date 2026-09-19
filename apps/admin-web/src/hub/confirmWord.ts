/**
 * The word every permanent delete asks for.
 *
 * Until 2026-09-19 each modal asked for something of its own — the account's
 * display name, the device's name or code — and Sam, who deletes things all
 * day: «این جمله‌ای که برای تایید پاک کردن می‌گیره اذیت‌کننده شده … اون کلمه
 * همه جا باشه: Delete». One word, the same everywhere, so the gate is a pause
 * and not a spelling test against a Persian name with ZWNJs in it.
 *
 * Case does not matter; the word does. The «fresh start» on the import screen
 * is deliberately NOT on this word — it asks for the environment's name, so
 * you cannot empty a shop without first knowing which one you are standing in.
 */
export const DELETE_WORD = 'Delete';

export function typedDeleteWord(typed: string): boolean {
  return typed.trim().toLowerCase() === DELETE_WORD.toLowerCase();
}
