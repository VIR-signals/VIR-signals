// Net fetch tests with an injected fake network: hop order, retry shape,
// size gates before any body read, streaming overflow, timeout, cancel,
// bounded concurrency, pack deadline, and URL building.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchFile,
  fetchFiles,
  buildHopUrls,
  encodePath,
  RawIo,
  RawResponse,
} from '../src/engine/net-fetch';

interface FakePlan {
  status?: number;
  chunks?: Buffer[];
  headers?: Record<string, string | undefined>;
  hang?: boolean;
  error?: Error;
}

function makeFakeIo(plan: (url: string) => FakePlan): {
  io: RawIo;
  calls: string[];
  consumed: Set<string>;
} {
  const calls: string[] = [];
  const consumed = new Set<string>();
  const io: RawIo = async (url, signal) => {
    calls.push(url);
    const p = plan(url);
    if (p.error) {
      throw p.error;
    }
    const res: RawResponse = {
      status: p.status ?? 200,
      headers: p.headers ?? {},
      stream: (async function* () {
        if (p.hang) {
          await new Promise<never>((_, rej) => {
            signal.addEventListener('abort', () => rej(new Error('stopped')), { once: true });
          });
        }
        for (const c of p.chunks ?? []) {
          consumed.add(url);
          yield c;
        }
      })(),
    };
    return res;
  };
  return { io, calls, consumed };
}

const U1 = 'https://x.example/a';
const U2 = 'https://cdn.example/b';
const U3 = 'https://m.example/https://x.example/a';

test('first hop failure advances to the second hop', async () => {
  const f = makeFakeIo((u) => (u === U1 ? { status: 404 } : { chunks: [Buffer.from('hi')] }));
  const r = await fetchFile(f.io, [U1, U2], 1000, 5000, new AbortController().signal);
  assert.equal(r.ok, true);
  assert.equal(r.url, U2);
  assert.equal(r.attempts.length, 1);
  assert.equal(r.attempts[0].failure, 'net.httpStatus');
  assert.deepEqual(f.calls, [U1, U2]);
});

test('two failures advance to the mirror hop', async () => {
  const f = makeFakeIo((u) => (u === U3 ? { chunks: [Buffer.from('ok')] } : { status: 500 }));
  const r = await fetchFile(f.io, [U1, U2, U3], 1000, 5000, new AbortController().signal);
  assert.equal(r.ok, true);
  assert.equal(r.url, U3);
  assert.equal(r.attempts.length, 2);
});

test('all hops failing retries the whole chain once and reports every source', async () => {
  const f = makeFakeIo(() => ({ status: 500 }));
  const r = await fetchFile(f.io, [U1, U2, U3], 1000, 5000, new AbortController().signal);
  assert.equal(r.ok, false);
  assert.equal(r.attempts.length, 6);
  assert.ok(r.attempts.every((a) => a.failure === 'net.httpStatus'));
  assert.deepEqual(f.calls, [U1, U2, U3, U1, U2, U3]);
});

test('retry round two succeeds and keeps round one failures', async () => {
  let round = 0;
  const f = makeFakeIo(() => {
    round += 1;
    return round <= 3 ? { status: 404 } : { chunks: [Buffer.from('late')] };
  });
  const r = await fetchFile(f.io, [U1, U2, U3], 1000, 5000, new AbortController().signal);
  assert.equal(r.ok, true);
  assert.equal(r.url, U1);
  assert.equal(r.attempts.length, 3);
});

test('declared Content-Length over the limit aborts before reading the body', async () => {
  const f = makeFakeIo(() => ({
    headers: { 'content-length': '2001' },
    chunks: [Buffer.alloc(100)],
  }));
  const r = await fetchFile(f.io, [U1, U2, U3], 2000, 5000, new AbortController().signal);
  assert.equal(r.ok, false);
  assert.ok(r.attempts.every((a) => a.failure === 'net.oversize'));
  assert.equal(f.consumed.size, 0);
});

test('undeclared body overflowing mid stream aborts with oversize', async () => {
  const f = makeFakeIo((u) =>
    u === U3 ? { chunks: [Buffer.from('small')] } : { chunks: [Buffer.alloc(1500), Buffer.alloc(1500)] }
  );
  const r = await fetchFile(f.io, [U1, U2, U3], 2000, 5000, new AbortController().signal);
  assert.equal(r.ok, true);
  assert.equal(r.url, U3);
  const allHang = makeFakeIo(() => ({ chunks: [Buffer.alloc(1500), Buffer.alloc(1500)] }));
  const r2 = await fetchFile(allHang.io, [U1], 2000, 5000, new AbortController().signal);
  assert.equal(r2.ok, false);
  assert.equal(r2.attempts[0].failure, 'net.oversize');
});

test('hanging stream times out and labels the failure', async () => {
  const f = makeFakeIo(() => ({ hang: true }));
  const r = await fetchFile(f.io, [U1], 1000, 40, new AbortController().signal);
  assert.equal(r.ok, false);
  assert.ok(r.attempts.every((a) => a.failure === 'net.timeout'));
});

