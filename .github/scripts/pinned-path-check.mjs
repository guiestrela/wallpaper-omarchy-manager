// Exercise pinned selection against real temporary files and the QML policy.
// Only a mkdtemp fixture is scanned; no user wallpaper or destructive action.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const source = readFileSync(new URL('../../Background.qml', import.meta.url), 'utf8');
function extract(name) {
  const match = source.match(new RegExp(`^  function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}`, 'm'));
  assert.ok(match, `QML function ${name} exists`);
  return match[0];
}
const scannerLine = source.split('\n').find(line => line.includes('test -d') && line.trim().startsWith('"'));
assert.ok(scannerLine, 'fixed scanner command exists');
const scanner = vm.runInNewContext(scannerLine.trim().replace(/,$/, ''));
const pickFunction = extract('pickForScreens');
const stageKeyFunction = extract('pinnedStageKey');
const shuffleFunction = extract('shuffle');

function scan(folder) {
  const result = spawnSync('/bin/bash', ['-c', scanner, 'wpm-test', folder, '-maxdepth 1'], {
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, `safe synthetic scan: ${result.stderr || ''}`);
  return result.stdout.split('\n').filter(Boolean);
}

function makeContext(folder, pinned, files) {
  const key = JSON.stringify([folder, true]);
  const context = vm.createContext({
    screenNames: () => ['DP-1'],
    displayedMap: {},
    configFor: () => ({ folder, recursive: true, mode: 'single', pinned }),
    poolKeyFor: () => key,
    usablePoolFor: requested => requested === key ? files : [],
    stagedPinnedPaths: pinned ? { [JSON.stringify([folder, pinned])]: '/tmp/synthetic-snapshot' } : {},
    independentDisplayPicks: true,
  });
  vm.runInContext(`${stageKeyFunction}; ${pickFunction}; this.pickForScreens = pickForScreens`, context);
  return context;
}

const temp = mkdtempSync(join(tmpdir(), 'wpm-pinned-'));
try {
  const root = join(temp, 'A');
  const outside = join(temp, 'B');
  mkdirSync(root);
  mkdirSync(outside);
  const regular = join(root, 'regular.jpg');
  const outsideImage = join(outside, 'outside.jpg');
  const linkedImage = join(root, 'linked.jpg');
  const linkedDirectory = join(root, 'linked-dir');
  writeFileSync(regular, 'synthetic image');
  writeFileSync(outsideImage, 'synthetic external image');
  symlinkSync(outsideImage, linkedImage);
  symlinkSync(outside, linkedDirectory, 'dir');

  const firstScan = scan(root);
  assert.ok(firstScan.includes(regular), 'regular file is discoverable');
  assert.ok(!firstScan.includes(linkedImage), 'find -P excludes a symlinked file');
  assert.ok(!firstScan.some(path => path.startsWith(`${linkedDirectory}/`)), 'find -P does not traverse a symlinked directory');

  assert.equal(makeContext(root, regular, firstScan).pickForScreens()['DP-1'], regular,
    'regular discovered pin remains usable');
  assert.equal(makeContext(root, linkedImage, firstScan).pickForScreens()['DP-1'], undefined,
    'symlink to an outside file is not selected');
  assert.equal(makeContext(root, outsideImage, firstScan).pickForScreens()['DP-1'], undefined,
    'outside path is not selected');
  assert.equal(makeContext(root, `${root}2/regular.jpg`, firstScan).pickForScreens()['DP-1'], undefined,
    'lookalike root prefix is not selected');
  assert.equal(makeContext(root, `${root}/../B/outside.jpg`, firstScan).pickForScreens()['DP-1'], undefined,
    'parent traversal is not selected');

  // Reproduce a path swapped from a regular file to an external symlink after
  // the previous scan. The next shuffle must rescan before applying that path.
  const replaced = join(root, 'replace.jpg');
  writeFileSync(replaced, 'synthetic image');
  const staleScan = scan(root);
  assert.ok(staleScan.includes(replaced), 'pre-swap regular file is in prior scan');
  unlinkSync(replaced);
  symlinkSync(outsideImage, replaced);
  let rescans = 0;
  let applied = 0;
  const key = JSON.stringify([root, true]);
  const staleContext = vm.createContext({
    hasServiceContext: () => true,
    hasFolder: () => true,
    poolLoaded: true,
    hasPinned: () => true,
    pinnedPoolFresh: false,
    rescan: () => { rescans++; },
    screenNames: () => ['DP-1'],
    displayedMap: {},
    configFor: () => ({ folder: root, recursive: true, mode: 'single', pinned: replaced }),
    poolKeyFor: () => key,
    usablePoolFor: requested => requested === key ? staleScan : [],
    applyPerScreen: () => { applied++; },
    syncCurrentLink: () => {},
    topUpQueues: () => {},
  });
  vm.runInContext(`${pickFunction}; ${shuffleFunction}; this.shuffle = shuffle`, staleContext);
  staleContext.shuffle(false);
  assert.equal(rescans, 1, 'a stale pinned pool is rescanned before a shuffle');
  assert.equal(applied, 0, 'stale pre-swap path is not applied');

  const refreshed = scan(root);
  assert.ok(!refreshed.includes(replaced), 'fresh scan excludes the replaced symlink');
  assert.equal(makeContext(root, replaced, refreshed).pickForScreens()['DP-1'], undefined,
    'replacement symlink remains unusable after refresh');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log('Pinned path checks passed for discovered files, symlinked file/directory, prefix traversal, and post-scan replacement.');
