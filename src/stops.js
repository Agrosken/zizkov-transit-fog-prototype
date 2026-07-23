// Builds a stop catalog from the loaded segments GeoJSON (every segment's
// fromStop/toStop carries a `nodeId` - PID's station-node id, grouping
// per-platform stop_id variants of the same physical station) and
// provides the two lookups the Get On/Get Off UI needs: nearby stops
// ordered by distance, and which lines regularly serve a given stop.

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

export function buildStopCatalog(segmentsGeoJSON) {
  const stopsByNode = new Map(); // nodeId -> {nodeId, name, lat, lon, lines: Map<lineKey, lineInfo>}

  function touch(stop, segProps) {
    if (!stopsByNode.has(stop.nodeId)) {
      stopsByNode.set(stop.nodeId, { nodeId: stop.nodeId, name: stop.name, lat: stop.lat, lon: stop.lon, lines: new Map() });
    }
    const entry = stopsByNode.get(stop.nodeId);
    const lineKey = `${segProps.routeId}|${segProps.mode}`;
    if (!entry.lines.has(lineKey)) {
      entry.lines.set(lineKey, {
        routeId: segProps.routeId,
        mode: segProps.mode,
        routeShortName: segProps.routeShortName,
        routeLongName: segProps.routeLongName,
        routeColor: segProps.routeColor,
      });
    }
  }

  for (const feature of segmentsGeoJSON.features) {
    const p = feature.properties;
    touch(p.fromStop, p);
    touch(p.toStop, p);
  }

  return stopsByNode;
}

export function findNearbyStops(userLat, userLon, stopCatalog, count) {
  const withDist = [...stopCatalog.values()].map((s) => ({
    ...s,
    distanceM: haversineMeters({ lat: userLat, lon: userLon }, s),
  }));
  withDist.sort((a, b) => a.distanceM - b.distanceM);
  return withDist.slice(0, count);
}

// Full catalog, sorted by name rather than distance - the fallback for when
// the nearest-N list doesn't contain the stop the user actually wants
// (weak/wrong GPS fix). Distance is still attached (from whatever position
// we have) since it's cheap and mildly useful, but sort order favors
// findability-by-name over proximity here.
export function allStopsSorted(userLat, userLon, stopCatalog) {
  const withDist = [...stopCatalog.values()].map((s) => ({
    ...s,
    distanceM: haversineMeters({ lat: userLat, lon: userLon }, s),
  }));
  withDist.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return withDist;
}

// "Alphabetically/numerically ascending, letters first" - metro letters
// (A, B, C) before numbered tram/bus/trolleybus/train lines, natural sort
// within each group so "9" sorts before "10".
export function sortLineLabels(lines) {
  const isLetterLine = (name) => /^[A-Za-z]/.test(name);
  return [...lines].sort((a, b) => {
    const aLetter = isLetterLine(a.routeShortName);
    const bLetter = isLetterLine(b.routeShortName);
    if (aLetter !== bLetter) return aLetter ? -1 : 1;
    return a.routeShortName.localeCompare(b.routeShortName, undefined, { numeric: true, sensitivity: 'base' });
  });
}

export function linesServingStop(nodeId, stopCatalog) {
  const entry = stopCatalog.get(nodeId);
  if (!entry) return [];
  return sortLineLabels([...entry.lines.values()]);
}
