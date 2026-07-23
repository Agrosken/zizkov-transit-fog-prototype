// Downloads a JSON file with everything useful from the session - no
// backend to sync this automatically. Per-line stats, deliberately never
// deduped across different lines (riding overlapping stretches on two
// different lines both count fully - that's the whole point of this app;
// only the SAME line's own bidirectional segments are ever shared).

export function downloadTransitData({ exploredSegmentIds, completedRides, segmentFeatures }) {
  const segmentById = new Map(segmentFeatures.map((f) => [f.properties.segmentId, f.properties]));

  const exploredLengthM = [...exploredSegmentIds].reduce((sum, id) => {
    const props = segmentById.get(id);
    return sum + (props ? props.lengthM : 0);
  }, 0);

  // Per-line summary - grouped by routeId, NOT deduped against other lines.
  const byRoute = new Map();
  for (const f of segmentFeatures) {
    const p = f.properties;
    if (!byRoute.has(p.routeId)) {
      byRoute.set(p.routeId, { routeId: p.routeId, routeShortName: p.routeShortName, mode: p.mode, totalLengthM: 0, exploredLengthM: 0, totalSegments: 0, exploredSegments: 0 });
    }
    const entry = byRoute.get(p.routeId);
    entry.totalLengthM += p.lengthM;
    entry.totalSegments++;
    if (exploredSegmentIds.has(p.segmentId)) {
      entry.exploredLengthM += p.lengthM;
      entry.exploredSegments++;
    }
  }
  for (const entry of byRoute.values()) {
    entry.totalRides = completedRides.filter((r) => r.routeId === entry.routeId).length;
  }

  // Quick GPS-quality rollup across every ride's fixLog, so "was GPS the
  // problem" doesn't require opening each ride's fix-by-fix log by hand -
  // rejectionsByReason groups by the leading word (e.g. "accuracy" vs
  // "implausible") since the full reason string includes a specific
  // measured value that differs per fix.
  let acceptedFixes = 0;
  let rejectedFixes = 0;
  const rejectionsByReason = {};
  for (const ride of completedRides) {
    for (const entry of ride.fixLog || []) {
      if (entry.accepted) {
        acceptedFixes++;
      } else {
        rejectedFixes++;
        const key = (entry.reason || 'unknown').split(' ')[0];
        rejectionsByReason[key] = (rejectionsByReason[key] || 0) + 1;
      }
    }
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    summary: {
      totalSegments: segmentFeatures.length,
      exploredSegments: exploredSegmentIds.size,
      exploredLengthM: Math.round(exploredLengthM * 10) / 10,
      totalLines: byRoute.size,
      linesStarted: [...byRoute.values()].filter((r) => r.exploredSegments > 0).length,
      linesCompleted: [...byRoute.values()].filter((r) => r.exploredSegments === r.totalSegments).length,
      totalRides: completedRides.length,
      jokerRides: completedRides.filter((r) => r.wasJoker).length,
      acceptedFixes,
      rejectedFixes,
      rejectionsByReason,
    },
    perLineSummary: [...byRoute.values()],
    completedRides,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = url;
  a.download = `zizkov-transit-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
