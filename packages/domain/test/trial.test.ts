import { describe, expect, it } from 'vitest';
import {
  deliverableTrialFor,
  newPublicId,
  supportTrialFor,
  trialQuota,
} from '../src/trial.js';

describe('trialQuota — the shop-wide allowance', () => {
  it('reads a missing or unusable value as the default of one', () => {
    expect(trialQuota(null)).toBe(1);
    expect(trialQuota(-1)).toBe(1);
    expect(trialQuota(1.5)).toBe(1);
  });
  it('keeps zero, because zero means «no trials anywhere»', () => {
    expect(trialQuota(0)).toBe(0);
  });
  it('caps a mistyped number at ten', () => {
    expect(trialQuota(3)).toBe(3);
    expect(trialQuota(99)).toBe(10);
  });
});

describe('supportTrialFor — the support door has its own switch', () => {
  const numbers = { trial_volume_gb: 0.2, trial_duration_hours: 2 };
  it('is on only when its switch is literally true and both numbers are usable', () => {
    expect(supportTrialFor({ ...numbers, support_trial_enabled: true }).enabled).toBe(true);
    expect(supportTrialFor({ ...numbers, support_trial_enabled: 'true' }).enabled).toBe(false);
    expect(supportTrialFor({ support_trial_enabled: true, trial_volume_gb: 0.2 }).enabled).toBe(false);
  });
  it('does not care what the shop switch says', () => {
    const cfg = { ...numbers, support_trial_enabled: true, trial_enabled: false };
    expect(supportTrialFor(cfg)).toEqual({ enabled: true, volumeGb: 0.2, durationHours: 2 });
  });
});

describe('deliverableTrialFor — what the delivery sweep may build', () => {
  const numbers = { trial_volume_gb: 1, trial_duration_hours: 12 };
  it('prefers the shop trial', () => {
    expect(deliverableTrialFor({ ...numbers, trial_enabled: true }).enabled).toBe(true);
  });
  it('falls back to the support switch', () => {
    expect(deliverableTrialFor({ ...numbers, support_trial_enabled: true }).enabled).toBe(true);
  });
  it('refuses when neither door is open', () => {
    expect(deliverableTrialFor(numbers).enabled).toBe(false);
  });
});

describe('newPublicId', () => {
  it('is ten hex characters, the shape payments already use', () => {
    expect(newPublicId()).toMatch(/^[0-9a-f]{10}$/);
  });
});
