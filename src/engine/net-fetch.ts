// Three-hop network transport for market downloads: direct raw.githubusercontent.com,
// the jsDelivr mirror, then the user mirror prefix. Every size limit is
// enforced BEFORE anything lands on disk: a declared Content-Length over the
// limit aborts before the body is read, and an undeclared body is counted
// while streaming and aborted the moment it overflows.
// The hop IO is behind the RawIo seam so tests can inject a fake network;
// production binds node:https through httpsRawIo. Zero vscode imports.
import * as https from 'node:https';
import { msg, VirMessage } from './msg';

export const REGISTRY_LIMIT_BYTES = 1024 * 1024;
export const MANIFEST_LIMIT_BYTES = 1024 * 1024;
export const SOURCE_TXT_LIMIT_BYTES = 64 * 1024;

export const AUDIO_LIMIT_BYTES = 20 * 1024 * 1024;
export const HOP_TIMEOUT_MS = 30 * 1000;
// Small text fetches (index, manifests) are kilobyte scale: a short hop
// timeout keeps the picker from hanging for minutes when the registry
// host is unreachable.
export const TEXT_HOP_TIMEOUT_MS = 10 * 1000;
export const PACK_DEADLINE_MS = 120 * 1000;
export const PACK_CONCURRENCY = 4;

export interface RawResponse {
  status: number;
  headers: Record<string, string | undefined>;
  stream: AsyncIterable<Buffer>;
}

export type RawIo = (url: string, signal: AbortSignal, headers?: Record<string, string>) => Promise<RawResponse>;

export type HopFailure =
  | 'net.httpStatus'
  | 'net.timeout'
  | 'net.oversize'
  | 'net.aborted'
  | 'net.io';

export interface HopAttempt {
  url: string;
  failure: HopFailure;
  detail: VirMessage;
}

export type HopOutcome =
  | { ok: true; data: Buffer }
  | { ok: false; failure: HopFailure; detail: VirMessage };

// One hop: status gate, declared length gate, streamed length gate, timeout.
async function runHop(
  rawIo: RawIo,
  url: string,
  limitBytes: number,
  timeoutMs: number,
  outerSignal: AbortSignal,
  headers?: Record<string, string>
): Promise<HopOutcome> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  outerSignal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);
  try {
    const res = await rawIo(url, controller.signal, headers);
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, failure: 'net.httpStatus', detail: msg('net.httpStatus', url, res.status) };
    }
    const declaredRaw = res.headers['content-length'];
    if (declaredRaw !== undefined) {
      const declared = Number(declaredRaw);
      if (Number.isFinite(declared) && declared > limitBytes) {
        return { ok: false, failure: 'net.oversize', detail: msg('net.oversize', url, declared, limitBytes) };
      }
    }
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of res.stream) {
      received += chunk.length;
      if (received > limitBytes) {
        stop();
        return { ok: false, failure: 'net.oversize', detail: msg('net.oversize', url, received, limitBytes) };
      }
      chunks.push(chunk as Buffer);
    }
    if (outerSignal.aborted) {
      return { ok: false, failure: 'net.aborted', detail: msg('net.aborted', url) };
    }
    return { ok: true, data: Buffer.concat(chunks) };
  } catch {
    if (outerSignal.aborted) {
      return { ok: false, failure: 'net.aborted', detail: msg('net.aborted', url) };
    }
    if (controller.signal.aborted) {
      return { ok: false, failure: 'net.timeout', detail: msg('net.timeout', url, timeoutMs) };
    }
    return { ok: false, failure: 'net.io', detail: msg('net.io', url) };
  } finally {
    clearTimeout(timer);
    outerSignal.removeEventListener('abort', stop);
  }
}

export type FetchFileOutcome =
  | { ok: true; data: Buffer; url: string; attempts: HopAttempt[] }
  | { ok: false; attempts: HopAttempt[] };

