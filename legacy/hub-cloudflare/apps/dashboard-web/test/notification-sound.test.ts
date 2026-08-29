/**
 * Notification sound preference + ding helper.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  isNotificationSoundMuted,
  playNotificationDing,
  setNotificationSoundMuted,
} from '../src/notificationSound.js';

describe('notificationSound', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to sound on', () => {
    expect(isNotificationSoundMuted()).toBe(false);
  });

  it('persists mute preference', () => {
    setNotificationSoundMuted(true);
    expect(isNotificationSoundMuted()).toBe(true);
    setNotificationSoundMuted(false);
    expect(isNotificationSoundMuted()).toBe(false);
  });

  it('does not throw when audio is unavailable', () => {
    expect(() => playNotificationDing()).not.toThrow();
  });

  it('returns early when muted without playing', () => {
    setNotificationSoundMuted(true);
    expect(() => playNotificationDing()).not.toThrow();
    expect(isNotificationSoundMuted()).toBe(true);
  });
});
