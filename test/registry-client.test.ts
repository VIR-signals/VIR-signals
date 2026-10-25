// Registry client tests with a fake network: schema gate, entry validation
// of untrusted fields, duplicate ids, network failure shape, and display
// name locale selection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRegistry, displayName, RegistryEntry } from '../src/engine/registry-client';
import { RawIo, RawResponse } from '../src/engine/net-fetch';

function ioWith(body: string | (() => string), status = 200): RawIo {
  return async () => {
    const text = typeof body === 'function' ? body() : body;
    const res: RawResponse = {
      status,
      headers: {},
      stream: (async function* () {
        yield Buffer.from(text, 'utf8');
      })(),
    };
    return res;
  };
}

const GOOD = {
  schema: 1,
  packs: [
    {
      id: 'demo',
      names: { 'zh-cn': 'Demo Pack', en: 'Demo Pack' },
      categories: ['ui'],
      language: 'none',
      author: 'VIR Signals',
      version: '1.0.0',
      repo: 'someone/demo-pack',
      branch: 'main',
      commit: '0123456789abcdef0123456789abcdef01234567',
      packPath: 'pack',
      license: 'CC0-1.0',
      sourceLicense: 'third-party-cc0',
    },
  ],
};

const OPTS = { registryRepo: 'vir/registry', mirrorPrefix: '' };

test('a valid index parses into entries', async () => {
  const r = await fetchRegistry(ioWith(JSON.stringify(GOOD)), OPTS);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].id, 'demo');
    assert.equal(r.entries[0].commit.length, 40);
  }
});

test('schema other than one is refused with the upgrade reason', async () => {
  const bad = { schema: 2, packs: [] };
  const r = await fetchRegistry(ioWith(JSON.stringify(bad)), OPTS);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, 'registry.schema');
    assert.equal(r.error.key, 'registry.schema');
  }
});

test('unparseable index body is a parse failure', async () => {
  const r = await fetchRegistry(ioWith('not json at all'), OPTS);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, 'registry.parse');
  }
});

test('wrong top level shape is refused', async () => {
  const r = await fetchRegistry(ioWith(JSON.stringify({ schema: 1, packs: 'x' })), OPTS);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, 'registry.shape');
  }
});

test('an entry with a bad id refuses the whole index', async () => {
  const bad = { schema: 1, packs: [{ ...GOOD.packs[0], id: 'Bad ID' }] };
  const r = await fetchRegistry(ioWith(JSON.stringify(bad)), OPTS);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, 'registry.entry');
    assert.equal(r.error.key, 'registry.entryId');
  }
});

test('an entry with an escaped packPath is refused', async () => {
  const bad = { schema: 1, packs: [{ ...GOOD.packs[0], packPath: '../etc' }] };
  const r = await fetchRegistry(ioWith(JSON.stringify(bad)), OPTS);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, 'registry.entry');
    assert.equal(r.error.key, 'registry.entryPackPath');
  }
});

test('an entry with a short commit is refused', async () => {
  const bad = { schema: 1, packs: [{ ...GOOD.packs[0], commit: 'abc123' }] };
  const r = await fetchRegistry(ioWith(JSON.stringify(bad)), OPTS);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, 'registry.entry');
    assert.equal(r.error.key, 'registry.entryCommit');
  }
});

test('duplicate ids refuse the index', async () => {
  const dup = { schema: 1, packs: [GOOD.packs[0], GOOD.packs[0]] };
  const r = await fetchRegistry(ioWith(JSON.stringify(dup)), OPTS);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, 'registry.entry');
    assert.equal(r.error.key, 'registry.entryDup');
  }
});

test('a missing required field refuses the entry', async () => {
  const clone: Record<string, unknown> = { ...GOOD.packs[0] };
  delete clone.branch;
  const r = await fetchRegistry(ioWith(JSON.stringify({ schema: 1, packs: [clone] })), OPTS);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.key, 'registry.entryField');
    assert.equal(r.error.args[1], 'branch');
  }
});

test('network failure carries every hop attempt', async () => {
  let calls = 0;
  const io: RawIo = async () => {
    calls += 1;
    const res: RawResponse = {
      status: 500,
      headers: {},
      stream: (async function* () {})(),
    };
    return res;
  };
  const r = await fetchRegistry(io, OPTS);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, 'registry.net');
    assert.equal(r.attempts.length, 4);
    assert.equal(calls, 4);
  }
});

test('display name picks exact locale, primary subtag, then id', () => {
  const entry = {
    id: 'demo',
    names: { 'zh-cn': 'CN', zh: 'ZH', en: 'EN' },
  } as unknown as RegistryEntry;
  assert.equal(displayName(entry, 'zh-cn'), 'CN');
  assert.equal(displayName(entry, 'zh-tw'), 'ZH');
  assert.equal(displayName(entry, 'fr'), 'demo');
  const bare = { id: 'solo', names: {} } as unknown as RegistryEntry;
  assert.equal(displayName(bare, 'zh-cn'), 'solo');
});
