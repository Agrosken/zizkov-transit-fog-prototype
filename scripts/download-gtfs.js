// Downloads and unzips Prague PID's official GTFS static feed
// (https://data.pid.cz/PID_GTFS.zip, CC-BY 4.0, regenerated daily).
// Not part of `prepare-data` - run manually via `npm run fetch-gtfs` since
// this is a ~43.5MB download and the feed doesn't need re-fetching on
// every iteration of the build pipeline.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
const zipPath = path.join(dataDir, 'PID_GTFS.zip');
const rawDir = path.join(dataDir, 'gtfs-raw');

const GTFS_URL = 'https://data.pid.cz/PID_GTFS.zip';

async function main() {
  fs.mkdirSync(dataDir, { recursive: true });

  console.log(`Downloading ${GTFS_URL} ...`);
  const res = await fetch(GTFS_URL);
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(zipPath, buffer);
  console.log(`Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB.`);

  console.log('Unzipping...');
  fs.rmSync(rawDir, { recursive: true, force: true });
  fs.mkdirSync(rawDir, { recursive: true });
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(rawDir, true);

  const files = fs.readdirSync(rawDir);
  console.log(`Extracted ${files.length} files to ${rawDir}:`);
  for (const f of files) {
    const stat = fs.statSync(path.join(rawDir, f));
    console.log(`  ${f} (${(stat.size / 1024).toFixed(0)} KB)`);
  }
}

main().catch((e) => {
  console.error('Failed:', e.message);
  process.exit(1);
});
