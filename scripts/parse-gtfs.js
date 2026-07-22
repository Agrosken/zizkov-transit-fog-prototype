// Parses the raw PID GTFS feed (data/gtfs-raw/*.txt) into a compact
// intermediate JSON (data/gtfs-parsed.json) that build-transit-lines.js
// consumes. System-wide in scope - Žižkov-specific filtering happens in
// the next script, not here.
//
// shapes.txt (3.37M rows) and stop_times.txt (1.47M rows) are too large
// to sync-parse-then-filter without holding everything in memory at once,
// so this streams both and keeps only rows relevant to each route's
// canonical (most-common) shape per direction - reduces from "every trip
// variant system-wide" down to "one representative geometry per
// route+direction", which is what "the line's route" means for this app.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { parse as parseStream } from 'csv-parse';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
const rawDir = path.join(dataDir, 'gtfs-raw');

const routeTypeMap = JSON.parse(fs.readFileSync(path.join(dataDir, 'route-type-map.json'), 'utf-8'));
const AE_ROUTE_ID = routeTypeMap._ae_exclusion.route_id;
const AE_ROUTE_SHORT_NAME = routeTypeMap._ae_exclusion.route_short_name;

function readSmallCsv(filename) {
  return parse(fs.readFileSync(path.join(rawDir, filename), 'utf-8'), { columns: true });
}

// Streams a large CSV, calling onRow for each parsed record. Returns a
// promise that resolves when done. Avoids holding the whole file's parsed
// rows in memory at once - only what onRow chooses to retain persists.
function streamCsv(filename, onRow) {
  return new Promise((resolve, reject) => {
    const filePath = path.join(rawDir, filename);
    const parser = fs.createReadStream(filePath).pipe(parseStream({ columns: true }));
    let count = 0;
    parser.on('readable', () => {
      let record;
      while ((record = parser.read()) !== null) {
        onRow(record);
        count++;
      }
    });
    parser.on('error', reject);
    parser.on('end', () => resolve(count));
  });
}

