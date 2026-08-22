const STORAGE_KEY = 'notificationSoundMuted';

let audioCtx: AudioContext | null = null;
let unlocked = false;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  return audioCtx;
}

/** Resume audio after a user gesture (browser autoplay policy). */
export function unlockNotificationAudio(): void {
  const ctx = getAudioContext();
  if (!ctx || unlocked) return;
  void ctx
    .resume()
    .then(() => {
      unlocked = true;
    })
    .catch(() => {
      /* blocked — visual alerts still work */
    });
}

export function isNotificationSoundMuted(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setNotificationSoundMuted(muted: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, muted ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/** One short soft ding (~150ms), low volume. No-op when muted or blocked. */
export function playNotificationDing(): void {
  if (isNotificationSoundMuted()) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  const run = () => {
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.2);
    } catch {
      /* autoplay or context failure — silent */
    }
  };

  if (ctx.state === 'suspended') {
    void ctx
      .resume()
      .then(run)
      .catch(() => {});
  } else {
    run();
  }
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
