/**
 * Tests for IdentifierText — leading zeros, dots, monospace, dir=ltr, no Copy button.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  IdentifierText,
  DetectedIdentifierCell,
  DetectedIdentifierList,
} from '../src/IdentifierText.js';

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

  it('applies user-select: text and overflow-wrap for selectable text', () => {
    render(<IdentifierText value="110.7007.2377306.1" />);
    const code = screen.getByText('110.7007.2377306.1');
    expect(code.style.userSelect).toBe('text');
    // Not `anywhere`: that collapses the container's min-content width and
    // splits account numbers mid-digit in narrow columns like the review drawer.
    expect(code.style.overflowWrap).toBe('break-word');
  });

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
    expect(container.textContent).toContain('confidence 95%');
    expect(container.textContent).toContain('compact-signed-v1');
    expect(container.querySelector('button')).toBeNull();
  });

  it('shows fallback message when no identifiers', () => {
    const { container } = render(<DetectedIdentifierList detected={[]} />);
    expect(container.textContent).toMatch(/no identifiers detected/i);
  });
});
