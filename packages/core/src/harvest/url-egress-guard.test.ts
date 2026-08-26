import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, it, expect, vi } from 'vitest';
import {
  classifyAddress,
  assertUrlAllowed,
  safeFetch,
  allowLocalFromEnv,
  EgressBlockedError,
  type LookupFn,
  type ResolvedAddress,
  type SafeFetchOptions,
} from './url-egress-guard.js';
import { UrlAdapter } from './url-adapter.js';

function mockLookup(map: Record<string, ResolvedAddress[]>): LookupFn {
  return async (hostname: string) => {
    const addrs = map[hostname];
    if (!addrs) throw new Error(`ENOTFOUND ${hostname}`);
    return addrs;
  };
}

const v4 = (address: string): ResolvedAddress => ({ address, family: 4 });
const v6 = (address: string): ResolvedAddress => ({ address, family: 6 });

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function startHttpServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<{ port: number; getHits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server = createServer((request, response) => {
    hits++;
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected an IPv4 test listener');
  }
  return {
    port: address.port,
    getHits: () => hits,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

describe('url-egress-guard (@hive-mind/core)', () => {
  it('classifies the SSRF-relevant ranges', () => {
    expect(classifyAddress('127.0.0.1')).toBe('loopback');
    expect(classifyAddress('169.254.169.254')).toBe('link-local');
    expect(classifyAddress('10.0.0.5')).toBe('private');
    expect(classifyAddress('192.168.1.1')).toBe('private');
    expect(classifyAddress('::1')).toBe('loopback');
    expect(classifyAddress('::ffff:169.254.169.254')).toBe('link-local');
    expect(classifyAddress('8.8.8.8')).toBe('public');
  });

  it('classifies IPv4 CGNAT and private-range boundaries', () => {
    expect(classifyAddress('100.63.255.255')).toBe('public');
    expect(classifyAddress('100.64.0.0')).toBe('private');
    expect(classifyAddress('100.127.255.255')).toBe('private');
    expect(classifyAddress('100.128.0.0')).toBe('public');
    expect(classifyAddress('172.15.255.255')).toBe('public');
    expect(classifyAddress('172.16.0.0')).toBe('private');
    expect(classifyAddress('172.31.255.255')).toBe('private');
    expect(classifyAddress('172.32.0.0')).toBe('public');
    expect(classifyAddress('223.255.255.255')).toBe('public');
    expect(classifyAddress('224.0.0.0')).toBe('multicast');
    expect(classifyAddress('239.255.255.255')).toBe('multicast');
    expect(classifyAddress('240.0.0.0')).toBe('reserved');
    expect(classifyAddress('192.88.98.255')).toBe('public');
    expect(classifyAddress('192.88.99.0')).toBe('reserved');
    expect(classifyAddress('192.88.99.255')).toBe('reserved');
    expect(classifyAddress('192.88.100.0')).toBe('public');
  });

  it('fails closed on IPv6 local, special-use, and malformed addresses', () => {
    expect(classifyAddress('fe80::1')).toBe('link-local');
    expect(classifyAddress('febf:ffff::1')).toBe('link-local');
    expect(classifyAddress('fec0::1')).toBe('reserved');
    expect(classifyAddress('feff:ffff::1')).toBe('reserved');
    expect(classifyAddress('fc00::1')).toBe('unique-local');
    expect(classifyAddress('fdff:ffff::1')).toBe('unique-local');
    expect(classifyAddress('ff02::1')).toBe('multicast');
    expect(classifyAddress('64:ff9b::1')).toBe('reserved');
    expect(classifyAddress('64:ff9b:1::1')).toBe('reserved');
    expect(classifyAddress('100::1')).toBe('reserved');
    expect(classifyAddress('2001:2::1')).toBe('reserved');
    expect(classifyAddress('2002::1')).toBe('reserved');
    expect(classifyAddress('100:0:0:1::1')).toBe('reserved');
    expect(classifyAddress('3fff::1')).toBe('reserved');
    expect(classifyAddress('3fff:0fff::1')).toBe('reserved');
    expect(classifyAddress('5f00::1')).toBe('reserved');
    expect(classifyAddress('64:ff9b:2::1')).toBe('public');
    expect(classifyAddress('100:0:0:2::1')).toBe('public');
    expect(classifyAddress('2001:2:1::1')).toBe('public');
    expect(classifyAddress('5f01::1')).toBe('public');
    expect(classifyAddress('2606:4700:4700::1111')).toBe('public');
    expect(classifyAddress('2001:4860:4860::8888')).toBe('public');
    expect(classifyAddress('3fff:1000::1')).toBe('public');
    expect(classifyAddress('not-an-ip')).toBe('invalid');
    expect(classifyAddress('fe80:::1')).toBe('invalid');
    expect(classifyAddress('12345::1')).toBe('invalid');
  });

  it('uses only the public Hive Mind local-fetch opt-in', () => {
    const previous = process.env.HIVE_MIND_ALLOW_LOCAL_FETCH;
    try {
      delete process.env.HIVE_MIND_ALLOW_LOCAL_FETCH;
      expect(allowLocalFromEnv()).toBe(false);
      process.env.HIVE_MIND_ALLOW_LOCAL_FETCH = '1';
      expect(allowLocalFromEnv()).toBe(true);
      process.env.HIVE_MIND_ALLOW_LOCAL_FETCH = 'true';
      expect(allowLocalFromEnv()).toBe(true);
      process.env.HIVE_MIND_ALLOW_LOCAL_FETCH = 'TRUE';
      expect(allowLocalFromEnv()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HIVE_MIND_ALLOW_LOCAL_FETCH;
      else process.env.HIVE_MIND_ALLOW_LOCAL_FETCH = previous;
    }
  });

  it('rejects literal loopback / metadata / private / IPv6-loopback (no DNS)', async () => {
    await expect(assertUrlAllowed('http://127.0.0.1/')).rejects.toThrow(/loopback/);
    await expect(assertUrlAllowed('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/link-local/);
    await expect(assertUrlAllowed('http://10.0.0.5/')).rejects.toThrow(/private/);
    await expect(assertUrlAllowed('http://[::1]/')).rejects.toThrow(/loopback/);
  });

  it('does not unlock RFC1918 targets when allowLocal is enabled', async () => {
    await expect(assertUrlAllowed('http://10.0.0.5/', { allowLocal: true })).rejects.toThrow(/private/);
    await expect(assertUrlAllowed('http://172.16.0.5/', { allowLocal: true })).rejects.toThrow(/private/);
    await expect(assertUrlAllowed('http://192.168.0.5/', { allowLocal: true })).rejects.toThrow(/private/);
    await expect(assertUrlAllowed('http://[fec0::1]/', { allowLocal: true })).rejects.toThrow(/reserved/);
  });

  it('rejects literal special-use IPv6 targets without DNS', async () => {
    for (const address of [
      'fec0::1',
      '100:0:0:1::1',
      '2001:2::1',
      '2002::1',
      '3fff::1',
      '5f00::1',
    ]) {
      await expect(assertUrlAllowed(`http://[${address}]/`)).rejects.toThrow(/reserved/);
    }
  });

  it('rejects DNS records that resolve to special-use IPv6 space', async () => {
    const lookup = mockLookup({
      'special.invalid': [v6('2606:4700:4700::1111'), v6('2002::1')],
    });
    await expect(
      assertUrlAllowed('https://special.invalid/', { lookup }),
    ).rejects.toThrow(/reserved/);
  });

  it('rejects alternate address forms that normalize into special-use space', async () => {
    for (const target of [
      'http://0300.0130.0143.1/',
      'http://2130706433/',
      'http://0x7f000001/',
      'http://127.1/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:10.0.0.1]/',
      'http://[::ffff:169.254.169.254]/',
      'http://[::ffff:192.88.99.1]/',
    ]) {
      await expect(assertUrlAllowed(target)).rejects.toThrow(/blocked/i);
    }

    await expect(assertUrlAllowed('http://[::ffff:8.8.8.8]/')).resolves.toBeInstanceOf(URL);
  });

  it('rejects non-http(s) schemes', async () => {
    await expect(assertUrlAllowed('file:///etc/passwd')).rejects.toThrow(/scheme/i);
  });

  it('rejects URL credentials before DNS resolution', async () => {
    const lookup = vi.fn<LookupFn>();

    await expect(
      assertUrlAllowed('https://user:password@public.invalid/path', { lookup }),
    ).rejects.toThrow(/credentials/i);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects a hostname that resolves to a private address', async () => {
    const lookup = mockLookup({ 'internal.example.com': [v4('10.1.2.3')] });
    await expect(assertUrlAllowed('http://internal.example.com/', { lookup })).rejects.toThrow(/private/);
  });

  it('allows a public URL', async () => {
    const lookup = mockLookup({ 'example.com': [v4('93.184.216.34')] });
    const url = await assertUrlAllowed('https://example.com/', { lookup });
    expect(url.hostname).toBe('example.com');
  });

  it('safeFetch connects to the exact validated peer and preserves Host', async () => {
    let seenHost: string | undefined;
    const server = await startHttpServer((request, response) => {
      seenHost = request.headers.host;
      response.end('page');
    });
    const lookup = vi.fn<LookupFn>().mockResolvedValue([v4('127.0.0.1')]);

    try {
      const res = await safeFetch(
        `http://safe.invalid:${server.port}/`,
        {},
        { lookup, allowLocal: true, maxRedirects: 0 },
      );
      expect(await res.text()).toBe('page');
    } finally {
      await server.close();
    }
    expect(seenHost).toBe(`safe.invalid:${server.port}`);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('safeFetch blocks a public-to-metadata DNS flip at socket connect', async () => {
    const lookup = vi.fn<LookupFn>()
      .mockResolvedValueOnce([v4('93.184.216.34')])
      .mockResolvedValueOnce([v4('169.254.169.254')]);

    await expect(
      safeFetch('http://metadata-rebind.invalid/', {}, { lookup, maxRedirects: 0 }),
    ).rejects.toMatchObject({
      name: 'EgressBlockedError',
      url: 'http://metadata-rebind.invalid/',
      addressClass: 'link-local',
    });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('safeFetch rejects mixed public/private records at socket lookup', async () => {
    const lookup = vi.fn<LookupFn>()
      .mockResolvedValueOnce([v4('93.184.216.34')])
      .mockResolvedValueOnce([v4('93.184.216.34'), v4('10.0.0.5')]);

    await expect(
      safeFetch('http://mixed.invalid/', {}, { lookup, maxRedirects: 0 }),
    ).rejects.toMatchObject({
      name: 'EgressBlockedError',
      url: 'http://mixed.invalid/',
      addressClass: 'private',
    });
  });

  it('safeFetch rejects injected fetch instead of bypassing socket pinning', async () => {
    const fetchImpl = vi.fn(async () => new Response('unsafe'));
    const unsafeOptions = {
      lookup: mockLookup({ 'safe.invalid': [v4('93.184.216.34')] }),
      fetchImpl,
    } as unknown as SafeFetchOptions;

    await expect(
      safeFetch('http://safe.invalid/', {}, unsafeOptions),
    ).rejects.toThrow(/fetchImpl.*not supported/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('safeFetch pins every redirect hop against a resolver flip', async () => {
    const requests: string[] = [];
    const server = await startHttpServer((request, response) => {
      requests.push(request.url ?? '');
      response.writeHead(302, {
        location: `http://flip.invalid:${server.port}/final`,
      });
      response.end();
    });
    const lookup = vi.fn<LookupFn>(async (hostname) => {
      if (hostname === 'safe.invalid') return [v4('127.0.0.1')];
      const flipCalls = lookup.mock.calls.filter(([host]) => host === 'flip.invalid').length;
      return flipCalls === 1
        ? [v4('93.184.216.34')]
        : [v4('169.254.169.254')];
    });

    try {
      await expect(
        safeFetch(
          `http://safe.invalid:${server.port}/start`,
          {},
          { lookup, allowLocal: true },
        ),
      ).rejects.toMatchObject({
        name: 'EgressBlockedError',
        url: `http://flip.invalid:${server.port}/final`,
        addressClass: 'link-local',
      });
    } finally {
      await server.close();
    }
    expect(requests).toEqual(['/start']);
    expect(lookup).toHaveBeenCalledTimes(4);
  });

  it('safeFetch rejects redirects to metadata and private IP literals', async () => {
    const targets = [
      { url: 'http://169.254.169.254/latest/meta-data/', addressClass: 'link-local' },
      { url: 'http://10.0.0.5/internal', addressClass: 'private' },
    ] as const;

    for (const target of targets) {
      const server = await startHttpServer((_request, response) => {
        response.writeHead(302, { location: target.url });
        response.end();
      });
      const lookup = mockLookup({ 'safe.invalid': [v4('127.0.0.1')] });

      try {
        await expect(
          safeFetch(
            `http://safe.invalid:${server.port}/start`,
            {},
            { lookup, allowLocal: true },
          ),
        ).rejects.toMatchObject({
          name: 'EgressBlockedError',
          url: target.url,
          addressClass: target.addressClass,
        });
      } finally {
        await server.close();
      }
      expect(server.getHits()).toBe(1);
    }
  });

  it('safeFetch applies redirect method/body policy and strips credentials', async () => {
    const requests: Array<{
      host?: string;
      method?: string;
      authorization?: string;
      cookie?: string;
      contentType?: string;
      body: string;
    }> = [];
    const server = await startHttpServer(async (request, response) => {
      requests.push({
        host: request.headers.host,
        method: request.method,
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        contentType: request.headers['content-type'],
        body: await readRequestBody(request),
      });
      if (requests.length === 1) {
        response.writeHead(302, {
          location: `http://second.invalid:${server.port}/final`,
        });
        response.end();
        return;
      }
      response.end('final');
    });
    const lookup = mockLookup({
      'first.invalid': [v4('127.0.0.1')],
      'second.invalid': [v4('127.0.0.1')],
    });

    try {
      const res = await safeFetch(
        `http://first.invalid:${server.port}/start`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer secret',
            cookie: 'session=secret',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ secret: true }),
        },
        { lookup, allowLocal: true },
      );
      expect(await res.text()).toBe('final');
    } finally {
      await server.close();
    }

    expect(requests).toEqual([
      {
        host: `first.invalid:${server.port}`,
        method: 'POST',
        authorization: 'Bearer secret',
        cookie: 'session=secret',
        contentType: 'application/json',
        body: JSON.stringify({ secret: true }),
      },
      {
        host: `second.invalid:${server.port}`,
        method: 'GET',
        authorization: undefined,
        cookie: undefined,
        contentType: undefined,
        body: '',
      },
    ]);
  });

  it('safeFetch refuses to replay a streamed body across a preserving redirect', async () => {
    let calls = 0;
    const server = await startHttpServer(async (request, response) => {
      calls++;
      await readRequestBody(request);
      response.writeHead(307, { location: '/retry' });
      response.end();
    });
    const lookup = mockLookup({ 'safe.invalid': [v4('127.0.0.1')] });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('one-shot'));
        controller.close();
      },
    });

    try {
      await expect(
        safeFetch(
          `http://safe.invalid:${server.port}/stream`,
          { method: 'POST', body, duplex: 'half' } as RequestInit,
          { lookup, allowLocal: true },
        ),
      ).rejects.toThrow(/Cannot replay a streamed request body/i);
    } finally {
      await server.close();
    }
    expect(calls).toBe(1);
  });

  it('safeFetch throws after exceeding the redirect cap', async () => {
    const server = await startHttpServer((_request, response) => {
      response.writeHead(302, { location: '/loop' });
      response.end();
    });
    const lookup = mockLookup({ 'safe.invalid': [v4('127.0.0.1')] });

    try {
      await expect(
        safeFetch(
          `http://safe.invalid:${server.port}/loop`,
          {},
          { lookup, allowLocal: true, maxRedirects: 2 },
        ),
      ).rejects.toThrow(/Exceeded maximum redirects \(2\)/);
    } finally {
      await server.close();
    }
    expect(server.getHits()).toBe(3);
  });
});

describe('UrlAdapter.fetchAndParse SSRF guard', () => {
  const adapter = new UrlAdapter();

  it('fetches and parses one explicitly allowed local page', async () => {
    const previous = process.env.HIVE_MIND_ALLOW_LOCAL_FETCH;
    process.env.HIVE_MIND_ALLOW_LOCAL_FETCH = 'true';
    const server = await startHttpServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end('<html><head><title>Local Ready</title></head><body><h1>Ready</h1><p>Validated local content for the Hive Mind URL adapter.</p></body></html>');
    });

    try {
      const items = await adapter.fetchAndParse(`http://127.0.0.1:${server.port}/ready`);
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Local Ready');
      expect(items[0].content).toContain('Validated local content');
      expect(server.getHits()).toBe(1);
    } finally {
      await server.close();
      if (previous === undefined) delete process.env.HIVE_MIND_ALLOW_LOCAL_FETCH;
      else process.env.HIVE_MIND_ALLOW_LOCAL_FETCH = previous;
    }
  });

  it('applies the 15-second timeout signal before fetching', async () => {
    const previous = process.env.HIVE_MIND_ALLOW_LOCAL_FETCH;
    process.env.HIVE_MIND_ALLOW_LOCAL_FETCH = 'true';
    const timeoutSignal = AbortSignal.abort(new DOMException('timed out', 'TimeoutError'));
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    const server = await startHttpServer((_request, response) => response.end('unexpected'));

    try {
      await expect(
        adapter.fetchAndParse(`http://127.0.0.1:${server.port}/slow`),
      ).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(timeoutSpy).toHaveBeenCalledWith(15_000);
      expect(server.getHits()).toBe(0);
    } finally {
      timeoutSpy.mockRestore();
      await server.close();
      if (previous === undefined) delete process.env.HIVE_MIND_ALLOW_LOCAL_FETCH;
      else process.env.HIVE_MIND_ALLOW_LOCAL_FETCH = previous;
    }
  });

  it('blocks loopback before opening a socket', async () => {
    const previous = process.env.HIVE_MIND_ALLOW_LOCAL_FETCH;
    delete process.env.HIVE_MIND_ALLOW_LOCAL_FETCH;
    const server = await startHttpServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(`<html><body>${'local-only content '.repeat(8)}</body></html>`);
    });
    let outcome: 'resolved' | 'rejected' = 'resolved';
    let rejection = '';

    try {
      await adapter.fetchAndParse(`http://127.0.0.1:${server.port}/private`);
    } catch (error) {
      outcome = 'rejected';
      rejection = error instanceof Error ? error.message : String(error);
    } finally {
      await server.close();
      if (previous === undefined) delete process.env.HIVE_MIND_ALLOW_LOCAL_FETCH;
      else process.env.HIVE_MIND_ALLOW_LOCAL_FETCH = previous;
    }

    expect({ outcome, hits: server.getHits(), rejection }).toEqual({
      outcome: 'rejected',
      hits: 0,
      rejection: expect.stringMatching(/blocked.*loopback/i),
    });
  });

  it('refuses cloud-metadata / loopback / private targets before fetching', async () => {
    await expect(adapter.fetchAndParse('http://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(EgressBlockedError);
    await expect(adapter.fetchAndParse('http://127.0.0.1/')).rejects.toThrow(/loopback/);
    await expect(adapter.fetchAndParse('http://10.0.0.5/secret')).rejects.toThrow(/private/);
  });

  it('refuses non-http(s) schemes', async () => {
    await expect(adapter.fetchAndParse('file:///etc/passwd')).rejects.toThrow(/scheme/i);
  });
});