test('outer cancel wins over everything', async () => {
  const f = makeFakeIo(() => ({ hang: true }));
  const c = new AbortController();
  const pending = fetchFile(f.io, [U1], 1000, 5000, c.signal);
  setTimeout(() => c.abort(), 30);
  const r = await pending;
  assert.equal(r.ok, false);
  assert.ok(r.attempts.every((a) => a.failure === 'net.aborted'));
});

test('transport level rejection is an io failure', async () => {
  const f = makeFakeIo(() => ({ error: new Error('boom') }));
  const r = await fetchFile(f.io, [U1], 1000, 5000, new AbortController().signal);
  assert.equal(r.ok, false);
  assert.ok(r.attempts.every((a) => a.failure === 'net.io'));
});

test('non 2xx statuses carry the status code', async () => {
  const f = makeFakeIo(() => ({ status: 404 }));
  const r = await fetchFile(f.io, [U1], 1000, 5000, new AbortController().signal);
  assert.equal(r.ok, false);
  assert.equal(r.attempts[0].detail.args[1], 404);
});

test('fetchFiles keeps concurrency bounded and preserves order', async () => {
  const f = makeFakeIo(() => ({ chunks: [Buffer.from('x')] }));
  const jobs = Array.from({ length: 10 }, (_, i) => ({
    name: 'j' + i,
    urls: ['https://x.example/' + i],
    limitBytes: 100,
  }));
  const rs = await fetchFiles(f.io, jobs, { timeoutMs: 5000, deadlineMs: 10_000, concurrency: 4 });
  const peak = (rs as unknown as { peakConcurrency: number }).peakConcurrency;
  assert.equal(peak, 4);
  assert.ok(rs.every((r) => r.ok));
  assert.deepEqual(rs.map((r) => r.name), jobs.map((j) => j.name));
});

test('fetchFiles deadline expires hanging jobs as timeouts', async () => {
  const f = makeFakeIo(() => ({ hang: true }));
  const rs = await fetchFiles(
    f.io,
    [{ name: 'late', urls: ['https://x.example/z'], limitBytes: 100 }],
    { timeoutMs: 5000, deadlineMs: 40 }
  );
  assert.equal(rs[0].ok, false);
  assert.ok(rs[0].attempts.every((a) => a.failure === 'net.timeout'));
});

test('a canceled batch reports every file as aborted', async () => {
  const f = makeFakeIo(() => ({ hang: true }));
  const c = new AbortController();
  const pending = fetchFiles(
    f.io,
    [
      { name: 'a', urls: ['https://x.example/a'], limitBytes: 100 },
      { name: 'b', urls: ['https://x.example/b'], limitBytes: 100 },
    ],
    { timeoutMs: 5000, deadlineMs: 10_000, signal: c.signal }
  );
  setTimeout(() => c.abort(), 30);
  const rs = await pending;
  assert.ok(rs.every((r) => !r.ok));
  assert.ok(rs.every((r) => r.attempts.every((a) => a.failure === 'net.aborted')));
});

test('fetchFiles surfaces per file failures without touching others', async () => {
  const f = makeFakeIo((u) => (u.endsWith('bad') ? { status: 500 } : { chunks: [Buffer.from('k')] }));
  const rs = await fetchFiles(
    f.io,
    [
      { name: 'good', urls: ['https://x.example/good'], limitBytes: 100 },
      { name: 'bad', urls: ['https://x.example/bad'], limitBytes: 100 },
    ],
    { timeoutMs: 5000, deadlineMs: 10_000 }
  );
  assert.equal(rs[0].ok, true);
  assert.equal(rs[1].ok, false);
  assert.equal(rs[1].attempts.length, 2);
});

test('hop urls build in direct, cdn, mirror order', () => {
  const urls = buildHopUrls({
    repo: 'someone/demo-pack',
    ref: '0123456789abcdef0123456789abcdef01234567',
    filePath: 'pack/sounds/a.wav',
    mirrorPrefix: 'https://gh-proxy.example/',
  });
  assert.equal(urls.length, 3);
  assert.match(urls[0], /^https:\/\/raw\.githubusercontent\.com\/someone\/demo-pack\/0123456789abcdef0123456789abcdef01234567\/pack\/sounds\/a\.wav$/);
  assert.match(urls[1], /^https:\/\/cdn\.jsdelivr\.net\/gh\/someone\/demo-pack@0123456789abcdef0123456789abcdef01234567\/pack\/sounds\/a\.wav$/);
  assert.match(urls[2], /^https:\/\/gh-proxy\.example\/https:\/\/raw\.githubusercontent\.com\/someone\/demo-pack\//);
});

test('empty mirror prefix yields two hops', () => {
  const urls = buildHopUrls({
    repo: 'a/b',
    ref: '0123456789abcdef0123456789abcdef01234567',
    filePath: 'pack/manifest.json',
    mirrorPrefix: '',
  });
  assert.equal(urls.length, 2);
});

test('path segments encode one by one', () => {
  assert.equal(encodePath('a b/c%d.wav'), 'a%20b/c%25d.wav');
  assert.equal(encodePath('pack/manifest.json'), 'pack/manifest.json');
});
