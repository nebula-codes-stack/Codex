import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const publicVendorDir = path.join(rootDir, 'public', 'vendor');

const assets = [
  ['node_modules/@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['node_modules/@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
];

await fs.mkdir(publicVendorDir, { recursive: true });

await Promise.all(assets.map(async ([source, destination]) => {
  await fs.copyFile(path.join(rootDir, source), path.join(publicVendorDir, destination));
}));
