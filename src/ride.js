// Get On / Get Off / Extra("Joker") ride state machine.
//
// Normal ride: board at a stop, pick a line serving it. Direction is never
// guessed from movement bearing/timing - a line's two directions from the
// boarding stop lead to two DIFFERENT next stops (they only rejoin the
// same physical segment further along, on shared/merged bidirectional
// street segments), and a segment only ever credits when a fix actually
// lands near its destination stop anyway. So both candidate directions'
// immediate next-stop are checked in parallel from boarding; whichever one
// is actually reached first both resolves the direction AND credits that
// first segment in the same instant - no separate inference/timing/
// correction logic needed, and no risk of committing to the wrong one,
// since only the real destination stop's proximity check can ever fire.
// (An earlier version inferred direction from GPS movement bearing over a
// timed window, with a 5-minute re-validation/correction safety net - Tom
// pointed out the whole thing was unnecessary complexity once crediting
// already only happens on confirmed stop arrival.)
//
// Joker ride: no line/stop pre-selection (for a depot move / non-listed
// special run). On Get Off, the recorded trace is matched post-hoc
// against every line's segments; the rider picks which real line to
// attribute it to; crediting then uses the SAME "reached both endpoints,
// in order" rule as a normal ride, so joining a route mid-segment
// naturally fails to credit that segment - no special-casing needed.

import { filterFix, isNearDestinationStop, distanceToStop, buildSpatialIndex, scoreSegmentsAgainstTrace } from './matching.js';
import { MATCH_DISTANCE_M, STOP_ARRIVAL_THRESHOLD_M, DEVIATION_MARGIN_M, DEVIATION_MIN_WORSENING_FIXES } from './config.js';

function freshDeviationTracker() {
  return { minDistanceToTarget: null, worseningFixCount: 0 };
}

// Closest-approach-then-moving-away check, no bearing/speed modeling: a leg
// is "deviating" once the distance to its target stop has been worse than
// the closest point seen so far by more than DEVIATION_MARGIN_M, for
// DEVIATION_MIN_WORSENING_FIXES consecutive accepted fixes in a row (a
// single noisy fix resets the streak rather than tripping it, same concern
// the accuracy-margin fix in matching.js addressed for speed filtering).
function checkDeviation(currentDist, tracker) {
  if (tracker.minDistanceToTarget === null || currentDist < tracker.minDistanceToTarget) {
    tracker.minDistanceToTarget = currentDist;
    tracker.worseningFixCount = 0;
    return false;
  }
  if (currentDist - tracker.minDistanceToTarget > DEVIATION_MARGIN_M) {
    tracker.worseningFixCount++;
  } else {
    tracker.worseningFixCount = 0;
  }
  return tracker.worseningFixCount >= DEVIATION_MIN_WORSENING_FIXES;
}

