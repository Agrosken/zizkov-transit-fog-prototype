// Tunable constants for the transit prototype — see build-transit-lines.js
// for the data-pipeline-side constants (BOUNDARY_BUFFER_KM,
// SHARED_PATH_LATERAL_DIST_M, SHARED_PATH_BEARING_TOLERANCE_DEG), which
// only affect data build, not runtime.

// Per-mode plausible-speed ceiling for GPS fix filtering (m/s). Raised
// from the original 20/35/30 after the first real field test: several
// genuine tram fixes measured 20.7-28.2 m/s (just over the old 20 m/s
// ceiling) and got wrongly rejected - real trams do exceed "typical
// cruising" on faster stretches, and GPS timing jitter alone pushes
// borderline cases over a tight threshold. Since the route is already
// known (one line/direction is selected before tracking starts), a wider
// ceiling costs little - the real defense against bogus jumps is the
// accuracy-margin subtraction in matching.js's filterFix, not a tight
// speed cap.
export const MAX_PLAUSIBLE_SPEED_MPS_BY_MODE = {
  tram: 30,
  bus: 30,
  trolleybus: 30,
  train: 45,
  metro: 35,
};
export const DEFAULT_MAX_PLAUSIBLE_SPEED_MPS = 45; // fail open (most generous) if mode is somehow unknown

// A GPS fix is accepted only if its reported accuracy (radius, meters) is
// at or below this value. Raised from 30m after the first field test:
// since the rider has already told the app which line/direction they're
// on, we don't need walking-app precision - occasionally confirming
// they're still moving along the expected route at a plausible speed is
// enough, and it's far more forgiving of the accuracy degradation real
// phones show when backgrounded (confirmed in the field test: accuracy
// jumped past 100-800m for several fixes after switching apps).
export const MAX_FIX_ACCURACY_M = 100;

// A stop-to-stop segment is credited "explored" once an accepted GPS fix
// lands within this distance (meters) of the segment's DESTINATION stop
// (not just anywhere on the segment) - this is what makes "must actually
// ride through it" fall out of the rule naturally: you can't be this
// close to the far end without having traveled the segment. Widened
// alongside MAX_FIX_ACCURACY_M - a looser accuracy tolerance without a
// matching arrival radius would just mean fixes get accepted but still
// never register as "arrived".
export const STOP_ARRIVAL_THRESHOLD_M = 40;

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
