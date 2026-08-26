import { createHash } from 'node:crypto';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bodyToHtml } from './views/page.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, 'server.js');

function renderBody(body) {
  return bodyToHtml(body);
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function request(port, host) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: '/graph',
      headers: { Host: host },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.once('error', reject);
  });
}

describe('wiki page markdown security', () => {
  it('preserves normal GFM and safe links', () => {
    const html = renderBody('# Heading\n\n**bold** ~~old~~\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n[local](/search?q=test) [web](https://example.com)');

    expect(html).toContain('<h1>Heading</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<del>old</del>');
    expect(html).toContain('<table>');
    expect(html).toContain('href="/search?q=test"');
    expect(html).toContain('href="https://example.com"');
  });

  it.each([
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(2)>',
    '<iframe srcdoc="<script>alert(3)</script>"></iframe>',
    '<object data="javascript:alert(4)"></object>',
    '<form action="javascript:alert(5)"><button>go</button></form>',
    '<svg><a href="javascript:alert(6)">x</a></svg>',
    '<math href="javascript:alert(7)">x</math>',
  ])('does not emit executable raw HTML: %s', (markdown) => {
    const html = renderBody(markdown);

    expect(html).not.toMatch(/<(?:script|iframe|object|form|svg|math)\b/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/(?:href|src|action)\s*=\s*["']?javascript:/i);
  });

  it.each([
    '[direct](javascript:alert(1))',
    '[case](JaVaScRiPt:alert(1))',
    '[control](java\u0009script:alert(1))',
    '[numeric](java&#115;cript:alert(1))',
    '[hex](java&#x73;cript:alert(1))',
    '[named](javascript&colon;alert(1))',
    '[data](data:text/html;base64,PHNjcmlwdD4=)',
    '[network](//attacker.example/path)',
    '![svg](data:image/svg+xml,<svg/onload=alert(1)>)',
    '<javascript:alert(1)>',
  ])('removes unsafe link and image targets: %s', (markdown) => {
    const html = renderBody(markdown);

    expect(html).not.toMatch(/(?:href|src)="[^"]*(?:javascript|vbscript|data):/i);
    expect(html).not.toContain('attacker.example');
  });
});

describe('wiki server boundary', () => {
  let child;
  let port;

  beforeAll(async () => {
    port = await reservePort();
    child = spawn(process.execPath, [serverPath], {
      cwd: path.resolve(__dirname, '../../..'),
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('wiki server did not start')), 10_000);
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`wiki server exited early (${code})`)));
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('wiki-web listening')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  });

  afterAll(async () => {
    if (!child || child.exitCode !== null) return;
    child.kill();
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(resolve, 3_000);
    });
  });

  it('binds explicitly to IPv4 loopback', () => {
    const source = readFileSync(serverPath, 'utf8');
    expect(source).toMatch(/app\.listen\(\s*PORT,\s*['"]127\.0\.0\.1['"]/);
  });

  it('rejects non-local Host headers', async () => {
    const response = await request(port, 'attacker.example');
    expect(response.status).toBe(403);
  });

  it('uses a hash-scoped CSP for the fixed graph bootstrap', async () => {
    const response = await request(port, `127.0.0.1:${port}`);
    const csp = response.headers['content-security-policy'];
    const inlineScripts = [...response.body.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];

    expect(response.status).toBe(200);
    expect(inlineScripts).toHaveLength(1);
    const digest = createHash('sha256').update(inlineScripts[0][1]).digest('base64');
    expect(csp).toContain(`'sha256-${digest}'`);
    expect(csp).toContain("script-src-attr 'none'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});
