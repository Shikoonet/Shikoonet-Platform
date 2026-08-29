/**
 * Display the originating device of a transaction.
 *
 * Primary visible value: `devices.display_name` (e.g. "Poyan Android Phone").
 * Secondary value: `devices.device_code` (e.g. "poyan-01") — smaller, muted,
 * always shown when a device is known.
 *
 * If `display_name` is empty/null, the device code takes the primary slot so
 * the visible label is never blank. The internal `device_id` UUID is
 * intentionally NOT used as the visible label.
 *
 * Width-handling:
 * - Long names wrap normally on whitespace; they never break mid-word.
 * - A max-width keeps the column tidy; the full text is in `title` for
 *   hover tooltip.
 *
 * Used in Today, Suggested, Unmatched, Reviewed matches, Reviewed
 * transactions, and the View Details modal.
 */

export interface DeviceNameProps {
  displayName: string | null | undefined;
  deviceCode: string | null | undefined;
  /** Optional max-width for the device block, defaults to "180px". */
  maxWidth?: string;
}

export function DeviceName({ displayName, deviceCode, maxWidth = '180px' }: DeviceNameProps) {
  const hasDisplay = !!displayName && displayName.trim() !== '';
  const hasCode = !!deviceCode && deviceCode.trim() !== '';
  if (!hasDisplay && !hasCode) return <span className="muted">—</span>;
  // Fallback rule: if display_name is empty, promote device_code to the
  // primary slot. The internal UUID is never shown as a label.
  const primary = hasDisplay ? displayName : deviceCode;
  const secondary = hasDisplay ? deviceCode : null;
  const title = hasDisplay ? displayName + (hasCode ? ` (${deviceCode})` : '') : (deviceCode ?? '');
  return (
    <span className="device-name" style={{ display: 'inline-block', maxWidth }}>
      <span
        className="device-name__primary"
        title={title ?? ''}
        style={{
          display: 'block',
          fontWeight: 500,
          overflowWrap: 'normal',
          wordBreak: 'normal',
          // Cap to the parent cell width so a long device name can never
          // push the row wider than its column.
          maxWidth: '100%',
        }}
      >
        {primary}
      </span>
      {secondary && (
        <span
          className="device-name__secondary muted"
          title={secondary}
          style={{
            display: 'block',
            fontSize: '0.85em',
            overflowWrap: 'normal',
            wordBreak: 'normal',
            maxWidth: '100%',
          }}
        >
          {secondary}
        </span>
      )}
    </span>
  );
}
