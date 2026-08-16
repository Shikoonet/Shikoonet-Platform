/**
 * Account cell with the originating device folded underneath.
 *
 * Used by the compact-desktop (1200–1439px) tables for Today, Suggested,
 * Unmatched, Reviewed matches and Reviewed transactions. At that width
 * the standalone Device column doesn't fit; we fold display_name + device_code
 * under the account so the device stays visible inline (no View Details
 * detour required).
 *
 * Layout (column-friendly):
 *   Account
 *     پارسیان حساب ۱          ← account_display (or "Not assigned")
 *     Poyan Android Phone      ← device.display_name (primary)
 *     poyan-01                 ← device.device_code (secondary)
 *
 * Width-handling:
 *   - Account display is clamped with the standard table-ellipsis pattern.
 *   - Device block uses DeviceName's inline-block + max-width so it never
 *     breaks letter-by-letter and never overflows the parent cell.
 *   - No document overflow: cell content fits inside the column width set
 *     by the .today-table--compact / .suggested-table--compact / etc
 *     colgroup.
 */

import { DeviceName } from './DeviceName.js';

export interface AccountCellProps {
  accountDisplay: string | null | undefined;
  deviceDisplayName: string | null | undefined;
  deviceCode: string | null | undefined;
}

export function AccountCell({ accountDisplay, deviceDisplayName, deviceCode }: AccountCellProps) {
  const hasDevice = !!(
    (deviceDisplayName && deviceDisplayName.trim() !== '') ||
    (deviceCode && deviceCode.trim() !== '')
  );
  return (
    <div className="account-cell">
      <span
        className="account-cell__primary table-ellipsis"
        title={accountDisplay ?? 'اختصاص نیافته'}
        style={{ display: 'block', maxWidth: '100%' }}
      >
        {accountDisplay ?? <span className="muted">اختصاص نیافته</span>}
      </span>
      {hasDevice && (
        <div className="account-cell__device">
          <DeviceName displayName={deviceDisplayName} deviceCode={deviceCode} maxWidth="100%" />
        </div>
      )}
    </div>
  );
}