async function main() {
  console.log('Parsing routes.txt...');
  const routesRaw = readSmallCsv('routes.txt');
  const routesById = new Map();
  let excludedAE = 0;
  for (const r of routesRaw) {
    if (r.route_id === AE_ROUTE_ID || r.route_short_name === AE_ROUTE_SHORT_NAME) {
      excludedAE++;
      continue;
    }
    const mode = routeTypeMap[r.route_type];
    if (!mode) {
      console.warn(`Unknown route_type "${r.route_type}" for route ${r.route_id} (${r.route_short_name}) - skipping`);
      continue;
    }
    routesById.set(r.route_id, {
      routeId: r.route_id,
      routeShortName: r.route_short_name,
      routeLongName: r.route_long_name,
      mode,
      routeColor: r.route_color ? `#${r.route_color}` : '#888888',
      routeTextColor: r.route_text_color ? `#${r.route_text_color}` : '#FFFFFF',
    });
  }
  console.log(`Routes kept: ${routesById.size} (excluded ${excludedAE} AE row(s))`);

  console.log('Parsing trips.txt...');
  const tripsRaw = readSmallCsv('trips.txt');
  // For each (route_id, direction_id), count shape_id usage across trips
  // to find the canonical (most common) shape.
  const shapeUsageCount = new Map(); // `${routeId}|${dirId}` -> Map<shapeId, count>
  const shapeToSampleTripId = new Map(); // shapeId -> one trip_id that uses it (for stop_times lookup)
  for (const t of tripsRaw) {
    if (!routesById.has(t.route_id)) continue; // excluded route (AE or unknown type)
    const key = `${t.route_id}|${t.direction_id}`;
    if (!shapeUsageCount.has(key)) shapeUsageCount.set(key, new Map());
    const usage = shapeUsageCount.get(key);
    usage.set(t.shape_id, (usage.get(t.shape_id) || 0) + 1);
    if (!shapeToSampleTripId.has(t.shape_id)) shapeToSampleTripId.set(t.shape_id, t.trip_id);
  }

  const routeDirToShapeId = new Map(); // `${routeId}|${dirId}` -> canonical shapeId
  for (const [key, usage] of shapeUsageCount) {
    let bestShape = null, bestCount = -1;
    for (const [shapeId, count] of usage) {
      if (count > bestCount) { bestCount = count; bestShape = shapeId; }
    }
    routeDirToShapeId.set(key, bestShape);
  }
  console.log(`Route+direction pairs: ${routeDirToShapeId.size}`);

  const neededShapeIds = new Set(routeDirToShapeId.values());
  const neededTripIds = new Set([...neededShapeIds].map((s) => shapeToSampleTripId.get(s)).filter(Boolean));
  console.log(`Canonical shapes needed: ${neededShapeIds.size}, representative trips needed: ${neededTripIds.size}`);

  console.log('Streaming shapes.txt (3.37M rows, this takes a bit)...');
  const shapePoints = new Map(); // shapeId -> [{lat, lon, seq, dist}]
  let shapeRowsSeen = 0;
  await streamCsv('shapes.txt', (r) => {
    shapeRowsSeen++;
    if (!neededShapeIds.has(r.shape_id)) return;
    if (!shapePoints.has(r.shape_id)) shapePoints.set(r.shape_id, []);
    shapePoints.get(r.shape_id).push({
      lat: parseFloat(r.shape_pt_lat),
      lon: parseFloat(r.shape_pt_lon),
      seq: parseInt(r.shape_pt_sequence, 10),
      distKm: r.shape_dist_traveled ? parseFloat(r.shape_dist_traveled) : null,
    });
  });
  for (const pts of shapePoints.values()) pts.sort((a, b) => a.seq - b.seq);
  console.log(`Shapes.txt: ${shapeRowsSeen} rows seen, kept points for ${shapePoints.size} shapes.`);

  console.log('Streaming stop_times.txt (1.47M rows)...');
  const stopTimesByTrip = new Map(); // tripId -> [{stopId, seq, distKm}]
  let stopTimesRowsSeen = 0;
  const referencedStopIds = new Set();
  await streamCsv('stop_times.txt', (r) => {
    stopTimesRowsSeen++;
    if (!neededTripIds.has(r.trip_id)) return;
    if (!stopTimesByTrip.has(r.trip_id)) stopTimesByTrip.set(r.trip_id, []);
    stopTimesByTrip.get(r.trip_id).push({
      stopId: r.stop_id,
      seq: parseInt(r.stop_sequence, 10),
      distKm: r.shape_dist_traveled ? parseFloat(r.shape_dist_traveled) : null,
    });
    referencedStopIds.add(r.stop_id);
  });
  for (const seq of stopTimesByTrip.values()) seq.sort((a, b) => a.seq - b.seq);
  console.log(`Stop_times.txt: ${stopTimesRowsSeen} rows seen, kept sequences for ${stopTimesByTrip.size} trips.`);

  console.log('Parsing stops.txt...');
  const stopsRaw = readSmallCsv('stops.txt');
  const stopsById = new Map();
  for (const s of stopsRaw) {
    if (!referencedStopIds.has(s.stop_id)) continue;
    stopsById.set(s.stop_id, {
      stopId: s.stop_id,
      name: s.stop_name,
      lat: parseFloat(s.stop_lat),
      lon: parseFloat(s.stop_lon),
      // PID's own station-node id - groups per-platform/per-direction
      // stop_id variants of the same physical station (e.g. "Z1P" vs
      // "Z101P" for the same station's different platforms/directions).
      // Needed because merging bidirectional segments by raw stop_id
      // fails - each direction commonly boards/alights at a different
      // platform-specific stop_id for what is physically the same stop.
      nodeId: s.asw_node_id || s.stop_id,
    });
  }
  console.log(`Stops kept: ${stopsById.size} (referenced by kept trips)`);

  const out = {
    routesById: Object.fromEntries(routesById),
    routeDirToShapeId: Object.fromEntries(routeDirToShapeId),
    shapeToSampleTripId: Object.fromEntries(shapeToSampleTripId),
    shapePoints: Object.fromEntries(shapePoints),
    stopTimesByTrip: Object.fromEntries(stopTimesByTrip),
    stopsById: Object.fromEntries(stopsById),
  };

  const outPath = path.join(dataDir, 'gtfs-parsed.json');
  fs.writeFileSync(outPath, JSON.stringify(out));
  const stat = fs.statSync(outPath);
  console.log(`Wrote ${outPath} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((e) => {
  console.error('Failed:', e);
  process.exit(1);
});
