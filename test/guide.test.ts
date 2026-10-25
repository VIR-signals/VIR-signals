// One-shot guide claims: the claim files elect a single window per stage
// while the other windows work silently, and a stale claim is reclaimed.
// Mirrors the lock tests but exercises src/ui/guide.ts, which is node pure.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { claimGuide } from '../src/ui/guide';
import { LOCK_STALE_MS } from '../src/engine/paths';
import { makeTempRoot } from './helpers';

// The claim file name is private to guide.ts, so tests discover it as the
// single entry a claim left inside storageDir instead of hardcoding a name.
function onlyClaimFile(storageDir: string): string {
  const names = fs.readdirSync(storageDir);
  assert.equal(names.length, 1);
  return path.join(storageDir, names[0]);
}

function ageClaimFile(p: string, ageMs: number): void {
  const old = new Date(Date.now() - ageMs);
  fs.utimesSync(p, old, old);
}

test('first claim on a stage wins, the second owner is refused', () => {
  const root = makeTempRoot();
  try {
    const storageDir = path.join(root, 'storage');
    assert.equal(claimGuide(storageDir, 'owner-a', 'one'), true);
    assert.equal(claimGuide(storageDir, 'owner-b', 'one'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stages are independent: a claim on one does not block two', () => {
  const root = makeTempRoot();
  try {
    const storageDir = path.join(root, 'storage');
    assert.equal(claimGuide(storageDir, 'owner-a', 'one'), true);
    assert.equal(claimGuide(storageDir, 'owner-b', 'two'), true);
    assert.equal(claimGuide(storageDir, 'owner-c', 'one'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a claim older than the stale window is reclaimed by a new owner', () => {
  const root = makeTempRoot();
  try {
    const storageDir = path.join(root, 'storage');
    assert.equal(claimGuide(storageDir, 'owner-a', 'one'), true);
    // Eleven minutes old: past the ten minute stale window.
    ageClaimFile(onlyClaimFile(storageDir), LOCK_STALE_MS + 60_000);
    assert.equal(claimGuide(storageDir, 'owner-b', 'one'), true);
    const raw = JSON.parse(
      fs.readFileSync(onlyClaimFile(storageDir), 'utf8')
    ) as Record<string, unknown>;
    assert.equal(raw.owner, 'owner-b');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the claim lands inside storageDir as json carrying the owner', () => {
  const root = makeTempRoot();
  try {
    const storageDir = path.join(root, 'storage');
    assert.equal(claimGuide(storageDir, 'owner-a', 'one'), true);
    const claimPath = onlyClaimFile(storageDir);
    const raw = JSON.parse(
      fs.readFileSync(claimPath, 'utf8')
    ) as Record<string, unknown>;
    assert.equal(raw.owner, 'owner-a');
    assert.equal(typeof raw.at, 'number');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
