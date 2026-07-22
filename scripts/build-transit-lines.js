// Consumes data/gtfs-parsed.json (system-wide, from parse-gtfs.js) and
// produces public/data/zizkov-transit-lines.geojson: one feature per
// final stop-to-stop segment, filtered to lines passing near Žižkov.
//
// Segmentation unit is stop-to-stop (not fixed-length chunks) - each
// consecutive pair of stops on a line's direction is one candidate
// segment. Where both directions of the same line share the same
// stop-pair AND travel essentially the same physical path, they're
// merged into one bidirectionally-creditable segment (most streets are
// two-way); where they genuinely diverge (different streets), they stay
// as two separately-creditable segments. Different LINES sharing a
// stop-pair are NEVER merged - that's the whole point of this app
// (riding line 5 and line 9 down the same street both count fully).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as turf from '@turf/turf';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
const publicDataDir = path.join(__dirname, '..', 'public', 'data');

const BOUNDARY_BUFFER_KM = 0.3;
const SHARED_PATH_LATERAL_DIST_M = 18;
const SHARED_PATH_BEARING_TOLERANCE_DEG = 30;

const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'gtfs-parsed.json'), 'utf-8'));
const boundary = JSON.parse(fs.readFileSync(path.join(publicDataDir, 'zizkov-boundary.geojson'), 'utf-8'));

console.log(`Buffering Žižkov boundary by ${BOUNDARY_BUFFER_KM * 1000}m...`);
const bufferedBoundary = turf.buffer(boundary, BOUNDARY_BUFFER_KM, { units: 'kilometers' });

// --- Step 1: build canonical LineStrings per (routeId, dirId), filter to Žižkov-relevant ---

function shapeToLineString(shapeId) {
  const points = parsed.shapePoints[shapeId];
  if (!points || points.length < 2) return null;
  return turf.lineString(points.map((p) => [p.lon, p.lat]));
}

const relevantRouteDirs = []; // {routeId, dirId, shapeId, lineString}
let totalRouteDirs = 0;

for (const [key, shapeId] of Object.entries(parsed.routeDirToShapeId)) {
  totalRouteDirs++;
  const [routeId, dirId] = key.split('|');
  if (!parsed.routesById[routeId]) continue; // excluded (AE / unknown type)
  const lineString = shapeToLineString(shapeId);
  if (!lineString) continue;
  let intersects;
  try {
    intersects = turf.booleanIntersects(bufferedBoundary, lineString);
  } catch (e) {
    continue; // degenerate geometry
  }
  if (intersects) {
    relevantRouteDirs.push({ routeId, dirId, shapeId, lineString });
  }
}

console.log(`Route+direction pairs: ${totalRouteDirs} total, ${relevantRouteDirs.length} intersect the buffered Žižkov boundary.`);

const modeCounts = {};
for (const rd of relevantRouteDirs) {
  const mode = parsed.routesById[rd.routeId].mode;
  modeCounts[mode] = (modeCounts[mode] || 0) + 1;
}
console.log('By mode (route+direction count):', modeCounts);

// --- Step 2: build stop-to-stop legs per relevant route+direction ---

function sliceShapeByDistance(shapeId, fromDistKm, toDistKm, fallbackFromLatLon, fallbackToLatLon) {
  const points = parsed.shapePoints[shapeId] || [];
  const [minDist, maxDist] = fromDistKm <= toDistKm ? [fromDistKm, toDistKm] : [toDistKm, fromDistKm];
  const withDist = points.filter((p) => p.distKm !== null);
  if (withDist.length >= 2 && minDist !== null && maxDist !== null) {
    const inRange = withDist.filter((p) => p.distKm >= minDist - 0.001 && p.distKm <= maxDist + 0.001);
    if (inRange.length >= 2) {
      const coords = inRange.map((p) => [p.lon, p.lat]);
      return fromDistKm <= toDistKm ? coords : coords.reverse();
    }
  }
  // Fallback: just the two stop endpoints as a straight 2-point line.
  return [fallbackFromLatLon, fallbackToLatLon];
}