export function createRideController({ lineDirectionsIndex, segmentFeatures, onSegmentCredited, onStatus, onDeviationSuspected }) {
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
      candidates.push({ dirKey: key, dir, startPointer: pos, nextStop: dir.orderedStops[pos + 1], deviationTracker: freshDeviationTracker() });
    }
    return candidates;
  }

  function startNormalRide({ routeId, routeShortName, mode, boardingNodeId, boardingStopName }) {
    const candidates = findCandidateDirections(routeId, boardingNodeId);
    if (candidates.length === 0) {
      onStatus(`No onward route found for ${routeShortName} from ${boardingStopName} - can't start this ride.`);
      return false;
    }

    // resolvedDirKey stays null while >1 candidate remains possible; each
    // candidate tracks its own pointer (starting at the boarding stop)
    // until one of them is actually reached, at which point the others
    // are simply dropped - see onFix.
    const resolved = candidates.length === 1;
    activeRide = {
      kind: 'normal',
      routeId,
      routeShortName,
      mode,
      boardingNodeId,
      boardingStopName,
      startedAt: Date.now(),
      resolvedDirKey: resolved ? candidates[0].dirKey : null,
      pointer: resolved ? candidates[0].startPointer : null,
      candidates: resolved ? null : candidates.map((c) => ({ dirKey: c.dirKey, dir: c.dir, pointer: c.startPointer, deviationTracker: freshDeviationTracker() })),
      deviationTracker: resolved ? freshDeviationTracker() : null,
      deviationPending: false,
      rawTrack: [],
      fixLog: [],
      lastAcceptedFix: null,
      creditedSegmentIds: [],
    };

    if (resolved) {
      onStatus(`Riding ${routeShortName} toward ${lineDirectionsIndex[activeRide.resolvedDirKey].orderedStops[activeRide.pointer + 1].name}.`);
    } else {
      onStatus(`Riding ${routeShortName} - direction will confirm once the next stop is reached.`);
    }
    return true;
  }

  // boardingNodeId/boardingStopName are optional - set when the rider
  // picked "Other line" for a specific stop in the normal Get On flow
  // (known boarding point, unknown line). Not used by the matching itself
  // (that still runs on the full recorded trace), just carried through to
  // the ride summary/history for transparency.
  function startJokerRide({ boardingNodeId, boardingStopName } = {}) {
    activeRide = {
      kind: 'joker',
      startedAt: Date.now(),
      rawTrack: [],
      fixLog: [],
      lastAcceptedFix: null,
      mode: 'tram', // placeholder speed-filter category; joker rides use the most permissive check anyway via matching's default
      boardingNodeId: boardingNodeId ?? null,
      boardingStopName: boardingStopName ?? null,
    };
    onStatus('Recording an extra/special ride - pick a line for it when you get off.');
  }

  function onFix(fix) {
    if (!activeRide) return;
    const { accepted, reason } = filterFix(fix, activeRide.lastAcceptedFix, activeRide.mode);
    // Every fix attempt is logged - accepted or not - since rejected fixes
    // (and why) are exactly what's needed to tell whether a missed credit
    // was a real GPS problem or a threshold that needs retuning.
    activeRide.fixLog.push({
      timestamp: fix.timestamp,
      lat: fix.lat,
      lon: fix.lon,
      accuracy: fix.accuracy,
      accepted,
      reason: accepted ? null : reason,
    });
    if (!accepted) {
      onStatus(`Skipped fix (${reason})`);
      return;
    }
    activeRide.lastAcceptedFix = fix;
    activeRide.rawTrack.push(fix);
    // Clear any lingering "skipped fix" warning now that a good fix has
    // arrived - it was persisting on screen indefinitely otherwise, since
    // nothing ever cleared it until the next specific status update (which
    // might be minutes away, e.g. the next stop). Any more specific
    // message below (direction confirmed, stop reached) overrides this in
    // the same call, so there's no visible flicker - only the final value
    // for this fix ever paints.
    onStatus('');

    if (activeRide.kind === 'joker') return; // no live crediting for joker rides - handled post-hoc on Get Off

    if (activeRide.resolvedDirKey === null) {
      // Still ambiguous: check each candidate direction's own immediate
      // next stop. They're genuinely different physical stops (the two
      // directions diverge right away from the boarding point), so only
      // the real one can ever be reached - whichever fires first both
      // resolves the direction and credits that first segment at once.
      for (const cand of activeRide.candidates) {
        const destinationStop = cand.dir.orderedStops[cand.pointer + 1];
        if (!destinationStop || !isNearDestinationStop(fix, destinationStop)) continue;
        activeRide.resolvedDirKey = cand.dirKey;
        activeRide.pointer = cand.pointer + 1;
        activeRide.candidates = null;
        activeRide.deviationTracker = freshDeviationTracker();
        const segmentId = cand.dir.orderedSegmentIds[cand.pointer];
        const wasNew = onSegmentCredited(segmentId);
        if (wasNew) activeRide.creditedSegmentIds.push(segmentId);
        onStatus(`Confirmed heading toward ${destinationStop.name}.`);
        return;
      }

      // Still not resolved - if EVERY remaining candidate is drifting
      // farther from its own next stop (not just one, since one candidate
      // still closing in means boarding was probably fine), the boarding
      // itself looks wrong. Skip the check entirely while a prompt is
      // already pending an answer.
      if (!activeRide.deviationPending) {
        let allWorsening = activeRide.candidates.length > 0;
        for (const cand of activeRide.candidates) {
          const destinationStop = cand.dir.orderedStops[cand.pointer + 1];
          if (!destinationStop) { allWorsening = false; continue; }
          const dist = distanceToStop(fix, destinationStop);
          if (!checkDeviation(dist, cand.deviationTracker)) allWorsening = false;
        }
        if (allWorsening) {
          activeRide.deviationPending = true;
          onDeviationSuspected({ reason: 'off-route' });
        }
      }
      return;
    }

    const dir = lineDirectionsIndex[activeRide.resolvedDirKey];
    if (activeRide.pointer >= dir.orderedSegmentIds.length) {
      // Rode the whole tracked line and never tapped Get Off - directly the
      // "forgot to press Get Off" scenario, ask rather than silently
      // no-opping every subsequent fix.
      if (!activeRide.deviationPending) {
        activeRide.deviationPending = true;
        onDeviationSuspected({ reason: 'end-of-line' });
      }
      return;
    }

    const destinationStop = dir.orderedStops[activeRide.pointer + 1];
    if (isNearDestinationStop(fix, destinationStop)) {
      const segmentId = dir.orderedSegmentIds[activeRide.pointer];
      // Only track segments THIS ride newly credited - avoids double-
      // counting toward this ride's own summary when a segment was
      // already explored from an earlier ride; onSegmentCredited reports
      // whether it was actually new.
      const wasNew = onSegmentCredited(segmentId);
      if (wasNew) activeRide.creditedSegmentIds.push(segmentId);
      onStatus(`Reached ${destinationStop.name}.`);
      activeRide.pointer++;
      activeRide.deviationTracker = freshDeviationTracker(); // new leg, new target
      return;
    }

    if (!activeRide.deviationPending) {
      const dist = distanceToStop(fix, destinationStop);
      if (checkDeviation(dist, activeRide.deviationTracker)) {
        activeRide.deviationPending = true;
        onDeviationSuspected({ reason: 'off-route' });
      }
    }
  }

  // Called with the rider's answer to a deviation prompt. 'detour' means
  // "still riding, just went a different way than expected" - clears the
  // pending flag and resets the current leg's tracker so drift is measured
  // fresh from here, without ending the ride. Any other choice ends the
  // ride now (crediting whatever was legitimately credited so far) and
  // stamps the reason into the summary for later review - deliberately no
  // per-reason recovery logic beyond that; the rider re-boards via Get On.
  function resolveDeviation(choice) {
    if (!activeRide) return null;
    if (choice === 'detour') {
      activeRide.deviationPending = false;
      if (activeRide.resolvedDirKey !== null) {
        activeRide.deviationTracker = freshDeviationTracker();
      } else if (activeRide.candidates) {
        for (const cand of activeRide.candidates) cand.deviationTracker = freshDeviationTracker();
      }
      onStatus('Still tracking - continuing the ride.');
      return null;
    }
    return endRide({ deviationReason: choice });
  }

  function endRide({ alightingNodeId, alightingStopName, deviationReason } = {}) {
    if (!activeRide) return null;

    if (activeRide.kind === 'joker') {
      const jokerRide = activeRide;
      activeRide = null;
      onStatus('Ride ended. Pick which line to credit it to.');
      return {
        kind: 'joker',
        rawTrack: jokerRide.rawTrack,
        fixLog: jokerRide.fixLog,
        startedAt: jokerRide.startedAt,
        endedAt: Date.now(),
        boardingNodeId: jokerRide.boardingNodeId,
        boardingStopName: jokerRide.boardingStopName,
        deviationReason: deviationReason ?? null,
      };
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
      fixLog: activeRide.fixLog,
      deviationReason: deviationReason ?? null,
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
    resolveDeviation,
    isRiding,
    getRideKind,
    findJokerCandidates,
  };
}
