/**
 * Deterministic mulberry32 PRNG. Same seed → same sequence.
 *
 * Used so the seed:dev script is reproducible across runs (and across
 * CI machines). No `Math.random()` ever runs in the seed path.
 */
export function rng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rand: () => number, min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}

export function pick<T>(rand: () => number, xs: readonly T[]): T {
  if (xs.length === 0) throw new Error('pick: empty array');
  return xs[Math.floor(rand() * xs.length)] as T;
}
