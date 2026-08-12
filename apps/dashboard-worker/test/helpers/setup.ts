/**
 * Restores the isolation the Cloudflare test pool used to provide.
 *
 * Each test file ran against its own fresh D1; now every file shares one
 * Postgres, so fixtures with fixed device codes collide across files. Vitest
 * runs a setup file's hooks once per test file and before the file's own
 * `beforeAll`, which is exactly the old semantics: empty database, then seed.
 */

import { beforeAll } from 'vitest';
import { resetHub } from './env.js';

beforeAll(resetHub);
