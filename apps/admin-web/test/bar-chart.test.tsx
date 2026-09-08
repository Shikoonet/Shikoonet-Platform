/**
 * A bar chart, in about sixty lines of SVG.
 *
 * Sam chose this over a charting library on 2026-09-07, and the reason holds
 * up: two bar charts is not a dependency's worth of problem, and the ones that
 * would do it are 40-100 KB of JavaScript for a shape `<rect>` already draws.
 *
 * The assertions are about what a reader can get OUT of it — a number per bar,
 * a shape that is proportional, and a sentence when there is nothing to show —
 * because a chart nobody can read a value off is decoration.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BarChart } from '../src/BarChart.js';

const SERIES = [
  { label: '۱۵ شهریور', value: 100_000 },
  { label: '۱۶ شهریور', value: 300_000 },
  { label: '۱۷ شهریور', value: 0 },
];

describe('the bar chart', () => {
  it('draws one bar per point, including the empty ones', () => {
    // An empty day is data: dropping it would make three sales on three days
    // look like three sales in a week.
    const { container } = render(<BarChart series={SERIES} format={(v) => String(v)} />);
    expect(container.querySelectorAll('rect')).toHaveLength(3);
  });

  it('scales the bars to the largest value, not to the sum', () => {
    const { container } = render(<BarChart series={SERIES} format={(v) => String(v)} />);
    const heights = [...container.querySelectorAll('rect')].map((r) =>
      Number(r.getAttribute('height')),
    );
    // 300k is the tallest; 100k is a third of it; zero has no height at all.
    expect(heights[1]).toBeGreaterThan(heights[0]!);
    expect(heights[2]).toBe(0);
    expect(heights[0]! / heights[1]!).toBeCloseTo(1 / 3, 2);
  });

  it('says every value in words, because a bar cannot be read to the Rial', () => {
    render(<BarChart series={SERIES} format={(v) => `${v} تومان`} />);
    // `<title>` inside each bar: the browser's own tooltip, and what a screen
    // reader announces. No hover state to invent, nothing to keep positioned.
    expect(screen.getByText('۱۶ شهریور — 300000 تومان')).toBeTruthy();
  });

  it('says so in a sentence when there is nothing to draw', () => {
    // Not an empty box. A chart area with no bars in it reads as «broken», and
    // «no sales in this window» is a real and common answer.
    render(<BarChart series={[]} format={String} />);
    expect(screen.getByText('در این بازه چیزی ثبت نشده است.')).toBeTruthy();
    expect(document.querySelectorAll('rect')).toHaveLength(0);
  });

  it('says so when every bar is zero, rather than drawing a flat floor', () => {
    // The trap a naive `max` falls into: dividing by zero, or drawing three
    // full-height bars for three zeroes.
    render(
      <BarChart series={[{ label: 'الف', value: 0 }, { label: 'ب', value: 0 }]} format={String} />,
    );
    expect(screen.getByText('در این بازه چیزی ثبت نشده است.')).toBeTruthy();
  });
});