const legs = []; // {routeId, dirId, mode, routeColor, routeTextColor, routeShortName, routeLongName, fromStop, toStop, coords, lengthM, legIndex}
const directionOrder = new Map(); // "routeId|dirId" -> [legIndex, ...] in stop-sequence order (may have gaps where a leg fell outside the boundary)

for (const rd of relevantRouteDirs) {
  const route = parsed.routesById[rd.routeId];
  const tripId = parsed.shapeToSampleTripId[rd.shapeId];
  const stopSeq = parsed.stopTimesByTrip[tripId];
  if (!stopSeq || stopSeq.length < 2) {
    console.warn(`Skipping ${rd.routeId} dir ${rd.dirId}: no usable stop sequence (trip ${tripId})`);
    continue;
  }

  for (let i = 0; i < stopSeq.length - 1; i++) {
    const s1 = stopSeq[i];
    const s2 = stopSeq[i + 1];
    const stop1 = parsed.stopsById[s1.stopId];
    const stop2 = parsed.stopsById[s2.stopId];
    if (!stop1 || !stop2) continue;
    if (s1.stopId === s2.stopId) continue; // degenerate (duplicate stop entries)

    const coords = sliceShapeByDistance(
      rd.shapeId,
      s1.distKm,
      s2.distKm,
      [stop1.lon, stop1.lat],
      [stop2.lon, stop2.lat],
    );
    if (coords.length < 2) continue;

    let lengthM;
    try {
      lengthM = turf.length(turf.lineString(coords), { units: 'kilometers' }) * 1000;
    } catch (e) {
      continue;
    }
    if (!lengthM || lengthM <= 0) continue;

    // Filter at the LEG level too, not just the parent route+direction:
    // a long-distance commuter rail line's whole shape can technically
    // "intersect" the buffered boundary at just one station near the
    // edge, while the vast majority of its individual stop-to-stop legs
    // are tens of kilometers away. Only keep legs that themselves come
    // near Žižkov.
    let legIntersects;
    try {
      legIntersects = turf.booleanIntersects(bufferedBoundary, turf.lineString(coords));
    } catch (e) {
      continue;
    }
    if (!legIntersects) continue;

    const legIndex = legs.length;
    legs.push({
      legIndex,
      routeId: rd.routeId,
      dirId: rd.dirId,
      mode: route.mode,
      routeColor: route.routeColor,
      routeTextColor: route.routeTextColor,
      routeShortName: route.routeShortName,
      routeLongName: route.routeLongName,
      fromStop: { stopId: stop1.stopId, nodeId: stop1.nodeId, name: stop1.name, lat: stop1.lat, lon: stop1.lon },
      toStop: { stopId: stop2.stopId, nodeId: stop2.nodeId, name: stop2.name, lat: stop2.lat, lon: stop2.lon },
      coords,
      lengthM,
    });
    const dirKey = `${rd.routeId}|${rd.dirId}`;
    if (!directionOrder.has(dirKey)) directionOrder.set(dirKey, []);
    directionOrder.get(dirKey).push(legIndex);
  }
}

console.log(`Built ${legs.length} directional stop-to-stop legs.`);

// --- Step 3: within each line (routeId), merge legs that share the same
// stop-pair AND the same physical path across directions; keep genuinely
// diverging same-stop-pair legs separate. Different lines are NEVER
// compared/merged against each other here - that grouping-by-routeId is
// what enforces "riding two overlapping lines both count fully". ---

function unorderedStopPairKey(a, b) {
  return [a, b].sort().join('~');
}

