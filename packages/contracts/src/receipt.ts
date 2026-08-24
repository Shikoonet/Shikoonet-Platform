/**
 * How a card-to-card receipt is stored, and how it is read back.
 *
 * The bot writes it and the dashboard serves it, so the encoding cannot live in
 * either of them. It lived in `apps/bot/src/payment.ts` for as long as only the
 * bot touched it, which was fine right up until the moment an operator needed
 * to look at a receipt — and then the choice was to copy these four lines into
 * the dashboard or to move them here. Two copies of an encoding is how a
 * `doc:` prefix comes to mean one thing on the way in and another on the way
 * out.
 *
 * **No image is ever stored.** The column holds a Telegram `file_id` and
 * Telegram holds the picture. That is worth stating in the place the encoding
 * lives, because "receipts will fill the disk" is the natural assumption and it
 * is not true here: the shop pays no storage and no egress for them, and the
 * admin looking at one sees Telegram's original rather than a copy.
 */

/**
 * What a `file_id` may look like.
 *
 * Telegram's own handles are a few dozen base64url characters. This is an
 * untrusted field on an untrusted update — anyone can post an update-shaped
 * body at a bot — and it ends up in a row that is later handed back to
 * `sendPhoto`, or put in a URL by the dashboard. A shape that is not a handle
 * is not one, and a megabyte of text in a column nobody bounded is a nuisance
 * we do not have to accept.
 *
 * Checked on the way in AND on the way out. The second check is not
 * superstition: the row may predate the first one, and the value is about to
 * become part of a request to a third party.
 */
export const RECEIPT_FILE_ID = /^[A-Za-z0-9_-]{16,200}$/;

/**
 * What marks a stored handle as a document rather than a photo.
 *
 * The two are different id spaces at Telegram — a document's handle given to
 * `sendPhoto` is refused, and the other way round — so the kind has to survive
 * with the id or the admin's screen finds out by being rejected.
 *
 * A prefix rather than a column, because `receipt_url_or_r2_key` is already a
 * reference of an unstated kind: its name says it may hold a URL or an R2 key,
 * and it has held a Telegram handle since the bot was written. Every row that
 * existed when this was introduced is a photo and carries no prefix, so nothing
 * had to be migrated and no value already stored changed meaning.
 */
export const RECEIPT_DOC_PREFIX = 'doc:';

/** Splits a stored receipt back into what it is and how to send it. */
export function receiptRef(stored: string): { fileId: string; isDocument: boolean } {
  return stored.startsWith(RECEIPT_DOC_PREFIX)
    ? { fileId: stored.slice(RECEIPT_DOC_PREFIX.length), isDocument: true }
    : { fileId: stored, isDocument: false };
}

/** The inverse, so the two halves cannot drift apart. */
export function storedReceipt(fileId: string, isDocument: boolean): string {
  return isDocument ? `${RECEIPT_DOC_PREFIX}${fileId}` : fileId;
}
