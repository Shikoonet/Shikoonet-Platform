/**
 * Putting text on the clipboard, on the panel this actually runs on.
 *
 * `navigator.clipboard` exists only in a secure context. The panel is served
 * over TLS at the edge, but it is also opened directly on the box during a
 * deploy — `http://164.132.198.184:8788` — and there the whole API is
 * `undefined`, not a rejected promise. A copy button that silently does nothing
 * on the machine you are debugging from is worse than no button, because you
 * paste the previous clipboard and do not notice.
 *
 * So: the modern API when it is there, the `execCommand` fallback when it is
 * not, and a boolean either way. The caller shows «کپی شد» only on `true`.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied permission, or a browser that has the API and refuses it. Fall
    // through rather than give up: the old path often still works.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    // Off-screen rather than `display: none` — a hidden element cannot be
    // selected, and an unselected textarea copies an empty string.
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.setAttribute('readonly', '');
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
