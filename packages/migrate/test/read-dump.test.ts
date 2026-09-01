/**
 * `readDump` — the bound on what a compressed dump may become.
 *
 * `loadDump` checks `statSync().size`, and for a `.gz` that is the COMPRESSED
 * size. A dump that passes it can still expand to hundreds of megabytes: SQL is
 * repetitive and gzip is good at repetition. That whole payload was then
 * allocated, turned into a UTF-8 string, and handed to MySQL as one packet —
 * so the limit that exists to keep this loader inside `max_allowed_packet` was
 * being enforced against the wrong number. CodeRabbit found it on PR #42.
 *
 * No MySQL here, unlike `load.test.ts`: this asks what `readDump` returns, and
 * the answer does not involve a database.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDump } from '../src/load.js';

const dirs: string[] = [];
const tmpFile = (name: string, bytes: Buffer) => {
  const dir = mkdtempSync(join(tmpdir(), 'read-dump-'));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('a compressed dump', () => {
  it('is returned as its decompressed SQL', () => {
    const sql = Buffer.from("CREATE TABLE t (id int);\nINSERT INTO t VALUES (1);\n", 'utf8');
    expect(readDump(tmpFile('d.sql.gz', gzipSync(sql))).toString('utf8')).toBe(sql.toString('utf8'));
  });

  it('is refused when it expands past the packet limit', () => {
    /**
     * 49 MiB of SQL that gzips to a few kilobytes — which is the whole point.
     * The file on disk is far under the size check, so nothing before this
     * bound would have stopped it.
     */
    const huge = Buffer.alloc(49 * 1024 * 1024, 0x20);
    const packed = gzipSync(huge);
    expect(packed.length).toBeLessThan(1024 * 1024);

    expect(() => readDump(tmpFile('huge.sql.gz', packed))).toThrow(/expands to more than/);
  });

  it('refuses a file that claims to be gzip and is not', () => {
    expect(() => readDump(tmpFile('lying.sql.gz', Buffer.from('SELECT 1;', 'utf8')))).toThrow(
      /not gzip data/,
    );
  });

  it('passes a plain .sql file through untouched', () => {
    const sql = Buffer.from('SELECT 1;', 'utf8');
    expect(readDump(tmpFile('plain.sql', sql))).toEqual(sql);
  });
});