function legsAreSamePhysicalPath(legA, legB) {
  const lineA = turf.lineString(legA.coords);
  const lineB = turf.lineString(legB.coords);
  const midA = turf.along(lineA, turf.length(lineA, { units: 'kilometers' }) / 2, { units: 'kilometers' });
  const midB = turf.along(lineB, turf.length(lineB, { units: 'kilometers' }) / 2, { units: 'kilometers' });
  let distAtoB, distBtoA;
  try {
    distAtoB = turf.nearestPointOnLine(lineB, midA, { units: 'meters' }).properties.dist;
    distBtoA = turf.nearestPointOnLine(lineA, midB, { units: 'meters' }).properties.dist;
  } catch (e) {
    return false;
  }
  const lateralDist = Math.max(distAtoB, distBtoA);
  if (lateralDist > SHARED_PATH_LATERAL_DIST_M) return false;

  const bearingA = ((turf.bearing(legA.coords[0], legA.coords[legA.coords.length - 1]) % 180) + 180) % 180;
  const bearingB = ((turf.bearing(legB.coords[0], legB.coords[legB.coords.length - 1]) % 180) + 180) % 180;
  const bearingDiff = Math.min(Math.abs(bearingA - bearingB), 180 - Math.abs(bearingA - bearingB));
  return bearingDiff <= SHARED_PATH_BEARING_TOLERANCE_DEG;
}

// Group legs by (routeId, unordered stop-pair) - using each stop's
// station-*node* id, not its raw stop_id. PID's GTFS assigns a distinct
// stop_id per platform/direction at the same physical station (e.g.
// "Z1P" vs "Z101P" for the same station), so grouping by raw stop_id
// would never recognize the same physical station pair across two
// directions and every bidirectional street would wrongly stay split.
const legGroups = new Map(); // key -> legs[]
for (const leg of legs) {
  const key = `${leg.routeId}|${unorderedStopPairKey(leg.fromStop.nodeId, leg.toStop.nodeId)}`;
  if (!legGroups.has(key)) legGroups.set(key, []);
  legGroups.get(key).push(leg);
}

const finalSegments = [];
const legIndexToSegmentId = new Map(); // for reconstructing per-direction ordered segment sequences
let sharedCount = 0, splitCount = 0;
let segmentIdCounter = 0;

for (const group of legGroups.values()) {
  if (group.length === 1) {
    const leg = group[0];
    const segmentId = `S${segmentIdCounter++}`;
    finalSegments.push({
      segmentId,
      lineId: `${leg.routeId}-${leg.dirId}`,
      bidirectional: false,
      ...legToProps(leg),
    });
    legIndexToSegmentId.set(leg.legIndex, segmentId);
    continue;
  }

  // 2+ legs sharing this stop-pair (normally exactly 2, one per direction).
  // Pairwise-check; merge any that match, keep the rest separate.
  //
  // Metro is always force-merged, skipping the geometric same-path check:
  // both directions run in the same tunnel, there's nothing to see or
  // explore differently between them (no "different street" the way a
  // surface divided-road split matters), so splitting by direction would
  // just be pointless complexity - keep it simple, bidirectional always.
  const isMetro = group[0].mode === 'metro';
  const merged = new Array(group.length).fill(false);
  for (let i = 0; i < group.length; i++) {
    if (merged[i]) continue;
    let mergedWithAny = false;
    for (let j = i + 1; j < group.length; j++) {
      if (merged[j]) continue;
      if (isMetro || legsAreSamePhysicalPath(group[i], group[j])) {
        const segmentId = `S${segmentIdCounter++}`;
        finalSegments.push({
          segmentId,
          lineId: group[i].routeId, // shared - not tied to one direction
          bidirectional: true,
          ...legToProps(group[i]),
        });
        legIndexToSegmentId.set(group[i].legIndex, segmentId);
        legIndexToSegmentId.set(group[j].legIndex, segmentId);
        merged[i] = true;
        merged[j] = true;
        mergedWithAny = true;
        sharedCount++;
        break;
      }
    }
    if (!mergedWithAny && !merged[i]) {
      const segmentId = `S${segmentIdCounter++}`;
      finalSegments.push({
        segmentId,
        lineId: `${group[i].routeId}-${group[i].dirId}`,
        bidirectional: false,
        ...legToProps(group[i]),
      });
      legIndexToSegmentId.set(group[i].legIndex, segmentId);
      merged[i] = true;
      splitCount++;
    }
  }
}

