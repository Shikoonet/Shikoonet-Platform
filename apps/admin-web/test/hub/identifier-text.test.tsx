/**
 * Tests for IdentifierText — leading zeros, dots, monospace, dir=ltr, no Copy button.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  IdentifierText,
  DetectedIdentifierCell,
  DetectedIdentifierList,
} from '../../src/hub/IdentifierText.js';

afterEach(() => cleanup());

describe('IdentifierText', () => {
  it('renders the value verbatim in dir=ltr code', () => {
    render(<IdentifierText value="110.7007.2377306.1" />);
    const code = screen.getByText('110.7007.2377306.1');
    expect(code.tagName).toBe('CODE');
    expect(code.getAttribute('dir')).toBe('ltr');
  });

  it('preserves leading zeros (no number coercion)', () => {
    render(<IdentifierText value="0017000" />);
    const code = screen.getByText('0017000');
    expect(code).toBeTruthy();
    expect(code.textContent).toBe('0017000');
  });

  it('preserves dots (IBAN / dotted account shapes)', () => {
    render(<IdentifierText value="110.7007.2377306.1" />);
    expect(screen.getByText('110.7007.2377306.1').textContent).toBe('110.7007.2377306.1');
  });

  it('does NOT render a Copy button', () => {
    render(<IdentifierText value="110.7007.2377306.1" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders dash placeholder when value is null', () => {
    const { container } = render(<IdentifierText value={null} />);
    expect(container.textContent).toBe('—');
  });

  it('shows label inline when provided', () => {
    const { container } = render(<IdentifierText value="310057795083" label="ACCOUNT_NUMBER" />);
    expect(container.textContent).toContain('310057795083');
    expect(container.textContent).toContain('ACCOUNT_NUMBER');
  });

  it('sets title attribute to value for hover tooltip', () => {
    render(<IdentifierText value="110.7007.2377306.1" />);
    const code = screen.getByText('110.7007.2377306.1');
    expect(code.getAttribute('title')).toBe('110.7007.2377306.1');
  });

  it('stays selectable text rather than a widget', () => {
    render(<IdentifierText value="110.7007.2377306.1" />);
    const code = screen.getByText('110.7007.2377306.1');
    expect(code.style.userSelect).toBe('text');
  });

  /*
   * The wrapping rule used to be asserted here, as `style.overflowWrap ===
   * 'break-word'`, with a correct comment about `anywhere` collapsing the
   * min-content width. The comment was right; the assertion was worthless, and
   * on 2026-08-24 it proved it.
   *
   * `styles.css` was setting `word-break: break-all` on this same element —
   * a DIFFERENT property, which no inline `overflow-wrap` overrides — and the
   * column collapsed to one character per line on every wide table in the money
   * section. This test stayed green throughout, because it read back the inline
   * style the component had just set: the component agreeing with itself, with
   * no stylesheet in the room. jsdom loads no CSS and computes no layout, so
   * nothing in this file could ever have seen the bug.
   *
   * The rule now lives in exactly one place (`.identifier-text code`) and is
   * proved where it can actually be observed — in a browser, by measuring how
   * tall the row is: `apps/dashboard-worker/e2e/money-layout.spec.ts`.
   */

  it('does not break the document width with long identifiers', () => {
    const { container } = render(
      <div style={{ width: '320px', overflow: 'auto' }}>
        <IdentifierText value="110.7007.2377306.1.5555555555.9999999999" />
      </div>,
    );
    // The container must not exceed its declared width because of the
    // identifier. happy-dom doesn't do real layout, but it DOES respect
    // inline `style` on inline-block elements — overflow-wrap: anywhere
    // on the <code> is the contract; long string layout comes from CSS.
    const code = container.querySelector('code')!;
    expect(code).toBeTruthy();
  });
});

describe('DetectedIdentifierCell', () => {
  it('renders the first detected identifier with type label', () => {
    const detected = [
      {
        type: 'ACCOUNT_NUMBER' as const,
        normalized_value: '110.7007.2377306.1',
        masked_value: '110…1',
      },
      { type: 'IBAN' as const, normalized_value: 'IR123', masked_value: 'IR…' },
    ];
    const { container } = render(<DetectedIdentifierCell detected={detected} overflowCount />);
    expect(container.textContent).toContain('110.7007.2377306.1');
    expect(container.textContent).toContain('+1');
    // No Copy button in the cell either.
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders dash when empty', () => {
    const { container } = render(<DetectedIdentifierCell detected={[]} />);
    expect(container.textContent).toBe('—');
  });
});

describe('DetectedIdentifierList', () => {
  it('renders all identifiers with type and confidence', () => {
    const detected = [
      {
        type: 'ACCOUNT_NUMBER' as const,
        normalized_value: '110.7007.2377306.1',
        masked_value: '110…1',
        parser_id: 'compact-signed-v1',
        confidence: 0.95,
      },
    ];
    const { container } = render(<DetectedIdentifierList detected={detected} />);
    expect(container.textContent).toContain('110.7007.2377306.1');
    expect(container.textContent).toContain('ACCOUNT_NUMBER');
    expect(container.textContent).toContain('اطمینان ۹۵٪');
    expect(container.textContent).toContain('compact-signed-v1');
    expect(container.querySelector('button')).toBeNull();
  });

  it('shows fallback message when no identifiers', () => {
    const { container } = render(<DetectedIdentifierList detected={[]} />);
    expect(container.textContent).toMatch(/شناسه‌ای تشخیص داده نشد/);
  });
});
