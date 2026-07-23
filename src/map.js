// MapLibre GL setup. A SINGLE source holds every line's every segment
// (no per-mode/per-line sources needed - answers "do we really need 5
// sources" - no); per-mode visual differentiation (width, z-order) comes
// from multiple LAYERS reading that one source, each filtered by the
// `mode` property. Explored state uses feature-state exactly like the
// street prototype's setFeatureState/generateId pattern.

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MAP_CENTER, MAP_ZOOM, MAP_STYLE_URL, MODE_ORDER, MODE_WIDTH } from './config.js';

const SEGMENTS_SOURCE_ID = 'transit-segments';
const TRACK_SOURCE_ID = 'raw-track';
const TRACK_LAYER_ID = 'raw-track-layer';
const BOUNDARY_SOURCE_ID = 'boundary';
const BOUNDARY_LAYER_ID = 'boundary-layer';
const STOPS_SOURCE_ID = 'transit-stops';
const STOPS_LAYER_ID = 'transit-stops-layer';

export function createMap() {
  const map = new maplibregl.Map({
    container: 'map',
    style: MAP_STYLE_URL,
    center: MAP_CENTER,
    zoom: MAP_ZOOM,
  });

  // Built-in location dot + auto-follow + recenter button, rather than
  // hand-rolling one: trackUserLocation keeps the map centered on the user
  // until they pan away, and clicking the same control button again
  // resumes centering - exactly the "auto-center unless manually moved,
  // with a recenter button" behavior asked for.
  // maximumAge tolerates a slightly-stale cached position instead of
  // forcing a fresh GPS read every time - reduces how often the control
  // re-centers the camera, which is the likely cause of the map-label
  // flicker seen in the first field test (MapLibre recalculates label
  // collision on every camera move; continuous auto-follow means that's
  // every single position update). Not a full fix - if labels still
  // flicker after this, the next step is disabling continuous auto-follow
  // entirely in favor of center-once-per-tap.
  const geolocate = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true, maximumAge: 5000 },
    trackUserLocation: true,
    showUserHeading: true,
  });
  // Swallow errors here on purpose: no permission / no hardware / denied
  // must never break map init (an uncaught throw inside a 'load' listener
  // can abort MapLibre's dispatch to listeners registered after this one).
  geolocate.on('error', () => {});
  map.addControl(geolocate, 'top-right');
  map.on('load', () => {
    try { geolocate.trigger(); } catch { /* no geolocation available - fine, control still works manually */ }
  });

  return map;
}

export function addSegmentsLayers(map, segmentsGeoJSON) {
  map.addSource(SEGMENTS_SOURCE_ID, {
    type: 'geojson',
    data: segmentsGeoJSON,
    generateId: true,
  });

  // Layer add order = MODE_ORDER (last added draws on top). One layer per
  // mode, each filtered to only that mode's features from the single
  // shared source.
  for (const mode of MODE_ORDER) {
    const width = MODE_WIDTH[mode] || { explored: 3, unexplored: 1.5 };
    map.addLayer({
      id: `segments-${mode}`,
      type: 'line',
      source: SEGMENTS_SOURCE_ID,
      filter: ['==', ['get', 'mode'], mode],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': [
          'case',
          ['boolean', ['feature-state', 'explored'], false],
          ['get', 'routeColor'],
          '#8a8f98', // unexplored - uniform grey regardless of line, matches street prototype
        ],
        'line-width': [
          'case',
          ['boolean', ['feature-state', 'explored'], false],
          width.explored,
          width.unexplored,
        ],
        'line-opacity': [
          'case',
          ['boolean', ['feature-state', 'explored'], false],
          0.95,
          0.4,
        ],
      },
    });
  }

  // Debug layer: raw recorded GPS trail of the current/last ride.
  map.addSource(TRACK_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: TRACK_LAYER_ID,
    type: 'line',
    source: TRACK_SOURCE_ID,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ff5da2', 'line-width': 2, 'line-opacity': 0.6, 'line-dasharray': [1, 2] },
  });
}

// Stop markers, rendered above the line layers. Deliberately bounded, NOT
// visible at every zoom level: `minzoom` cuts the whole layer off below
// zoom 11 (city/country-wide views never render ~150 stop dots on top of
// each other), and the radius only floors at a small-but-visible 1.5px
// down to that same cutoff - the field test found stops disappearing
// entirely a bit past the app's default zoom (15), which is the actual
// gap to fix, not "visible at any zoom no matter how far out".
export function addStopsLayer(map, stopsGeoJSON) {
  map.addSource(STOPS_SOURCE_ID, { type: 'geojson', data: stopsGeoJSON });
  map.addLayer({
    id: STOPS_LAYER_ID,
    type: 'circle',
    source: STOPS_SOURCE_ID,
    minzoom: 11,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 1.5, 15, 3, 18, 6],
      'circle-color': '#ffffff',
      'circle-stroke-color': '#333333',
      'circle-stroke-width': 1,
      'circle-opacity': 0.9,
    },
  });
}

export function addBoundaryLayer(map, boundaryGeoJSON) {
  map.addSource(BOUNDARY_SOURCE_ID, { type: 'geojson', data: boundaryGeoJSON });
  map.addLayer({
    id: BOUNDARY_LAYER_ID,
    type: 'line',
    source: BOUNDARY_SOURCE_ID,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#3b82f6', 'line-width': 3, 'line-opacity': 0.9 },
  });
}

export function setSegmentExplored(map, index) {
  map.setFeatureState({ source: SEGMENTS_SOURCE_ID, id: index }, { explored: true });
}

export function updateRawTrack(map, trackPoints) {
  const source = map.getSource(TRACK_SOURCE_ID);
  if (!source) return;
  if (trackPoints.length < 2) {
    source.setData({ type: 'FeatureCollection', features: [] });
    return;
  }
  source.setData({
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: trackPoints.map((p) => [p.lon, p.lat]) },
  });
}
