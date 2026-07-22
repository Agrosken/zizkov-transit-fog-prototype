// Persists explored-segment state and ride history to localStorage.
// perLine stats are deliberately NOT stored redundantly - they're derived
// from completedRides + segment data on read, avoiding a second source of
// truth that could drift out of sync.

import { STORAGE_KEY } from './config.js';

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { exploredSegmentIds: [], completedRides: [] };
    const parsed = JSON.parse(raw);
    return {
      exploredSegmentIds: Array.isArray(parsed.exploredSegmentIds) ? parsed.exploredSegmentIds : [],
      completedRides: Array.isArray(parsed.completedRides) ? parsed.completedRides : [],
    };
  } catch (e) {
    console.warn('Failed to load saved state, starting fresh.', e);
    return { exploredSegmentIds: [], completedRides: [] };
  }
}

let saveTimer = null;

export function saveStateThrottled(exploredSegmentIds, completedRides) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveState(exploredSegmentIds, completedRides), 1000);
}

export function saveState(exploredSegmentIds, completedRides) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ exploredSegmentIds: [...exploredSegmentIds], completedRides }),
    );
  } catch (e) {
    console.warn('Failed to save state (storage full?).', e);
  }
}

export function clearState() {
  localStorage.removeItem(STORAGE_KEY);
}
