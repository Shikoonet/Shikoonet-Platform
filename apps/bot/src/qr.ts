/**
 * A subscription link as something a camera can read.
 *
 * The customer's next move after buying is to get the config into an app on a
 * phone. A URL in a chat bubble means selecting a long string on a touch
 * keyboard and pasting it into another app; a QR code means pointing the phone
 * at the screen — and every VPN client on the market has a scanner built in.
 * The competitor's bot sends one, ours did not, and that is the whole reason
 * this file exists.
 *
 * Nothing here talks to a third party. A QR service would be one HTTP call and
 * would also hand somebody else's server the exact link that unlocks a paying
 * customer's account.
 */

import QRCode from 'qrcode';

/**
 * Big enough to scan off a phone held in front of another phone, which is the
 * awkward case that actually happens. Telegram compresses photos, so a code
 * generated at display size loses modules to the resampling.
 */
const SIZE_PX = 720;

/**
 * The white border the spec calls the quiet zone, in modules.
 *
 * Four is the standard minimum. Dropping it to look tidier is the single most
 * common reason a code that renders correctly still will not scan, because the
 * decoder cannot find the edge against a dark chat background.
 */
const MARGIN_MODULES = 2;

/**
 * PNG bytes for `text`.
 *
 * Error correction level M — the middle setting. A subscription link is long
 * enough that H would push the code into a denser version, and denser is
 * harder to scan than more redundant; M survives the smudges and glare that a
 * screen photographed off another screen actually produces.
 */
export async function qrPng(text: string): Promise<Buffer> {
  return QRCode.toBuffer(text, {
    type: 'png',
    errorCorrectionLevel: 'M',
    width: SIZE_PX,
    margin: MARGIN_MODULES,
    color: { dark: '#000000ff', light: '#ffffffff' },
  });
}
