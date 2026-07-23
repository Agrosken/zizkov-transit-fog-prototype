import { createMap, addSegmentsLayers, addBoundaryLayer, addStopsLayer, setSegmentExplored } from './map.js';
import { startTracking, stopTracking, isTracking, isSupported } from './gps.js';
import * as wakelock from './wakelock.js';
import { createRideController } from './ride.js';
import { buildStopCatalog, findNearbyStops, allStopsSorted, linesServingStop, stopCatalogToGeoJSON } from './stops.js';
import { loadState, saveStateThrottled } from './storage.js';
import { downloadTransitData } from './export.js';
import { LINES_URL, BOUNDARY_URL, LINE_DIRECTIONS_INDEX_URL, NEARBY_STOPS_COUNT } from './config.js';

const getOnBtn = document.getElementById('get-on-btn');
const exportBtn = document.getElementById('export-btn');
const distanceEl = document.getElementById('distance');
const lineCountEl = document.getElementById('line-count');
const statusEl = document.getElementById('status');

const pickerBackdrop = document.getElementById('picker-backdrop');
const pickerTitle = document.getElementById('picker-title');
const pickerFilter = document.getElementById('picker-filter');
const pickerList = document.getElementById('picker-list');
const pickerCancel = document.getElementById('picker-cancel');

let map;
let segmentFeatures = [];
let idToIndex = new Map();
let lineDirectionsIndex = {};
let stopCatalog = new Map();
let exploredSegmentIds = new Set();
let completedRides = [];
let rideController;

function setStatus(msg) {
  statusEl.textContent = msg;
}

function computeStats() {
  let exploredM = 0;
  for (const id of exploredSegmentIds) {
    const idx = idToIndex.get(id);
    if (idx === undefined) continue;
    exploredM += segmentFeatures[idx].properties.lengthM;
  }
  const routeIds = new Set(segmentFeatures.map((f) => f.properties.routeId));
  const startedRouteIds = new Set(
    [...exploredSegmentIds].map((id) => segmentFeatures[idToIndex.get(id)]?.properties.routeId).filter(Boolean),
  );
  return { exploredM, totalLines: routeIds.size, startedLines: startedRouteIds.size };
}

function refreshStats() {
  const { exploredM, totalLines, startedLines } = computeStats();
  distanceEl.textContent = `${(exploredM / 1000).toFixed(2)} km explored`;
  lineCountEl.textContent = `${startedLines} / ${totalLines} lines started`;
}

// Returns whether the segment was NEWLY credited (false if it was already
// explored from an earlier ride) - so a ride's own creditedSegmentIds
// summary/export only reflects what THIS ride actually added.
function creditSegment(segmentId) {
  if (exploredSegmentIds.has(segmentId)) return false;
  exploredSegmentIds.add(segmentId);
  const idx = idToIndex.get(segmentId);
  if (idx !== undefined) setSegmentExplored(map, idx);
  refreshStats();
  return true;
}

// --- Generic bottom-sheet picker: shows a list, resolves with the picked
// item. `items` is what's shown with an empty search box (e.g. nearest-N
// stops); optional `searchItems` is the larger pool the filter box searches
// once the user types something (e.g. the full stop catalog) - the full
// list never needs its own row/button, it just lives behind the search
// bar for the weak-GPS case where the wanted stop isn't nearby-sorted. ---
function showPicker(title, items, renderRow, searchItems) {
  return new Promise((resolve) => {
    pickerTitle.textContent = title;
    pickerFilter.value = '';
    pickerBackdrop.classList.remove('hidden');

    function render(filterText) {
      pickerList.innerHTML = '';
      const lower = filterText.trim().toLowerCase();
      const pool = lower && searchItems ? searchItems : items;
      const filtered = lower
        ? pool.filter((it) => it.searchText.toLowerCase().includes(lower))
        : pool;
      for (const item of filtered) {
        const row = document.createElement('div');
        row.className = 'picker-row';
        row.innerHTML = renderRow(item);
        row.addEventListener('click', () => {
          cleanup();
          resolve(item.value);
        });
        pickerList.appendChild(row);
      }
    }

    function onFilterInput() { render(pickerFilter.value); }
    function onCancel() { cleanup(); resolve(null); }

    function cleanup() {
      pickerBackdrop.classList.add('hidden');
      pickerFilter.removeEventListener('input', onFilterInput);
      pickerCancel.removeEventListener('click', onCancel);
    }

    pickerFilter.addEventListener('input', onFilterInput);
    pickerCancel.addEventListener('click', onCancel);
    render('');
  });
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      reject,
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 },
    );
  });
}

