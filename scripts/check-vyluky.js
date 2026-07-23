// Cross-checks the lines included in our Žižkov build against PID's own
// published exception feeds - answers "is this line's current GTFS
// routing actually a known temporary diversion, or its real path?"
// which GTFS alone can't tell us (see memory: Kněžská louka/line 5 case,
// 2026-07-23).
//
// Feeds are plain RSS/XML from a WordPress plugin, one <item> per
// exception, each with a clean <lines> list (route_short_name values) and
// <dateFrom>/<dateTo> as Unix timestamps (empty dateTo = "until further
// notice"). Structured enough that a small regex-based parser is fine -
// no need for an XML library or NLP over the Czech description text.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDataDir = path.join(__dirname, '..', 'public', 'data');

const FEEDS = [
  { url: 'https://pid.cz/feed/rss-vyluky/', source: 'vyluky (planned/long-term)' },
  { url: 'https://pid.cz/feed/rss-mimoradnosti/', source: 'mimoradnosti (current/short-term)' },
];

function tag(itemXml, name) {
  const m = itemXml.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  return m ? m[1].trim() : '';
}

function parseFeedItems(xml, source) {
  const items = [];
  const itemBlocks = xml.split('<item>').slice(1); // drop channel header before first <item>
  for (const block of itemBlocks) {
    const body = block.split('</item>')[0];
    const title = tag(body, 'title');
    const link = tag(body, 'link');
    const dateFrom = tag(body, 'dateFrom');
    const dateTo = tag(body, 'dateTo');
    const lines = [...body.matchAll(/<line>([^<]*)<\/line>/g)].map((m) => m[1].trim());
    items.push({
      title,
      link,
      dateFromSec: dateFrom ? Number(dateFrom) : null,
      dateToSec: dateTo ? Number(dateTo) : null,
      lines,
      source,
    });
  }
  return items;
}

function isActiveNow(item, nowSec) {
  if (item.dateFromSec !== null && nowSec < item.dateFromSec) return false; // not started yet
  if (item.dateToSec !== null && nowSec > item.dateToSec) return false; // already ended
  return true; // ongoing, or "until further notice" (no dateTo)
}

async function main() {
  const nowSec = Math.floor(Date.now() / 1000);

  const allItems = [];
  for (const feed of FEEDS) {
    console.log(`Fetching ${feed.url} ...`);
    const res = await fetch(feed.url);
    const xml = await res.text();
    const items = parseFeedItems(xml, feed.source);
    console.log(`  ${items.length} item(s) parsed`);
    allItems.push(...items);
  }

  const activeItems = allItems.filter((it) => isActiveNow(it, nowSec));
  console.log(`\n${activeItems.length} of ${allItems.length} total exception(s) are active right now.\n`);

  // Map lineShortName -> active exception(s) affecting it.
  const activeByLine = new Map();
  for (const item of activeItems) {
    for (const line of item.lines) {
      if (!activeByLine.has(line)) activeByLine.set(line, []);
      activeByLine.get(line).push(item);
    }
  }

  // Cross-reference against the lines actually present in our Žižkov build.
  const geojson = JSON.parse(fs.readFileSync(path.join(publicDataDir, 'zizkov-transit-lines.geojson'), 'utf-8'));
  const ourLines = new Map(); // routeShortName -> mode
  for (const f of geojson.features) {
    ourLines.set(f.properties.routeShortName, f.properties.mode);
  }
  console.log(`Our Žižkov build includes ${ourLines.size} distinct lines.\n`);

  const flagged = [];
  const clear = [];
  for (const [shortName, mode] of ourLines) {
    const exceptions = activeByLine.get(shortName);
    if (exceptions && exceptions.length > 0) {
      flagged.push({ shortName, mode, exceptions });
    } else {
      clear.push(shortName);
    }
  }

  flagged.sort((a, b) => a.shortName.localeCompare(b.shortName, undefined, { numeric: true }));

  console.log(`=== ${flagged.length} of our lines currently have an active published exception ===\n`);
  for (const f of flagged) {
    console.log(`Line ${f.shortName} (${f.mode}):`);
    for (const ex of f.exceptions) {
      const from = ex.dateFromSec ? new Date(ex.dateFromSec * 1000).toISOString().slice(0, 10) : '?';
      const to = ex.dateToSec ? new Date(ex.dateToSec * 1000).toISOString().slice(0, 10) : 'until further notice';
      console.log(`  - [${ex.source}] ${from} -> ${to}: ${ex.title}`);
      console.log(`    ${ex.link}`);
    }
  }

  console.log(`\n${clear.length} line(s) have no currently active published exception (routing can be trusted as normal):`);
  console.log(`  ${clear.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(', ')}`);

  fs.writeFileSync(
    path.join(__dirname, '..', 'data', 'vyluky-check.json'),
    JSON.stringify({ checkedAt: new Date(nowSec * 1000).toISOString(), flagged, clearLines: clear }, null, 2),
  );
  console.log(`\nWrote data/vyluky-check.json`);
}

main().catch((e) => {
  console.error('Failed:', e);
  process.exit(1);
});
