/**
 * The two settings that were strings in the source until 2026-08-14.
 *
 * `ALLOWED_ORIGINS` named a `.workers.dev` hostname, and `DEFAULT_INGEST_URL`
 * named another — both of which stop being ours the day the platform moves,
 * which is the deploy they were blocking (`docs/STATUS.md`, switch blockers).
 *
 * The assertions are about the direction each one fails in. A missing origins
 * list must lock the second host OUT rather than let an unknown one in; a
 * missing ingest URL must refuse to issue a relay configuration rather than
 * hand an admin one that points somewhere dead. A phone posting its SMS at a
 * host that is no longer ours looks configured and delivers nothing.
 */

import { describe, expect, it } from 'vitest';
import { ingestUrl } from '../src/index.js';
import { allowedOrigins } from '../src/security.js';

describe('the origins allowed to post from elsewhere', () => {
  it('keeps the development servers and nothing else when unset', () => {
    for (const configured of [undefined, '', '   ', ',,']) {
      const origins = allowedOrigins(configured);
      expect([...origins].sort()).toEqual(['http://localhost:5173', 'http://localhost:8787']);
      // Specifically: the host this used to name is not welcome by default.
      expect(origins.has('https://dashboard-worker.samsos.workers.dev')).toBe(false);
    }
  });

  it('takes a comma-separated list, trimmed', () => {
    const origins = allowedOrigins(' https://panel.example.com , https://other.example.com ');
    expect(origins.has('https://panel.example.com')).toBe(true);
    expect(origins.has('https://other.example.com')).toBe(true);
  });

  it('does not accept an origin by accident of whitespace', () => {
    const origins = allowedOrigins('https://panel.example.com');
    expect(origins.has(' https://panel.example.com')).toBe(false);
    expect(origins.has('https://panel.example.com/')).toBe(false);
  });
});

describe('where the relay posts', () => {
  it('is null until somebody sets it', () => {
    expect(ingestUrl({})).toBeNull();
    expect(ingestUrl({ INGEST_URL: '' })).toBeNull();
    expect(ingestUrl({ INGEST_URL: '   ' })).toBeNull();
  });

  it('is whatever was set, trimmed', () => {
    expect(ingestUrl({ INGEST_URL: ' https://sms.example.com/api/v1/sms ' })).toBe(
      'https://sms.example.com/api/v1/sms',
    );
  });
});
