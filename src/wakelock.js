// Requests a screen wake lock while recording so the phone doesn't lock and
// kill GPS tracking mid-walk. This is a stopgap for the Phase 0 web
// prototype — the real fix is a native app with proper background
// location (see plan notes), since browsers won't track location once the
// tab is backgrounded/hidden regardless of wake lock.
//
// Not supported in all browsers (notably iOS Safari as of recent versions
// has partial/no support) — fails silently if unavailable, callers should
// still tell users to keep the screen on manually as a fallback.

let wakeLock = null;

export function isSupported() {
  return 'wakeLock' in navigator;
}

export async function acquire() {
  if (!isSupported()) return false;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
    return true;
  } catch (e) {
    console.warn('Wake lock request failed:', e);
    return false;
  }
}

export function release() {
  if (wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
}

// The wake lock is automatically released by the browser when the tab is
// backgrounded; re-acquire it when the tab becomes visible again if we're
// still supposed to be holding it (i.e. still recording).
export function reacquireOnVisible(shouldHold) {
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && shouldHold()) {
      await acquire();
    }
  });
}