async function pickNearbyStop(title) {
  setStatus('Getting your location...');
  let pos;
  try {
    pos = await getCurrentPosition();
  } catch (e) {
    setStatus(`Location error: ${e.message}`);
    return null;
  }
  const stopToItem = (s) => ({ value: s, searchText: s.name });
  const nearby = findNearbyStops(pos.lat, pos.lon, stopCatalog, NEARBY_STOPS_COUNT);
  const items = nearby.map(stopToItem);
  const searchItems = allStopsSorted(pos.lat, pos.lon, stopCatalog).map(stopToItem);
  const renderRow = (item) => `
    <div class="label">${item.value.name}</div>
    <div class="dist">${Math.round(item.value.distanceM)}m</div>
  `;
  return showPicker(title, items, renderRow, searchItems);
}

async function pickLineAtStop(stop) {
  const lines = linesServingStop(stop.nodeId, stopCatalog);
  const items = lines.map((l) => ({
    value: l,
    searchText: `${l.routeShortName} ${l.routeLongName}`,
  }));
  // Always-available fallback for a vehicle running a line that doesn't
  // normally serve this stop (reroute, depot move, special run) - starts
  // the same GPS-path-matching flow as before ("Extra ride"), just reached
  // from here instead of a separate button, with the boarding stop already
  // known.
  items.push({
    value: { other: true },
    searchText: 'other line special extra',
  });
  return showPicker(`Boarding at ${stop.name}`, items, (item) => {
    if (item.value.other) {
      return `
        <div class="swatch" style="background:#555"></div>
        <div class="label">Other line</div>
        <div class="sub">Not usually listed here - reroute, depot move, special run</div>
      `;
    }
    return `
      <div class="swatch" style="background:${item.value.routeColor}"></div>
      <div class="label">${item.value.routeShortName}</div>
      <div class="sub">${item.value.routeLongName}</div>
    `;
  });
}

const DEVIATION_REASONS = [
  { value: 'detour', label: 'Still riding — just a detour', sub: 'Keep tracking, ask again if it keeps drifting' },
  { value: 'wrong-line', label: 'Wrong line selected', sub: 'End this ride' },
  { value: 'forgot-get-off', label: 'Forgot to press Get Off', sub: 'End this ride' },
  { value: 'wrong-assumption', label: 'Wrong assumption by the app', sub: 'End this ride' },
  { value: 'other', label: 'Something else', sub: 'End this ride' },
];

// Dismissing without picking (cancel) defaults to 'detour' - not answering
// "what happened" shouldn't itself end the ride.
async function pickDeviationReason(title) {
  const items = DEVIATION_REASONS.map((r) => ({ value: r.value, searchText: r.label }));
  const renderRow = (item) => {
    const r = DEVIATION_REASONS.find((it) => it.value === item.value);
    return `<div class="label">${r.label}</div><div class="sub">${r.sub}</div>`;
  };
  const choice = await showPicker(title, items, renderRow);
  return choice ?? 'detour';
}

async function pickJokerLine(candidates) {
  if (candidates.length === 0) {
    setStatus('No matching line found for that ride.');
    return null;
  }
  const items = candidates.map((c) => ({
    value: c,
    searchText: `${c.routeShortName}`,
  }));
  return showPicker('Which line was this?', items, (item) => `
    <div class="swatch" style="background:${item.value.routeColor}"></div>
    <div class="label">${item.value.routeShortName}</div>
    <div class="sub">${item.value.newSegmentCount} new segment(s)</div>
  `);
}

function startGpsForRide() {
  wakelock.acquire();
  startTracking(
    (fix) => rideController.onFix(fix),
    (err) => setStatus(`GPS error: ${err.message}`),
  );
}

function stopGpsForRide() {
  stopTracking();
  wakelock.release();
}

// Shared tail end of ending a ride, whether triggered by tapping Get Off or
// by answering a deviation prompt - resets the button and applies the
// ride's summary (joker attribution or straight completedRides push).
async function applyRideSummary(summary) {
  getOnBtn.textContent = 'Get On';
  getOnBtn.classList.remove('riding');

  if (summary?.kind === 'joker') {
    const candidates = rideController.findJokerCandidates(summary.rawTrack, exploredSegmentIds);
    const chosen = await pickJokerLine(candidates);
    if (chosen) {
      for (const segId of chosen.creditableSegmentIds) creditSegment(segId);
      completedRides.push({
        kind: 'joker',
        routeId: chosen.routeId,
        routeShortName: chosen.routeShortName,
        mode: chosen.mode,
        startedAt: summary.startedAt,
        endedAt: summary.endedAt,
        creditedSegmentIds: chosen.creditableSegmentIds,
        wasJoker: true,
        attributedFrom: chosen.routeId,
        boardingStopName: summary.boardingStopName,
        rawTrack: summary.rawTrack,
        fixLog: summary.fixLog,
        deviationReason: summary.deviationReason,
        // Every candidate line the trace was matched against, not just
        // the one picked - so a "my real line didn't even show up as an
        // option" report can actually be diagnosed from the export.
        candidatesConsidered: candidates.map((c) => ({
          routeId: c.routeId,
          routeShortName: c.routeShortName,
          newSegmentCount: c.newSegmentCount,
        })),
      });
      saveStateThrottled(exploredSegmentIds, completedRides);
      setStatus(`Attributed to ${chosen.routeShortName} (${chosen.creditableSegmentIds.length} segment(s)).`);
    }
  } else if (summary) {
    completedRides.push({ ...summary, wasJoker: false });
    saveStateThrottled(exploredSegmentIds, completedRides);
  }
}

