/**
 * A bar chart, in SVG, with no dependency.
 *
 * Sam chose this over a library on 2026-09-07 and the arithmetic is on its
 * side: the panel wants two bar charts, and the libraries that would draw them
 * are 40–100 KB of JavaScript for a shape `<rect>` already makes. A chart is
 * also the one kind of component whose bugs are invisible in a unit test and
 * obvious on screen, so keeping it small keeps it checkable.
 *
 * ## What a reader can get out of it
 *
 * A bar cannot be read to the Rial, so every one carries a `<title>` with its
 * label and its exact value: the browser's own tooltip, and what a screen
 * reader announces. That is also why there is no hover state to invent and
 * nothing to keep positioned.
 *
 * ## Why «nothing to draw» is a sentence
 *
 * An empty plot area reads as «broken». «هیچ فروشی در این بازه نبوده» is a
 * real and frequent answer, and it has to look like an answer.
 */

import { useId } from 'react';

export interface BarPoint {
  label: string;
  value: number;
}

export function BarChart({
  series,
  format,
  height = 160,
  title,
}: {
  series: BarPoint[];
  /** How a value reads in words — Toman, a count, whatever this chart is of. */
  format: (value: number) => string;
  height?: number;
  title?: string;
}) {
  const id = useId();
  const max = series.reduce((m, p) => Math.max(m, p.value), 0);

  // Zero bars and all-zero bars are the same answer, and neither is a chart:
  // one divides by zero, the other draws a full-height floor for nothing.
  if (series.length === 0 || max <= 0) {
    return (
      <div className="chart chart--empty">
        {title && <div className="chart__title">{title}</div>}
        <p className="muted">در این بازه چیزی ثبت نشده است.</p>
      </div>
    );
  }

  // A viewBox rather than pixel widths: the SVG then scales with its column
  // and the bars stay proportional at any size, which is the whole reason not
  // to measure anything in JavaScript.
  const GAP = 2;
  const step = 100 / series.length;
  const barWidth = Math.max(step - GAP, 0.5);

  return (
    <div className="chart">
      {title && (
        <div className="chart__title" id={`${id}-t`}>
          {title}
        </div>
      )}
      <svg
        className="chart__svg"
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        role="img"
        {...(title ? { 'aria-labelledby': `${id}-t` } : {})}
      >
        {series.map((p, i) => {
          const h = (p.value / max) * height;
          return (
            <rect
              key={p.label}
              x={i * step + GAP / 2}
              y={height - h}
              width={barWidth}
              height={h}
              rx={0.5}
            >
              <title>{`${p.label} — ${format(p.value)}`}</title>
            </rect>
          );
        })}
      </svg>
      {/* Only the ends, and only when there is room for them to mean anything.
          A label under all thirty bars is a smear; the tooltips carry the rest. */}
      <div className="chart__axis">
        <span>{series[0]!.label}</span>
        <span>{series[series.length - 1]!.label}</span>
      </div>
    </div>
  );
}