// One file through the hop chain. When the whole chain fails it is retried
// exactly once, per the transport contract; every failed attempt is kept so
// the report can show per-source reasons instead of a single blank error.
export async function fetchFile(
  rawIo: RawIo,
  urls: ReadonlyArray<string>,
  limitBytes: number,
  timeoutMs: number,
  signal: AbortSignal,
  headers?: Record<string, string>
): Promise<FetchFileOutcome> {
  const attempts: HopAttempt[] = [];
  for (let round = 0; round < 2; round++) {
    for (const url of urls) {
      const r = await runHop(rawIo, url, limitBytes, timeoutMs, signal, headers);
      if (r.ok) {
        return { ok: true, data: r.data, url, attempts };
      }
      attempts.push({ url, failure: r.failure, detail: r.detail });
    }
  }
  return { ok: false, attempts };
}

// A batch of files under one pack deadline with bounded concurrency. Results
// come back in job order; a job that never starts because the deadline ran
// out reports a timeout attempt for its first URL. The peak pool width is
// attached to the results array for the tests to assert on.
export async function fetchFiles(
  rawIo: RawIo,
  jobs: ReadonlyArray<{ urls: ReadonlyArray<string>; limitBytes: number; name: string }>,
  opts: { timeoutMs: number; deadlineMs: number; concurrency?: number; signal?: AbortSignal }
): Promise<Array<{ name: string } & FetchFileOutcome>> {
  const deadline = Date.now() + opts.deadlineMs;
  const concurrency = opts.concurrency ?? PACK_CONCURRENCY;
  const userSignal = opts.signal ?? new AbortController().signal;
  const results: Array<{ name: string } & FetchFileOutcome> = new Array(jobs.length);
  let next = 0;
  let live = 0;
  let peak = 0;
  let settle: () => void;
  const allSettled = new Promise<void>((r) => {
    settle = r;
  });

  const runOne = async (index: number): Promise<void> => {
    const job = jobs[index];
    const left = deadline - Date.now();
    if (left <= 0) {
      results[index] = {
        name: job.name,
        ok: false,
        attempts: [{ url: job.urls[0], failure: 'net.timeout', detail: msg('net.timeout', job.name, 0) }],
      };
      return;
    }
    // Deadline enforcement rides the per-hop timer (min of hop timeout and
    // time left) so an expired pack reports timeouts, not cancels; the user
    // cancel signal passes through untouched.
    const r = await fetchFile(
      rawIo,
      job.urls,
      job.limitBytes,
      Math.min(opts.timeoutMs, left),
      userSignal
    );
    results[index] = { name: job.name, ...r };
  };

  const pump = (): void => {
    while (live < concurrency && next < jobs.length) {
      const i = next;
      next += 1;
      live += 1;
      if (live > peak) {
        peak = live;
      }
      void runOne(i).then(() => {
        live -= 1;
        pump();
      });
    }
    if (next >= jobs.length && live === 0) {
      settle();
    }
  };
  pump();
  await allSettled;
  Object.defineProperty(results, 'peakConcurrency', { value: peak });
  return results;
}

// Segment-wise URL encoding: every path segment is encoded on its own so
// slashes stay structural and special characters can never smuggle a
// traversal across segments.
export function encodePath(rel: string): string {
  return rel
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

export interface HopUrlsInput {
  repo: string;
  /** Immutable commit for pack files, or the branch name for the index. */
  ref: string;
  filePath: string;
  mirrorPrefix: string;
}

// The three-hop chain for one file inside a pack repository at a ref.
export function buildHopUrls(input: HopUrlsInput): string[] {
  const [owner, name] = input.repo.split('/');
  const encRepo = encodeURIComponent(owner) + '/' + encodeURIComponent(name);
  const encPath = encodePath(input.filePath);
  const direct =
    'https://raw.githubusercontent.com/' + encRepo + '/' + input.ref + '/' + encPath;
  const cdn = 'https://cdn.jsdelivr.net/gh/' + encRepo + '@' + input.ref + '/' + encPath;
  const hops = [direct, cdn];
  if (input.mirrorPrefix !== '') {
    hops.push(input.mirrorPrefix + direct);
  }
  return hops;
}

// Production hop IO on node:https. The response stream is the raw
// IncomingMessage exposed as an async iterable.
export function httpsRawIo(
  url: string,
  signal: AbortSignal,
  headers?: Record<string, string>
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers as Record<string, string | undefined>,
        stream: res as unknown as AsyncIterable<Buffer>,
      });
    });
    req.on('error', reject);
    signal.addEventListener('abort', () => req.destroy(), { once: true });
  });
}
