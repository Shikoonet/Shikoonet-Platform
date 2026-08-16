/**
 * NewBadge tests.
 *
 * Verifies:
 *   - Renders nothing when isNew is false / undefined.
 *   - Renders the NEW pill when isNew is true.
 *   - Uses an accessible label.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NewBadge } from '../../src/hub/NewBadge.js';

describe('NewBadge', () => {
  it('renders nothing when isNew is false', () => {
    const { container } = render(<NewBadge isNew={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when isNew is undefined', () => {
    const { container } = render(<NewBadge isNew={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when isNew is null', () => {
    const { container } = render(<NewBadge isNew={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the NEW pill when isNew is true', () => {
    render(<NewBadge isNew={true} />);
    expect(screen.getByLabelText('تراکنش تازه')).toBeTruthy();
    expect(screen.getByText('تازه')).toBeTruthy();
  });

  it('renders with the new-badge class by default', () => {
    render(<NewBadge isNew={true} />);
    const el = screen.getByLabelText('تراکنش تازه');
    expect(el.className).toBe('new-badge');
  });

  it('appends extra className when provided', () => {
    render(<NewBadge isNew={true} className="extra" />);
    const el = screen.getByLabelText('تراکنش تازه');
    expect(el.className).toBe('new-badge extra');
  });
});
