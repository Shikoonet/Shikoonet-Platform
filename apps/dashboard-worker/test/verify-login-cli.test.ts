import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/verifyLogin.ts', import.meta.url));

function run(args: string[], envName?: string) {
  const env = { ...process.env };
  delete env['DATABASE_URL'];
  if (envName === undefined) delete env['ENV_NAME'];
  else env['ENV_NAME'] = envName;
  return spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
    env,
    encoding: 'utf8',
  });
}

describe('verify-login CLI guards', () => {
  it('refuses --env without a value before opening a database', () => {
    const result = run(['--env']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--env requires an environment name');
    expect(result.stderr).not.toContain('DATABASE_URL is required');
  });

  it.each([undefined, ''])('refuses a missing ENV_NAME (%s)', (envName) => {
    const result = run([], envName);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('this creates and deletes an ADMIN row');
    expect(result.stderr).not.toContain('DATABASE_URL is required');
  });

  it('routes every HTTP request through the finite-deadline wrapper', () => {
    const source = readFileSync(script, 'utf8');
    expect(source.match(/\bfetch\(/g)).toHaveLength(1);
    expect(source).toContain('signal: AbortSignal.timeout(10_000)');
    expect(source.match(/\brequest\(/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
