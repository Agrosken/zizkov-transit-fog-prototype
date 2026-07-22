// Get On / Get Off / Extra("Joker") ride state machine.
//
// Normal ride: board at a stop, pick a line serving it, direction is
// inferred (not asked) from the first couple of GPS fixes, then each
// stop-to-stop segment credits the moment a fix lands near its
// destination stop (see matching.js's isNearDestinationStop) - "must
// actually ride through it" falls out of that rule, not a separate
// coverage-fraction calculation.
//
// Joker ride: no line/stop pre-selection (for a depot move / non-listed
// special run). On Get Off, the recorded trace is matched post-hoc
// against every line's segments; the rider picks which real line to
// attribute it to; crediting then uses the SAME "reached both endpoints,
// in order" rule as a normal ride, so joining a route mid-segment
// naturally fails to credit that segment - no special-casing needed.

import { filterFix, isNearDestinationStop, distanceToStop, pickLikelyDirection, buildSpatialIndex, scoreSegmentsAgainstTrace } from './matching.js';
import { MATCH_DISTANCE_M, STOP_ARRIVAL_THRESHOLD_M } from './config.js';

export function createRideController({ lineDirectionsIndex, segmentFeatures, onSegmentCredited, onStatus }) {
  let activeRide = null;
  let spatialIndex = null; // built lazily, only needed for Joker matching

  function getSpatialIndex() {
    if (!spatialIndex) spatialIndex = buildSpatialIndex(segmentFeatures);
    return spatialIndex;
  }

  function findCandidateDirections(routeId, boardingNodeId) {
    const candidates = [];
    for (const key of Object.keys(lineDirectionsIndex)) {
      if (!key.startsWith(`${routeId}|`)) continue;
      const dir = lineDirectionsIndex[key];
      const pos = dir.orderedStops.findIndex((s) => s.nodeId === boardingNodeId);
      if (pos === -1 || pos >= dir.orderedStops.length - 1) continue; // not present, or it's the terminus (no onward segment)
      candidates.push({ dirKey: key, dir, startPointer: pos, nextStop: dir.orderedStops[pos + 1] });
    }
    return candidates;
  }

  function startNormalRide({ routeId, routeShortName, mode, boardingNodeId, boardingStopName }) {
    const candidates = findCandidateDirections(routeId, boardingNodeId);
    if (candidates.length === 0) {
      onStatus(`No onward route found for ${routeShortName} from ${boardingStopName} - can't start this ride.`);
      return false;
    }

    activeRide = {
      kind: 'normal',
      routeId,
      routeShortName,
      mode,
      boardingNodeId,
      boardingStopName,
      startedAt: Date.now(),
      directionLocked: candidates.length === 1,
      dirKey: candidates.length === 1 ? candidates[0].dirKey : null,
      pointer: candidates.length === 1 ? candidates[0].startPointer : null,
      candidates, // used for inference if more than one
      inferenceFixes: [],
      rawTrack: [],
      lastAcceptedFix: null,
      creditedSegmentIds: [],
    };

    if (activeRide.directionLocked) {
      onStatus(`Riding ${routeShortName} toward ${lineDirectionsIndex[activeRide.dirKey].orderedStops[activeRide.pointer + 1].name}.`);
    } else {
      onStatus(`Riding ${routeShortName} - figuring out direction...`);
    }
    return true;
  }

  function startJokerRide() {
    activeRide = {
      kind: 'joker',
      startedAt: Date.now(),
      rawTrack: [],
      lastAcceptedFix: null,
      mode: 'tram', // placeholder speed-filter category; joker rides use the most permissive check anyway via matching's default
    };
    onStatus('Recording an extra/special ride - pick a line for it when you get off.');
  }

  function onFix(fix) {
    if (!activeRide) return;
    const { accepted, reason } = filterFix(fix, activeRide.lastAcceptedFix, activeRide.mode);
    if (!accepted) {
      onStatus(`Skipped fix (${reason})`);
      return;
    }
    activeRide.lastAcceptedFix = fix;
    activeRide.rawTrack.push(fix);

    if (activeRide.kind === 'joker') return; // no live crediting for joker rides - handled post-hoc on Get Off

    if (!activeRide.directionLocked) {
      activeRide.inferenceFixes.push(fix);
      if (activeRide.inferenceFixes.length >= 2) {
        const chosenDirKey = pickLikelyDirection(
          activeRide.inferenceFixes,
          activeRide.candidates.map((c) => ({ dirKey: c.dirKey, nextStop: c.nextStop })),
        );
        const chosen = activeRide.candidates.find((c) => c.dirKey === chosenDirKey);
        if (chosen) {
          activeRide.directionLocked = true;
          activeRide.dirKey = chosen.dirKey;
          activeRide.pointer = chosen.startPointer;
          onStatus(`Direction confirmed: toward ${lineDirectionsIndex[chosen.dirKey].orderedStops[chosen.startPointer + 1].name}.`);
        }
      }
      if (!activeRide.directionLocked) return;
    }

    const dir = lineDirectionsIndex[activeRide.dirKey];
    if (activeRide.pointer >= dir.orderedSegmentIds.length) return; // reached the end of the tracked sequence

    const destinationStop = dir.orderedStops[activeRide.pointer + 1];
    if (isNearDestinationStop(fix, destinationStop)) {
      const segmentId = dir.orderedSegmentIds[activeRide.pointer];
      activeRide.creditedSegmentIds.push(segmentId);
      onSegmentCredited(segmentId);
      onStatus(`Reached ${destinationStop.name}.`);
      activeRide.pointer++;
    }
  }

  function endRide({ alightingNodeId, alightingStopName } = {}) {
    if (!activeRide) return null;

    if (activeRide.kind === 'joker') {
      const jokerRide = activeRide;
      activeRide = null;
      onStatus('Ride ended. Pick which line to credit it to.');
      return { kind: 'joker', rawTrack: jokerRide.rawTrack, startedAt: jokerRide.startedAt, endedAt: Date.now() };
    }

    const summary = {
      kind: 'normal',
      routeId: activeRide.routeId,
      routeShortName: activeRide.routeShortName,
      mode: activeRide.mode,
      boardingNodeId: activeRide.boardingNodeId,
      boardingStopName: activeRide.boardingStopName,
      alightingNodeId: alightingNodeId ?? null,
      alightingStopName: alightingStopName ?? null,
      startedAt: activeRide.startedAt,
      endedAt: Date.now(),
      creditedSegmentIds: activeRide.creditedSegmentIds,
      rawTrack: activeRide.rawTrack,
    };
    activeRide = null;
    onStatus(`Ride ended. Credited ${summary.creditedSegmentIds.length} segment(s).`);
    return summary;
  }

  function isRiding() {
    return activeRide !== null;
  }

  function getRideKind() {
    return activeRide?.kind ?? null;
  }

  // --- Joker post-ride matching: rank candidate lines by how much of the
  // trace overlaps each, then (once the user picks one) credit segments
  // using the same "reached both endpoints, in temporal order" rule as a
  // normal ride - naturally excludes any segment only partially ridden
  // (e.g. boarded mid-segment). ---

  function findJokerCandidates(rawTrack, alreadyExploredSegmentIds) {
    const hitCounts = scoreSegmentsAgainstTrace(rawTrack, segmentFeatures, getSpatialIndex(), MATCH_DISTANCE_M);
    const byRoute = new Map(); // routeId -> {routeId, routeShortName, mode, routeColor, hitSegmentIndices: Set}
    for (const [segIndex, count] of hitCounts) {
      if (count < 2) continue; // require more than a single glancing fix
      const props = segmentFeatures[segIndex].properties;
      if (!byRoute.has(props.routeId)) {
        byRoute.set(props.routeId, {
          routeId: props.routeId,
          routeShortName: props.routeShortName,
          mode: props.mode,
          routeColor: props.routeColor,
          hitSegmentIndices: new Set(),
        });
      }
      byRoute.get(props.routeId).hitSegmentIndices.add(segIndex);
    }

    const candidates = [];
    for (const cand of byRoute.values()) {
      const routeSegments = segmentFeatures
        .map((f, i) => ({ f, i }))
        .filter(({ f }) => f.properties.routeId === cand.routeId);
      const creditable = creditSegmentsFromTrace(rawTrack, routeSegments.map(({ f }) => f));
      const newCount = creditable.filter((segId) => !alreadyExploredSegmentIds.has(segId)).length;
      candidates.push({
        routeId: cand.routeId,
        routeShortName: cand.routeShortName,
        mode: cand.mode,
        routeColor: cand.routeColor,
        creditableSegmentIds: creditable,
        newSegmentCount: newCount,
      });
    }

    // Prioritize candidates that would actually add new coverage.
    candidates.sort((a, b) => b.newSegmentCount - a.newSegmentCount);
    return candidates;
  }

  function creditSegmentsFromTrace(trace, candidateSegmentFeatures) {
    const credited = [];
    for (const feature of candidateSegmentFeatures) {
      const props = feature.properties;
      let fromIdx = -1;
      for (let i = 0; i < trace.length; i++) {
        if (distanceToStop(trace[i], props.fromStop) <= STOP_ARRIVAL_THRESHOLD_M) { fromIdx = i; break; }
      }
      if (fromIdx === -1) continue;
      let toIdx = -1;
      for (let i = fromIdx + 1; i < trace.length; i++) {
        if (distanceToStop(trace[i], props.toStop) <= STOP_ARRIVAL_THRESHOLD_M) { toIdx = i; break; }
      }
      if (toIdx === -1) continue;
      credited.push(props.segmentId);
    }
    return credited;
  }

  return {
    startNormalRide,
    startJokerRide,
    onFix,
    endRide,
    isRiding,
    getRideKind,
    findJokerCandidates,
  };
}
