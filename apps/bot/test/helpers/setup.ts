import { beforeAll } from 'vitest';
import { assertSchema, resetBot } from './env.js';

beforeAll(async () => {
  await assertSchema();
  await resetBot();
});