// Triggered by ride.js's onDeviationSuspected - the rider is asked what
// happened; 'detour' keeps tracking, anything else ends the ride now (see
// ride.js's resolveDeviation) with the reason stamped into its summary.
async function handleDeviationPrompt(info) {
  const title = info.reason === 'end-of-line'
    ? 'Reached the end of the line — what happened?'
    : "Doesn't look like the expected route — what happened?";
  const choice = await pickDeviationReason(title);
  if (choice === 'detour') {
    rideController.resolveDeviation('detour');
    return;
  }
  stopGpsForRide();
  const summary = rideController.resolveDeviation(choice);
  await applyRideSummary(summary);
}

async function handleGetOn() {
  if (rideController.isRiding()) {
    const kind = rideController.getRideKind();

    // Normal rides ask which stop was reached; joker rides skip this and
    // rely entirely on post-hoc trace matching (see findJokerCandidates).
    let alightingStop = null;
    if (kind === 'normal') {
      alightingStop = await pickNearbyStop('Where are you getting off?');
    }
    stopGpsForRide();
    const summary = rideController.endRide(
      kind === 'normal' ? { alightingNodeId: alightingStop?.nodeId, alightingStopName: alightingStop?.name } : undefined,
    );
    await applyRideSummary(summary);
    return;
  }

  const stop = await pickNearbyStop('Where are you boarding?');
  if (!stop) return;
  const line = await pickLineAtStop(stop);
  if (!line) return;

  if (line.other) {
    rideController.startJokerRide({ boardingNodeId: stop.nodeId, boardingStopName: stop.name });
  } else {
    const ok = rideController.startNormalRide({
      routeId: line.routeId,
      routeShortName: line.routeShortName,
      mode: line.mode,
      boardingNodeId: stop.nodeId,
      boardingStopName: stop.name,
    });
    if (!ok) return;
  }

  getOnBtn.textContent = 'Get Off';
  getOnBtn.classList.add('riding');
  startGpsForRide();
}

async function init() {
  if (!isSupported()) {
    setStatus('Geolocation is not supported on this device/browser.');
    getOnBtn.disabled = true;
    return;
  }

  map = createMap();
  window.__map = map; // debug aid
  map.on('error', (e) => console.error('MapLibre error:', e.error || e));
  const styleLoaded = new Promise((resolve) => map.once('load', resolve));

  const [segmentsGeoJSON, boundaryGeoJSON, lineDirIndex] = await Promise.all([
    fetch(LINES_URL).then((r) => r.json()),
    fetch(BOUNDARY_URL).then((r) => r.json()),
    fetch(LINE_DIRECTIONS_INDEX_URL).then((r) => r.json()),
  ]);

  segmentFeatures = segmentsGeoJSON.features;
  segmentFeatures.forEach((f, i) => idToIndex.set(f.properties.segmentId, i));
  lineDirectionsIndex = lineDirIndex;
  stopCatalog = buildStopCatalog(segmentsGeoJSON);

  const saved = loadState();
  exploredSegmentIds = new Set(saved.exploredSegmentIds);
  completedRides = saved.completedRides;

  rideController = createRideController({
    lineDirectionsIndex,
    segmentFeatures,
    onSegmentCredited: (segId) => {
      const wasNew = creditSegment(segId);
      saveStateThrottled(exploredSegmentIds, completedRides);
      return wasNew;
    },
    onStatus: setStatus,
    onDeviationSuspected: handleDeviationPrompt,
  });

  await styleLoaded;
  addSegmentsLayers(map, segmentsGeoJSON);
  addBoundaryLayer(map, boundaryGeoJSON);
  addStopsLayer(map, stopCatalogToGeoJSON(stopCatalog));
  for (const id of exploredSegmentIds) {
    const idx = idToIndex.get(id);
    if (idx !== undefined) setSegmentExplored(map, idx);
  }
  refreshStats();

  wakelock.reacquireOnVisible(() => isTracking());
  if (!wakelock.isSupported()) {
    setStatus('Note: this browser has no wake-lock support — keep the screen on manually.');
  }

  getOnBtn.addEventListener('click', handleGetOn);
  exportBtn.addEventListener('click', () => {
    downloadTransitData({ exploredSegmentIds, completedRides, segmentFeatures });
    setStatus('Exported.');
  });
}

init();
