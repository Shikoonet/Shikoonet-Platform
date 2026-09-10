/**
 * One headline number, in a card.
 *
 * It was written twice — `DashboardPage.tsx:295` and `StatsPage.tsx:582` —
 * byte for byte the same but for the spelling of one optional type. Neither
 * copy knew about the other, so a change to the card would have landed on one
 * of the two screens and looked deliberate on both.
 */

import { Icon } from './icons.js';

export function Stat({
  tone,
  icon,
  value,
  label,
  foot,
}: {
  tone: string;
  icon: string;
  value: string;
  label: string;
  foot?: string | undefined;
}) {
  return (
    <div className={`stat-card ${tone}`}>
      <div>
        <div className="stat-card__value">{value}</div>
        <div className="stat-card__label">{label}</div>
        {foot && (
          <div className="stat-card__label" style={{ fontSize: 11, opacity: 0.75 }}>
            {foot}
          </div>
        )}
      </div>
      <span className="stat-card__icon">
        <Icon name={icon} size={24} />
      </span>
    </div>
  );
}
