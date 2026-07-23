// GPS fix filtering + ride-tracking logic for the transit prototype.
//
// Unlike the street prototype (nearest-segment-across-the-whole-network
// per fix), tracking here is always scoped to ONE line-direction the
// rider is currently "on" (per Get On), walked forward through its
// ordered stop-to-stop segments - see ride.js for the state machine that
// uses this module.

import * as turf from '@turf/turf';
import {
  MAX_FIX_ACCURACY_M,
  MAX_PLAUSIBLE_SPEED_MPS_BY_MODE,
  DEFAULT_MAX_PLAUSIBLE_SPEED_MPS,
  STOP_ARRIVAL_THRESHOLD_M,
} from './config.js';

export function filterFix(fix, lastAccepted, mode) {
  if (fix.accuracy > MAX_FIX_ACCURACY_M) {
    return { accepted: false, reason: `accuracy ${Math.round(fix.accuracy)}m > ${MAX_FIX_ACCURACY_M}m` };
  }

  if (lastAccepted) {
    const dtSeconds = (fix.timestamp - lastAccepted.timestamp) / 1000;
    if (dtSeconds > 0) {
      const distM = haversineMeters(lastAccepted, fix);
      // Subtract both fixes' own reported accuracy radii before computing
      // speed - two fixes can legitimately be MAX_FIX_ACCURACY_M apart
      // from GPS noise alone even when barely moving. Without this, one
      // merely-imprecise (but still "accepted") fix becomes a bad anchor
      // that makes every genuinely-good fix after it look like a jump,
      // compounding indefinitely - confirmed in a real field test export
      // where a 28m-accuracy fix caused the next two real fixes to be
      // rejected as "140 m/s" and "45 m/s".
      const effectiveDistM = Math.max(0, distM - fix.accuracy - lastAccepted.accuracy);
      const speedMps = effectiveDistM / dtSeconds;
      const ceiling = MAX_PLAUSIBLE_SPEED_MPS_BY_MODE[mode] ?? DEFAULT_MAX_PLAUSIBLE_SPEED_MPS;
      if (speedMps > ceiling) {
        return { accepted: false, reason: `implausible speed ${speedMps.toFixed(1)} m/s for mode ${mode}` };
      }
    }
  }

  return { accepted: true };
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Distance in meters from a fix to a given stop {lat, lon}.
export function distanceToStop(fix, stop) {
  return haversineMeters(fix, { lat: stop.lat, lon: stop.lon });
}

// Credits the current segment (in an active ride) once a fix lands
// within STOP_ARRIVAL_THRESHOLD_M of the segment's destination stop for
// THIS direction of travel - "must have ridden through it" falls out of
// this naturally, since you can't be this close to the far end without
// having traveled the segment (given the segment's real length and the
// per-mode speed/accuracy filtering already applied to fixes).
export function isNearDestinationStop(fix, destinationStop) {
  return distanceToStop(fix, destinationStop) <= STOP_ARRIVAL_THRESHOLD_M;
}

// --- Full-catalog matching, used only by the Joker/Extra-ride post-ride
// pass (ride.js) - reused from the street prototype's grid-bucket spatial
// index pattern, since that pass needs to search ALL segments (not just
// one active line), but only runs once per ride (on Get Off), not per
// live GPS fix, so performance is far less critical than the street
// prototype's real-time hot path. ---

const CELL_SIZE_DEG = 0.001; // ~111m latitude

export function buildSpatialIndex(segmentFeatures) {
  const index = new Map();
  const addToCell = (gx, gy, segIndex) => {
    const key = `${gx},${gy}`;
    let set = index.get(key);
    if (!set) { set = new Set(); index.set(key, set); }
    set.add(segIndex);
  };
  segmentFeatures.forEach((feature, segIndex) => {
    const coords = feature.geometry.coordinates;
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lon, lat] of coords) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    const gxMin = Math.floor(minLon / CELL_SIZE_DEG), gxMax = Math.floor(maxLon / CELL_SIZE_DEG);
    const gyMin = Math.floor(minLat / CELL_SIZE_DEG), gyMax = Math.floor(maxLat / CELL_SIZE_DEG);
    for (let gx = gxMin; gx <= gxMax; gx++) {
      for (let gy = gyMin; gy <= gyMax; gy++) addToCell(gx, gy, segIndex);
    }
  });
  return index;
}

function candidateIndices(spatialIndex, lon, lat) {
  const gx = Math.floor(lon / CELL_SIZE_DEG), gy = Math.floor(lat / CELL_SIZE_DEG);
  const candidates = new Set();
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const set = spatialIndex.get(`${gx + dx},${gy + dy}`);
      if (set) for (const idx of set) candidates.add(idx);
    }
  }
  return candidates;
}

// For each segment, what fraction of the ride's raw trace passed within
// MATCH_DISTANCE_M of it - used by the Joker flow to rank candidate lines
// by how much of the actual ride overlapped each one, not just whether
// any single point matched.
export function scoreSegmentsAgainstTrace(trace, segmentFeatures, spatialIndex, matchDistanceM) {
  const hitCounts = new Map(); // segIndex -> count of trace points within threshold
  for (const fix of trace) {
    const point = turf.point([fix.lon, fix.lat]);
    const candidates = candidateIndices(spatialIndex, fix.lon, fix.lat);
    for (const idx of candidates) {
      let dist;
      try {
        dist = turf.nearestPointOnLine(segmentFeatures[idx], point, { units: 'meters' }).properties.dist;
      } catch (e) {
        continue;
      }
      if (dist <= matchDistanceM) {
        hitCounts.set(idx, (hitCounts.get(idx) || 0) + 1);
      }
    }
  }
  return hitCounts; // segIndex -> hit count, caller ranks/filters
}

// Used once, at ride start, to infer direction: given the boarding stop's
// two candidate onward segments (one per direction the line could be
// going), pick whichever direction's destination stop the first few
// post-boarding fixes are moving toward (closer over time), rather than
// asking the rider to pick a direction manually.
export function pickLikelyDirection(recentFixes, candidateDirections) {
  // candidateDirections: [{ dirKey, nextStop }] - nextStop is the stop
  // after the boarding stop in that direction's sequence.
  if (recentFixes.length < 2 || candidateDirections.length === 0) return null;
  if (candidateDirections.length === 1) return candidateDirections[0].dirKey;

  let best = null, bestScore = -Infinity;
  for (const cand of candidateDirections) {
    const first = distanceToStop(recentFixes[0], cand.nextStop);
    const last = distanceToStop(recentFixes[recentFixes.length - 1], cand.nextStop);
    const closingSpeed = first - last; // positive = getting closer to this direction's next stop
    if (closingSpeed > bestScore) {
      bestScore = closingSpeed;
      best = cand.dirKey;
    }
  }
  return best;
}