function legToProps(leg) {
  return {
    routeId: leg.routeId,
    mode: leg.mode,
    routeColor: leg.routeColor,
    routeTextColor: leg.routeTextColor,
    routeShortName: leg.routeShortName,
    routeLongName: leg.routeLongName,
    fromStop: leg.fromStop,
    toStop: leg.toStop,
    lengthM: Math.round(leg.lengthM * 10) / 10,
    coords: leg.coords,
  };
}

console.log(`Final segments: ${finalSegments.length} (${sharedCount} merged bidirectional, ${splitCount} kept as separate directional legs, ${legGroups.size - sharedCount - splitCount} single-direction-only groups)`);

const geojson = {
  type: 'FeatureCollection',
  features: finalSegments.map((seg) => ({
    type: 'Feature',
    properties: {
      segmentId: seg.segmentId,
      lineId: seg.lineId,
      routeId: seg.routeId,
      mode: seg.mode,
      routeColor: seg.routeColor,
      routeTextColor: seg.routeTextColor,
      routeShortName: seg.routeShortName,
      routeLongName: seg.routeLongName,
      fromStop: seg.fromStop,
      toStop: seg.toStop,
      lengthM: seg.lengthM,
      bidirectional: seg.bidirectional,
    },
    geometry: { type: 'LineString', coordinates: seg.coords },
  })),
};

fs.mkdirSync(publicDataDir, { recursive: true });
fs.writeFileSync(path.join(publicDataDir, 'zizkov-transit-lines.geojson'), JSON.stringify(geojson));

const totalLengthM = finalSegments.reduce((s, seg) => s + seg.lengthM, 0);
console.log(`Wrote zizkov-transit-lines.geojson: ${finalSegments.length} segments, ${(totalLengthM / 1000).toFixed(1)} km total.`);

const byModeLength = {};
for (const seg of finalSegments) byModeLength[seg.mode] = (byModeLength[seg.mode] || 0) + seg.lengthM;
console.log('Length by mode (km):', Object.fromEntries(Object.entries(byModeLength).map(([k, v]) => [k, (v / 1000).toFixed(1)])));

// --- Step 4: per-direction ordered segment/stop sequences, for ride.js to
// walk forward from a boarding stop and know "what's next" - reconstructed
// from directionOrder (leg indices in stop-sequence order, built in Step 2)
// mapped through legIndexToSegmentId (built during the merge/split pass). ---

const segmentById = new Map(finalSegments.map((s) => [s.segmentId, s]));
const legByIndex = new Map(legs.map((l) => [l.legIndex, l]));
const lineDirections = {}; // "routeId|dirId" -> {routeId, dirId, mode, routeShortName, routeLongName, orderedSegmentIds, orderedStops}

for (const [dirKey, legIndices] of directionOrder) {
  const [routeId, dirId] = dirKey.split('|');
  const orderedSegmentIds = legIndices.map((li) => legIndexToSegmentId.get(li)).filter(Boolean);
  if (orderedSegmentIds.length === 0) continue;

  // Use each ORIGINAL leg's own fromStop/toStop (this direction's actual
  // travel order), not the final segment's stored fromStop/toStop - a
  // shared/merged segment's stored direction reflects whichever leg
  // happened to create it, which may be the opposite direction from the
  // one being walked here.
  const orderedStops = [];
  for (const li of legIndices) {
    const leg = legByIndex.get(li);
    if (!leg) continue;
    if (orderedStops.length === 0) orderedStops.push(leg.fromStop);
    orderedStops.push(leg.toStop);
  }

  const first = segmentById.get(orderedSegmentIds[0]);
  lineDirections[dirKey] = {
    routeId,
    dirId: Number(dirId),
    mode: first.mode,
    routeShortName: first.routeShortName,
    routeLongName: first.routeLongName,
    orderedSegmentIds,
    orderedStops,
  };
}

fs.writeFileSync(
  path.join(publicDataDir, 'zizkov-transit-lines-index.json'),
  JSON.stringify(lineDirections),
);
console.log(`Wrote zizkov-transit-lines-index.json: ${Object.keys(lineDirections).length} direction sequences.`);
