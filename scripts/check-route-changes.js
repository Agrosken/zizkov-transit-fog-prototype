// Goes one level deeper than check-vyluky.js: that script only tells you
// WHICH lines have an active exception, not what actually changed about
// their route. PID's own exception detail pages (linked from the RSS
// items) include a "Změny tras tramvajových linek" (tram route changes)
// section for citywide-closure-style exceptions - one bullet per
// affected line, written as the line's route with the CHANGED portion
// wrapped in <strong>, e.g. (line 5's Kněžská luka case, 2026-07-23):
//   Linka číslo <strong>5</strong> SLIVENEC … Vozovna Žižkov – <strong>SPOJOVACÍ</strong>
//
// IMPORTANT (Tom, 2026-07-23): the changed-portion text only names the
// BOUNDARY of what changed, not every stop inside it - "Vozovna Žižkov –
// SPOJOVACÍ" does NOT mean "one stop further", it means the route now
// continues past Vozovna Žižkov, through however many real stops actually
// lie between it and Spojovací, to Spojovací. So the two (or one, for an
// open-ended extension) named waypoints are used as ANCHORS - located in
// our own already-correct GTFS stop sequence for that line+direction
// (which, being live data, already reflects whatever's currently running)
// - and everything between the anchors in ground truth is the real
// answer, not whatever's individually named in the prose.
//
// Confirmed for line 5: anchors "Vozovna Žižkov" (unchanged, last stop
// before the change) and no closing anchor (open-ended - extends to a NEW
// terminus). Resolving against the full live sequence found 3 real stops
// PID's own text never named at all (Strážní, Chmelnice, Kněžská luka)
// between Vozovna Žižkov and the new terminus Spojovací.
//
// Format is real-world published prose, not a clean API. Tom's read (having
// watched PID publish these for a while): the formatting is quite uniform
// and deliberately structured, so leaning on it is reasonable - but this
// was only confirmed against tram closures so far; bus/metro/train
// exception pages weren't checked and may format differently.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');

const ENTITIES = {
  aacute: 'á', Aacute: 'Á', eacute: 'é', Eacute: 'É', iacute: 'í', Iacute: 'Í',
  yacute: 'ý', Yacute: 'Ý', scaron: 'š', Scaron: 'Š', ccaron: 'č', Ccaron: 'Č',
  zcaron: 'ž', Zcaron: 'Ž', rcaron: 'ř', Rcaron: 'Ř', ecaron: 'ě', Ecaron: 'Ě',
  ncaron: 'ň', Ncaron: 'Ň', tcaron: 'ť', Tcaron: 'Ť', dcaron: 'ď', Dcaron: 'Ď',
  uring: 'ů', Uring: 'Ů', ouml: 'ö', ndash: '–', mdash: '—', hellip: '…',
  nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>',
};

function decodeEntities(str) {
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name in ENTITIES ? ENTITIES[name] : m));
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function normalizeStopName(name) {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Splits a bullet's remainder (after the line-number prefix) into ordered
// waypoint tokens, each tagged changed (was inside <strong>) or not.
// "…" is a gap marker (the normal route continues, unlisted) - dropped,
// not treated as a waypoint.
function tokenizeRoute(remainderHtml) {
  const runs = [...remainderHtml.matchAll(/<strong>([\s\S]*?)<\/strong>|([^<]+)/g)];
  const tokens = [];
  for (const run of runs) {
    const changed = run[1] !== undefined;
    const text = stripTags(changed ? run[1] : run[2]);
    // Split on BOTH the en-dash (waypoint separator) and the ellipsis
    // (explicit "unnamed stops omitted here" marker) - a run like "SLIVENEC
    // … Vozovna Žižkov" is one plain-text HTML run with no dash in it at
    // all, so splitting on dash alone left the gap marker glued to the
    // real anchor name instead of separating them.
    for (const piece of text.split(/[–…]/)) {
      const t = piece.trim();
      if (!t || /^\.*$/.test(t)) continue;
      tokens.push({ text: t, changed });
    }
  }
  return tokens;
}

// The changed span's boundary: nearest unchanged token before the first
// changed one (fromAnchor), and nearest unchanged token after the last
// changed one (toAnchor, null if the change runs open-ended to a new
// terminus - line 5's case).
function findAnchors(tokens) {
  const firstChanged = tokens.findIndex((t) => t.changed);
  if (firstChanged === -1) return null;
  let lastChanged = firstChanged;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].changed) { lastChanged = i; break; }
  }
  const fromAnchor = firstChanged > 0 ? tokens[firstChanged - 1].text : null;
  const toAnchor = lastChanged < tokens.length - 1 ? tokens[lastChanged + 1].text : null;
  return { fromAnchor, toAnchor };
}

