/**
 * What the panel is allowed to call a delivery nobody has evidence for.
 *
 * The status exists because `VERIFIED` was being written for two different
 * facts. That fix is worthless if the screen then draws both with the same
 * word, so this asserts the label rather than trusting that whoever wrote it
 * had the distinction in mind.
 */

import { describe, expect, it } from 'vitest';
import { ALL_TAB_STATES, stateLabel } from '../../src/hub/paymentReview.js';

describe('the word for «delivered, nothing confirmed»', () => {
  it('never contains «تایید» — that is the claim it exists to deny', () => {
    expect(stateLabel('FULFILLED_UNRECONCILED')).not.toContain('تایید');
  });

  it('says both halves: it was delivered, and it is not settled', () => {
    const label = stateLabel('FULFILLED_UNRECONCILED');
    expect(label).toContain('تحویل');
    expect(label).toContain('تطبیق');
  });

  it('is a different label from every other state', () => {
    const labels = ALL_TAB_STATES.map(stateLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('is one of the states the tabs enumerate', () => {
    // A state the queue can hold but the tab list omits is a row an operator
    // can never reach. `ALL_TAB_STATES` is a plain array, so the compiler will
    // not notice the omission — this does.
    expect(ALL_TAB_STATES).toContain('FULFILLED_UNRECONCILED');
  });
});
