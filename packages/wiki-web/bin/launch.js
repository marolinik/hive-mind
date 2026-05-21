#!/usr/bin/env node
/**
 * Boot the wiki-web server and (Windows) open default browser.
 */
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER = path.join(__dirname, '..', 'src', 'server.js');

const port = Number(process.env.PORT) || 3717;

const child = spawn(process.execPath, [SERVER], {
  stdio: 'inherit',
  windowsHide: false,
});

setTimeout(() => {
  const url = `http://localhost:${port}`;
  // Use execFile (no shell) — argv-based, no injection surface.
  if (process.platform === 'win32') {
    execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
  } else if (process.platform === 'darwin') {
    execFile('open', [url], () => {});
  } else {
    execFile('xdg-open', [url], () => {});
  }
}, 800);

child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => { child.kill('SIGINT'); });
process.on('SIGTERM', () => { child.kill('SIGTERM'); });
