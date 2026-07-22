// Thin wrapper around navigator.geolocation.watchPosition. Emits raw fixes;
// filtering/matching logic lives in matching.js, kept separate on purpose.

let watchId = null;

export function isSupported() {
  return 'geolocation' in navigator;
}

export function startTracking(onFix, onError) {
  if (watchId !== null) return; // already tracking
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      onFix({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        timestamp: pos.timestamp,
      });
    },
    (err) => onError && onError(err),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 },
  );
}

export function stopTracking() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

export function isTracking() {
  return watchId !== null;
}
