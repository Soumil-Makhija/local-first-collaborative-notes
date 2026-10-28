import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

function files(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
const paths = [
  ...['src', 'scripts', 'tests', 'e2e'].flatMap(files).filter(path => path.endsWith('.js')),
  'sw.js',
  'playwright.config.js',
];
for (const path of paths) {
  const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Syntax checked ${paths.length} JavaScript files.`);
