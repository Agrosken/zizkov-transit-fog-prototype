// Tunable constants for the transit prototype — see build-transit-lines.js
// for the data-pipeline-side constants (BOUNDARY_BUFFER_KM,
// SHARED_PATH_LATERAL_DIST_M, SHARED_PATH_BEARING_TOLERANCE_DEG), which
// only affect data build, not runtime.

// Per-mode plausible-speed ceiling for GPS fix filtering (m/s). Reasoned
// from real-world top speeds + margin, same philosophy as the street
// prototype's single 15 m/s constant, but per-mode since matching is
// scoped to one known line (and therefore one known mode) at a time.
export const MAX_PLAUSIBLE_SPEED_MPS_BY_MODE = {
  tram: 20,       // 72 km/h; real top speed ~50-60 km/h + margin
  bus: 20,
  trolleybus: 20,
  train: 35,      // 126 km/h; commuter rail can exceed 100 km/h between stations
  metro: 30,      // 108 km/h; real top speed ~80-90 km/h + margin
};
export const DEFAULT_MAX_PLAUSIBLE_SPEED_MPS = 35; // fail open (most generous) if mode is somehow unknown

// A GPS fix is accepted only if its reported accuracy (radius, meters) is
// at or below this value.
export const MAX_FIX_ACCURACY_M = 30;

// A stop-to-stop segment is credited "explored" once an accepted GPS fix
// lands within this distance (meters) of the segment's DESTINATION stop
// (not just anywhere on the segment) - this is what makes "must actually
// ride through it" fall out of the rule naturally: you can't be this
// close to the far end without having traveled the segment.
export const STOP_ARRIVAL_THRESHOLD_M = 25;

// General nearest-line/point matching distance (slightly more generous
// than the street prototype's 18m, for GPS lag at transit speed).
export const MATCH_DISTANCE_M = 25;

// How many nearby stops to show in the Get On/Get Off stop picker.
export const NEARBY_STOPS_COUNT = 8;

export const MAP_CENTER = [14.4650, 50.0850];
export const MAP_ZOOM = 15;
export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

export const LINES_URL = './data/zizkov-transit-lines.geojson';
export const BOUNDARY_URL = './data/zizkov-boundary.geojson';
export const LINE_DIRECTIONS_INDEX_URL = './data/zizkov-transit-lines-index.json';

export const STORAGE_KEY = 'zizkov-transit-fog-prototype-v1';

// Mode display order (metro-and-letters vs numbered surface modes) and
// per-mode line width/z-order, reused by map.js and stops.js.
export const MODE_ORDER = ['bus', 'trolleybus', 'tram', 'train', 'metro']; // layer add order (last = on top)
export const MODE_WIDTH = {
  bus: { explored: 3, unexplored: 1.5 },
  trolleybus: { explored: 3, unexplored: 1.5 },
  tram: { explored: 4, unexplored: 2 },
  train: { explored: 5, unexplored: 2.5 },
  metro: { explored: 6, unexplored: 3 },
};
