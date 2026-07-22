import { createMap, addSegmentsLayers, addBoundaryLayer, setSegmentExplored } from './map.js';
import { startTracking, stopTracking, isTracking, isSupported } from './gps.js';
import * as wakelock from './wakelock.js';
import { createRideController } from './ride.js';
import { buildStopCatalog, findNearbyStops, linesServingStop } from './stops.js';
import { loadState, saveStateThrottled } from './storage.js';
import { downloadTransitData } from './export.js';
import { LINES_URL, BOUNDARY_URL, LINE_DIRECTIONS_INDEX_URL, NEARBY_STOPS_COUNT } from './config.js';

const getOnBtn = document.getElementById('get-on-btn');
const extraBtn = document.getElementById('extra-btn');
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

function creditSegment(segmentId) {
  if (exploredSegmentIds.has(segmentId)) return;
  exploredSegmentIds.add(segmentId);
  const idx = idToIndex.get(segmentId);
  if (idx !== undefined) setSegmentExplored(map, idx);
  refreshStats();
}

// --- Generic bottom-sheet picker: shows a list, resolves with the picked item ---
function showPicker(title, items, renderRow) {
  return new Promise((resolve) => {
    pickerTitle.textContent = title;
    pickerFilter.value = '';
    pickerBackdrop.classList.remove('hidden');

    function render(filterText) {
      pickerList.innerHTML = '';
      const lower = filterText.trim().toLowerCase();
      const filtered = lower
        ? items.filter((it) => it.searchText.toLowerCase().includes(lower))
        : items;
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
  const nearby = findNearbyStops(pos.lat, pos.lon, stopCatalog, NEARBY_STOPS_COUNT);
  const items = nearby.map((s) => ({
    value: s,
    searchText: s.name,
  }));
  return showPicker(title, items, (item) => `
    <div class="label">${item.value.name}</div>
    <div class="dist">${Math.round(item.value.distanceM)}m</div>
  `);
}

async function pickLineAtStop(stop) {
  const lines = linesServingStop(stop.nodeId, stopCatalog);
  const items = lines.map((l) => ({
    value: l,
    searchText: `${l.routeShortName} ${l.routeLongName}`,
  }));
  return showPicker(`Boarding at ${stop.name}`, items, (item) => `
    <div class="swatch" style="background:${item.value.routeColor}"></div>
    <div class="label">${item.value.routeShortName}</div>
    <div class="sub">${item.value.routeLongName}</div>
  `);
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

async function handleGetOn() {
  if (rideController.isRiding() && rideController.getRideKind() === 'normal') {
    // End the ride: pick alighting stop.
    const stop = await pickNearbyStop('Where are you getting off?');
    stopGpsForRide();
    const summary = rideController.endRide({ alightingNodeId: stop?.nodeId, alightingStopName: stop?.name });
    if (summary) {
      completedRides.push({ ...summary, wasJoker: false });
      saveStateThrottled(exploredSegmentIds, completedRides);
    }
    getOnBtn.textContent = 'Get On';
    getOnBtn.classList.remove('riding');
    extraBtn.disabled = false;
    return;
  }

  if (rideController.isRiding()) return; // a joker ride is active, ignore

  const stop = await pickNearbyStop('Where are you boarding?');
  if (!stop) return;
  const line = await pickLineAtStop(stop);
  if (!line) return;

  const ok = rideController.startNormalRide({
    routeId: line.routeId,
    routeShortName: line.routeShortName,
    mode: line.mode,
    boardingNodeId: stop.nodeId,
    boardingStopName: stop.name,
  });
  if (!ok) return;

  getOnBtn.textContent = 'Get Off';
  getOnBtn.classList.add('riding');
  extraBtn.disabled = true;
  startGpsForRide();
}

async function handleExtra() {
  if (rideController.isRiding() && rideController.getRideKind() === 'joker') {
    stopGpsForRide();
    const summary = rideController.endRide();
    extraBtn.textContent = 'Extra ride';
    extraBtn.classList.remove('riding');
    getOnBtn.disabled = false;
    if (!summary) return;

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
      });
      saveStateThrottled(exploredSegmentIds, completedRides);
      setStatus(`Attributed to ${chosen.routeShortName} (${chosen.creditableSegmentIds.length} segment(s)).`);
    }
    return;
  }

  if (rideController.isRiding()) return; // a normal ride is active, ignore

  rideController.startJokerRide();
  extraBtn.textContent = 'End extra ride';
  extraBtn.classList.add('riding');
  getOnBtn.disabled = true;
  startGpsForRide();
}

async function init() {
  if (!isSupported()) {
    setStatus('Geolocation is not supported on this device/browser.');
    getOnBtn.disabled = true;
    extraBtn.disabled = true;
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
      creditSegment(segId);
      saveStateThrottled(exploredSegmentIds, completedRides);
    },
    onStatus: setStatus,
  });

  await styleLoaded;
  addSegmentsLayers(map, segmentsGeoJSON);
  addBoundaryLayer(map, boundaryGeoJSON);
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
  extraBtn.addEventListener('click', handleExtra);
  exportBtn.addEventListener('click', () => {
    downloadTransitData({ exploredSegmentIds, completedRides, segmentFeatures });
    setStatus('Exported.');
  });
}

init();