export async function fetchRouteChanges(detailUrl) {
  const res = await fetch(detailUrl);
  // Decode entities over the WHOLE page up front: PID's CMS mixes literal
  // UTF-8 characters with HTML entities inconsistently (e.g. literal "Ž"
  // but "&yacute;" for "ý" in the same heading).
  const html = decodeEntities(await res.text());

  const headingIdx = html.indexOf('Změny tras tramvajových linek');
  if (headingIdx === -1) return [];

  const ulStart = html.indexOf('<ul>', headingIdx);
  const ulEnd = html.indexOf('</ul>', ulStart);
  if (ulStart === -1 || ulEnd === -1) return [];
  const listHtml = html.slice(ulStart, ulEnd);

  const items = [...listHtml.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]);

  const changes = [];
  for (const li of items) {
    const prefixMatch = li.match(/Link[ay]\s+č[íi]sl[oa]\s+((?:<strong>[^<]+<\/strong>\s*(?:,|a)?\s*)+)/i);
    if (!prefixMatch) continue;
    const lineNumbers = [...prefixMatch[1].matchAll(/<strong>([^<]+)<\/strong>/g)].map((m) => m[1].trim());

    const remainder = li.slice(prefixMatch.index + prefixMatch[0].length);
    const tokens = tokenizeRoute(remainder);
    const anchors = findAnchors(tokens);

    changes.push({ lines: lineNumbers, fullRouteText: stripTags(li), anchors });
  }
  return changes;
}

// Ground truth: the FULL (not Žižkov-filtered) live stop sequence for a
// route+direction, straight from gtfs-parsed.json - already reflects
// whatever's actually running right now, diversion included.
function fullLiveSequence(parsed, routeId, dirId) {
  const shapeId = parsed.routeDirToShapeId[`${routeId}|${dirId}`];
  if (!shapeId) return null;
  const tripId = parsed.shapeToSampleTripId[shapeId];
  const stopSeq = parsed.stopTimesByTrip[tripId];
  if (!stopSeq) return null;
  return stopSeq.map((s) => ({ stopId: s.stopId, ...parsed.stopsById[s.stopId] }));
}

function findAnchorIndex(sequence, anchorName) {
  if (!anchorName) return -1;
  const key = normalizeStopName(anchorName);
  return sequence.findIndex((s) => s.name && normalizeStopName(s.name) === key);
}

// Resolves the anchors against ground truth for one direction's sequence,
// returning the actual stop list the exception changed - not just
// whatever was individually named in the prose.
function resolveChangedStops(sequence, anchors) {
  const fromIdx = findAnchorIndex(sequence, anchors.fromAnchor);
  const toIdx = findAnchorIndex(sequence, anchors.toAnchor);

  if (fromIdx === -1 && toIdx === -1) return null;

  if (fromIdx !== -1 && toIdx !== -1) {
    // Both named - substitution case: everything between them (inclusive) changed.
    const [lo, hi] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
    return { kind: 'substitution', stops: sequence.slice(lo, hi + 1) };
  }

  // Open-ended (extension) case - only one anchor found. The change lies
  // on whichever side of it is the SHORTER stretch to an array end, since
  // a route extension adds a handful of stops onto what should otherwise
  // be very close to a terminus; the far side is just "the rest of the
  // line" and isn't what changed.
  const anchorIdx = fromIdx !== -1 ? fromIdx : toIdx;
  const toEnd = sequence.length - 1 - anchorIdx;
  const toStart = anchorIdx;
  return toEnd <= toStart
    ? { kind: 'extension', stops: sequence.slice(anchorIdx) }
    : { kind: 'extension', stops: sequence.slice(0, anchorIdx + 1).reverse() };
}

async function main() {
  const targetLine = process.argv[2];
  const detailUrl = process.argv[3];
  if (!targetLine || !detailUrl) {
    console.error('Usage: node check-route-changes.js <lineShortName> <exceptionDetailUrl>');
    process.exit(1);
  }

  console.log(`Fetching ${detailUrl} ...`);
  const changes = await fetchRouteChanges(detailUrl);
  console.log(`Found ${changes.length} line route-change entries on this page.\n`);

  const forLine = changes.find((c) => c.lines.includes(targetLine));
  if (!forLine) {
    console.log(`Line ${targetLine} not found in this page's route-change list.`);
    return;
  }

  console.log(`Line ${targetLine} full described route:`);
  console.log(`  ${forLine.fullRouteText}\n`);

  if (!forLine.anchors) {
    console.log('No changed portion detected (no <strong> span found in this bullet).');
    return;
  }
  console.log(`Anchors: from "${forLine.anchors.fromAnchor ?? '(none - change starts at the very beginning)'}" to "${forLine.anchors.toAnchor ?? '(none - open-ended, extends to a new terminus)'}"\n`);

  const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'gtfs-parsed.json'), 'utf-8'));

  // Look up the routeId behind this short name via routesById.
  const routeEntry = Object.values(parsed.routesById).find((r) => r.routeShortName === targetLine);
  if (!routeEntry) {
    console.log(`Line ${targetLine} not found in routesById - can't resolve against ground truth.`);
    return;
  }

  for (const dirId of ['0', '1']) {
    const sequence = fullLiveSequence(parsed, routeEntry.routeId, dirId);
    if (!sequence) continue;
    const resolved = resolveChangedStops(sequence, forLine.anchors);
    console.log(`Direction ${dirId} (${sequence[0]?.name} -> ${sequence[sequence.length - 1]?.name}):`);
    if (!resolved) {
      console.log('  Could not locate anchor(s) in this direction\'s live sequence.\n');
      continue;
    }
    console.log(`  Resolved as a${resolved.kind === 'extension' ? 'n extension' : ' substitution'} - real stops actually affected (ground truth, not just what was named):`);
    console.log(`    ${resolved.stops.map((s) => s.name).join(' -> ')}`);
    console.log();
  }
}

main().catch((e) => {
  console.error('Failed:', e);
  process.exit(1);
});
