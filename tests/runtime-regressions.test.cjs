const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const directory = path.resolve(__dirname, '..');
const background = fs.readFileSync(path.join(directory, 'Background.qml'), 'utf8');
const renderer = fs.readFileSync(path.join(directory, 'WallpaperRenderer.qml'), 'utf8');

// Balanced QML JavaScript extraction; comments and quoted braces are inert.
function block(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `Missing ${marker}`);
  const begin = source.indexOf('{', start);
  let depth = 0, quote = '', escaped = false, line = false, comment = false;
  for (let i = begin; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (line) { if (c === '\n') line = false; continue; }
    if (comment) { if (c === '*' && next === '/') { comment = false; i++; } continue; }
    if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = ''; continue; }
    if (c === '/' && next === '/') { line = true; i++; continue; }
    if (c === '/' && next === '*') { comment = true; i++; continue; }
    if ('\'"`'.includes(c)) { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Unbalanced ${marker}`);
}
function body(source, marker) {
  const value = block(source, marker);
  return value.slice(value.indexOf('{') + 1, -1);
}
const timer = () => ({ starts: 0, restart() { this.starts++; }, stop() {} });
function scope(functions, overrides = {}) {
  const state = {
    console, serviceActive: true, home: '/home/test', currentBackground: '/theme/default.jpg',
    screenNames: () => ['DP-1', 'DP-2'], hasServiceContext: () => true,
    displayedMap: {}, incomingMap: {}, oldMap: {}, slotAMap: {}, slotBMap: {}, frontSlot: 0,
    backgroundVersion: 0, revealStartedVersion: -1, incomingReady: {}, incomingFailed: {}, revealArmed: false,
    revealProgress: 1, revealAnimation: timer(), revealArmTimeout: timer(),
    configReload: timer(), pruneStagedPinnedPaths() {}, hasFolder: () => true,
    stagedPinnedPaths: {}, stagedPinnedLeaseTokens: {}, failedPinnedPaths: {},
    dirtyPinnedPaths: {}, themeContentVersion: 0, appliedThemeContentVersion: 0,
    slotAGeneration: 0, slotBGeneration: 0, pendingPinnedLeaseReleases: [],
    ...overrides,
  };
  state.root = state;
  vm.createContext(state);
  for (const name of functions) vm.runInContext(block(background, `function ${name}(`), state);
  return state;
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }
function binding(source, id, name, fallback) {
  const start = source.indexOf(`id: ${id}\n`);
  assert.ok(start >= 0, `Missing id ${id}`);
  const component = source.slice(start, source.indexOf('\n      }', start));
  const match = component.match(new RegExp(`^\\s*${name}: (.+(?:\\n\\s+[?:].+)*)`, 'm'));
  return match ? match[1] : fallback;
}

test('reveal timeout preserves the front slot until every display has decoded', () => {
  const s = scope(['handleRevealTimeout'], {
    backgroundVersion: 7,
    revealTimedOutVersion: -1,
    screenNames: () => ['DP-1', 'DP-2'],
    incomingReady: { 'DP-1': true },
    frontSlot: 0,
    revealProgress: 0,
    slotAMap: { 'DP-1': '/old/one.png', 'DP-2': '/old/two.png' },
    slotBMap: { 'DP-1': '/new/one.png', 'DP-2': '/new/two.png' },
  });
  const timeoutStart = background.indexOf('id: revealArmTimeout');
  const timeoutEnd = background.indexOf('// --------------------------------------------------------------- actions', timeoutStart);
  const timeoutCode = background.slice(timeoutStart, timeoutEnd).split(String.fromCharCode(10))
    .find(line => line.trim().startsWith('onTriggered:')).split(':').slice(1).join(':').trim();
  vm.runInContext(timeoutCode, s);
  assert.equal(s.revealTimedOutVersion, 7, 'timeout should be tied to its transition generation');
  assert.equal(s.revealArmed, false);
  assert.equal(s.frontSlot, 0);
  assert.deepEqual(plain(s.slotAMap), { 'DP-1': '/old/one.png', 'DP-2': '/old/two.png' });
  assert.deepEqual(plain(s.slotBMap), { 'DP-1': '/new/one.png', 'DP-2': '/new/two.png' });
  assert.equal(s.revealAnimation.starts, 0);
});

test('late decoder readiness is ignored when its transition generation or path is stale', () => {
  const s = scope(['noteIncomingReady'], {
    backgroundVersion: 2,
    incomingMap: { 'DP-1': '/new/one.png', 'DP-2': '/new/two.png' },
    incomingReady: {},
    armRevealIfReady() {},
  });
  s.noteIncomingReady('DP-2', 1, '/old/two.png');
  assert.deepEqual(plain(s.incomingReady), {});
  s.noteIncomingReady('DP-2', 2, '/new/two.png');
  assert.deepEqual(plain(s.incomingReady), { 'DP-2': true });
});

test('arm refuses to expose an incoming slot while any display is unready', () => {
  const s = scope(['armReveal', 'incomingReadyForCurrentTransition'], {
    backgroundVersion: 3,
    screenNames: () => ['DP-1', 'DP-2'],
    incomingReady: { 'DP-1': true },
    revealStartedVersion: -1,
    applyPendingTheme() {},
  });
  s.armReveal();
  assert.equal(s.revealArmed, false);
  assert.equal(s.revealAnimation.starts, 0);
  assert.equal(s.revealStartedVersion, -1);
});

test('a stale animation completion cannot promote or release an unready display slot', () => {
  let prunes = 0;
  const s = scope(['incomingReadyForCurrentTransition'], {
    backgroundVersion: 9,
    revealStartedVersion: -1,
    incomingReady: { 'DP-1': true },
    frontSlot: 0,
    currentBackground: '/new/one.png',
    displayedMap: { 'DP-1': '/old/one.png', 'DP-2': '/old/two.png' },
    incomingMap: { 'DP-1': '/new/one.png', 'DP-2': '/new/two.png' },
    slotAMap: { 'DP-1': '/old/one.png', 'DP-2': '/old/two.png' },
    slotBMap: { 'DP-1': '/new/one.png', 'DP-2': '/new/two.png' },
    screenNames: () => ['DP-1', 'DP-2'],
    hasFolder: () => false,
    pruneStagedPinnedPaths() { prunes++; },
  });
  const finishBody = body(background.slice(background.indexOf('id: revealAnimation')), 'onFinished:');
  vm.runInContext(`(function() { ${finishBody} })()`, s);
  assert.equal(s.frontSlot, 0);
  assert.deepEqual(plain(s.slotAMap), { 'DP-1': '/old/one.png', 'DP-2': '/old/two.png' });
  assert.deepEqual(plain(s.displayedMap), { 'DP-1': '/old/one.png', 'DP-2': '/old/two.png' });
  assert.equal(prunes, 0);
});

test('decoder errors from stale paths or generations cannot poison current media', () => {
  const replacements = [];
  const s = scope(['noteBadImage', 'noteIncomingReady'], {
    backgroundVersion: 5,
    incomingMap: { 'DP-1': '/current/new.png' },
    incomingReady: {},
    badImages: {},
    dropFromQueue() {},
    replaceBadImage(path) { replacements.push(path); },
    armRevealIfReady() {},
  });
  s.noteBadImage('/previous/old.png', 'DP-1', 4);
  assert.deepEqual(plain(s.badImages), {});
  assert.deepEqual(replacements, []);
  s.noteBadImage('/current/new.png', 'DP-1', 4);
  assert.deepEqual(plain(s.badImages), {});
  s.noteBadImage('/current/new.png', 'DP-1', 5);
  assert.deepEqual(plain(s.badImages), { '/current/new.png': true });
  assert.deepEqual(replacements, ['/current/new.png']);
  s.noteIncomingReady('DP-1', 5, '/current/new.png');
  assert.deepEqual(plain(s.incomingReady), {}, 'a later ready callback must not revive a failed incoming frame');
});

test('renderer errors are matched to slot source, generation, and display before affecting state', () => {
  let prunes = 0;
  let stops = 0;
  const s = scope(['noteRendererError', 'noteBadImage', 'noteIncomingReady'], {
    backgroundVersion: 4,
    frontSlot: 0,
    displayedMap: { 'DP-1': '/logical/old.png', 'DP-2': '/logical/other-old.png' },
    incomingMap: { 'DP-1': '/logical/new.png', 'DP-2': '/logical/other-new.png' },
    slotAMap: { 'DP-1': '/logical/old.png', 'DP-2': '/logical/other-old.png' },
    slotBMap: { 'DP-1': '/logical/new.png', 'DP-2': '/logical/other-new.png' },
    slotAGeneration: 1,
    slotBGeneration: 2,
    incomingReady: {},
    incomingFailed: {},
    revealStartedVersion: 4,
    revealProgress: 0.6,
    revealArmed: true,
    revealAnimation: { stop() { stops++; }, restart() {} },
    badImages: {},
    renderPathFor: (logical, generation) => `/cache/${generation}/${logical.split('/').pop()}`,
    dropFromQueue() {},
    replaceBadImage() {},
    armRevealIfReady() {},
    pruneStagedPinnedPaths() { prunes++; },
  });
  s.noteRendererError('DP-1', 1, '/cache/1/old.png');
  assert.deepEqual(plain(s.badImages), {}, 'a stale slot error must be ignored');
  s.noteRendererError('DP-1', 1, '/cache/2/new.png');
  assert.deepEqual(plain(s.badImages), { '/logical/new.png': true });
  assert.deepEqual(plain(s.incomingFailed), { 'DP-1': '/logical/new.png' });
  assert.equal(stops, 1, 'a decoder error during reveal must cancel the animation');
  assert.equal(s.revealProgress, 0, 'the prior visible frame must be restored');
  assert.equal(s.revealArmed, false);
  s.noteIncomingReady('DP-1', 4, '/logical/new.png');
  assert.deepEqual(plain(s.incomingReady), {}, 'failed incoming media cannot be revived by late readiness');
  assert.deepEqual(plain(s.slotAMap), { 'DP-1': '/logical/old.png', 'DP-2': '/logical/other-old.png' });
  assert.equal(prunes, 0, 'the visible front slot lease must not be pruned');
});

test('mixed: default output survives custom shuffle and slot promotion', () => {
  const s = scope(['pickForScreens', 'applyPerScreen', 'beginTransition', 'displayedIsEmpty', 'incomingReadyForCurrentTransition'], {
    displayedMap: { 'DP-1': '/custom/old.jpg', 'DP-2': '/theme/default.jpg' },
    slotAMap: { 'DP-1': '/custom/old.jpg', 'DP-2': '/theme/default.jpg' },
    configFor: name => ({ folder: name === 'DP-1' ? '/custom' : '', mode: 'shuffle', pinned: '' }),
    poolKeyFor: name => name === 'DP-1' ? 'custom' : '',
    usablePoolFor: () => ['/custom/next.jpg'], dealNext: () => ['/custom/next.jpg'],
    independentDisplayPicks: true,
  });
  const picks = s.pickForScreens();
  assert.equal(picks['DP-2'], '/theme/default.jpg');
  s.applyPerScreen(picks, false);
  assert.deepEqual(plain(s.slotBMap), { 'DP-1': '/custom/next.jpg', 'DP-2': '/theme/default.jpg' });
  s.incomingReady = { 'DP-1': true, 'DP-2': true };
  s.revealStartedVersion = s.backgroundVersion;
  vm.runInContext(`(function() { ${body(background.slice(background.indexOf('NumberAnimation {')), 'onFinished:')} })()`, s);
  assert.equal(s.frontSlot, 1);
  assert.deepEqual(plain(s.displayedMap), plain(s.slotBMap));
  assert.deepEqual(plain(s.slotAMap), {});
  // A partial recovery must not erase a healthy output from the next slot.
  s.applyPerScreen({ 'DP-1': '/custom/recovered.jpg' }, false);
  assert.equal(s.slotAMap['DP-2'], '/theme/default.jpg');
});

test('mixed: folder-mode startup resolves native sources instead of a published custom link', () => {
  const s = scope([], {
    currentBackground: '', text: '/custom/published.jpg', currentLinkStateReady: false,
    isStagedSnapshotPath: () => false, shuffle() {}, nativeDefaultProc: { running: false },
  });
  vm.runInContext(`(function() { ${body(background.slice(background.indexOf('id: readlinkProc')), 'onStreamFinished:')} })()`, s);
  assert.equal(s.currentBackground, '', 'published custom link must never become the default');
  assert.equal(s.nativeDefaultProc.running, true);
  assert.equal(s.currentLinkStateReady, true);
});

test('mixed: native-source command ignores an overwritten custom publication on disk', () => {
  const { execFileSync } = require('node:child_process');
  const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'wpm-native-default-'));
  try {
    const current = path.join(temporary, '.local/state/omarchy/current');
    const sources = path.join(current, 'theme/backgrounds');
    fs.mkdirSync(sources, { recursive: true });
    fs.writeFileSync(path.join(current, 'theme.name'), 'fixture');
    const expected = path.join(sources, 'native.png');
    fs.writeFileSync(expected, 'fixture filename only; no decoding in this test');
    const custom = path.join(temporary, 'custom.png');
    fs.writeFileSync(custom, 'not a native source');
    fs.symlinkSync(custom, path.join(current, 'background'));
    const s = scope(['nativeDefaultCommand'], { home: temporary });
    const command = s.nativeDefaultCommand();
    assert.equal(execFileSync(command[0], Array.from(command.slice(1)), { encoding: 'utf8' }).trim(), expected);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('mixed: native fallback excludes linked files and control-bearing names', () => {
  const { execFileSync } = require('node:child_process');
  const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'wpm-native-filter-'));
  try {
    const sources = path.join(temporary, '.local/state/omarchy/current/theme/backgrounds');
    fs.mkdirSync(sources, { recursive: true });
    const expected = path.join(sources, 'zz-native.png');
    fs.writeFileSync(expected, 'fixture');
    const outside = path.join(temporary, 'outside.png');
    fs.writeFileSync(outside, 'outside fixture');
    fs.symlinkSync(outside, path.join(sources, '00-linked.png'));
    fs.writeFileSync(path.join(sources, '01-control\u0080.png'), 'invalid filename');
    const s = scope(['nativeDefaultCommand'], { home: temporary });
    const command = s.nativeDefaultCommand();
    assert.equal(execFileSync(command[0], Array.from(command.slice(1)), { encoding: 'utf8' }).trim(), expected);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('mixed: late native discovery cannot overwrite the latest pending theme fallback', () => {
  const s = scope([], { text: '/native/discovered.jpg', shuffle() {} });
  const callback = background.includes('id: nativeDefaultProc')
    ? body(background.slice(background.indexOf('id: nativeDefaultProc')), 'onStreamFinished:') : '';
  s.currentBackground = '';
  vm.runInContext(`(function() { ${callback} })()`, s);
  assert.equal(s.currentBackground, '/native/discovered.jpg');
  s.currentBackground = '/theme/latest-pending.jpg';
  vm.runInContext(`(function() { ${callback} })()`, s);
  assert.equal(s.currentBackground, '/theme/latest-pending.jpg');
});

test('mixed: native theme handoff updates defaults without dealing custom outputs', () => {
  const s = scope(['setBackground', 'syncDisplayedCurrentLink', 'applyPerScreen', 'beginTransition', 'displayedIsEmpty'], {
    displayedMap: { 'DP-1': '/custom/pinned.jpg', 'DP-2': '/theme/default.jpg' },
    configFor: name => ({ folder: name === 'DP-1' ? '/custom' : '' }),
    primaryScreenName: () => 'DP-1', syncCurrentLink() {}, folderLinkRepairTimer: timer(),
  });
  s.setBackground('/theme/new.jpg', false);
  assert.equal(s.currentBackground, '/theme/new.jpg');
  assert.deepEqual(plain(s.incomingMap), { 'DP-1': '/custom/pinned.jpg', 'DP-2': '/theme/new.jpg' });
});

test('hotplug: unchanged global path reconciles new outputs before deduplicating', () => {
  const s = scope(['applyGlobal', 'beginTransition', 'displayedIsEmpty', 'incomingReadyForCurrentTransition'], {
    hasFolder: () => false,
    displayedMap: { 'DP-1': '/theme/default.jpg' },
    slotAMap: { 'DP-1': '/theme/default.jpg' },
  });
  s.applyGlobal('', '/theme/default.jpg', '/theme/default.jpg', false, false);
  assert.equal(s.slotBMap['DP-2'], '/theme/default.jpg');
  assert.equal(s.backgroundVersion, 1);
  s.applyGlobal('', '/theme/default.jpg', '/theme/default.jpg', false, false);
  assert.equal(s.backgroundVersion, 1);
  s.incomingReady = { 'DP-1': true, 'DP-2': true };
  s.revealStartedVersion = s.backgroundVersion;
  vm.runInContext(`(function() { ${body(background.slice(background.indexOf('NumberAnimation {')), 'onFinished:')} })()`, s);
  s.applyGlobal('', '/theme/default.jpg', '/theme/default.jpg', false, false);
  assert.equal(s.backgroundVersion, 1, 'fully covered outputs remain a no-op');
  s.screenNames = () => ['DP-2'];
  s.applyGlobal('', '/theme/default.jpg', '/theme/default.jpg', false, false);
  assert.deepEqual(Object.keys(s.incomingMap), ['DP-2'], 'unplugged outputs are removed');
});

test('theme: stable contents refresh decoder generation and restage only theme pins', () => {
  const theme = '/home/test/.local/state/omarchy/current/theme/backgrounds';
  const configs = {
    'DP-1': { folder: theme, pinned: `${theme}/same.png`, mode: 'single' },
    'DP-2': { folder: '/custom', pinned: '/custom/keep.png', mode: 'single' },
  };
  const s = scope(['refreshThemeFolder', 'pinnedStageKey', 'ensurePinnedMedia', 'applyPerScreen', 'beginTransition', 'displayedIsEmpty'], {
    configFor: name => configs[name], poolKeyFor: name => configs[name].folder,
    usablePoolFor: key => [key + (key === theme ? '/same.png' : '/keep.png')],
    currentLinkStateReady: true, pinStageProc: { running: false }, pinnedLeaseRenewalUnavailable: false,
    pythonPath: '/python', pinStagerPath: '/stage', activeStagedSnapshots: () => ['/cache/old.png'],
    displayedMap: { 'DP-1': configs['DP-1'].pinned, 'DP-2': configs['DP-2'].pinned },
  });
  const oldKey = s.pinnedStageKey(theme, configs['DP-1'].pinned);
  const customKey = s.pinnedStageKey('/custom', '/custom/keep.png');
  s.stagedPinnedPaths[oldKey] = '/cache/old.png';
  s.stagedPinnedPaths[customKey] = '/cache/custom.png';
  s.refreshThemeFolder();
  assert.equal(s.themeContentVersion, 1, 'identity changes invalidate content, not only filenames');
  assert.notEqual(s.pinnedStageKey(theme, configs['DP-1'].pinned), oldKey);
  assert.equal(s.pinnedStageKey('/custom', '/custom/keep.png'), customKey);
  assert.equal(s.ensurePinnedMedia(), false);
  assert.equal(s.pinStageProc.running, true, 'equal logical theme pin must be staged again');
  assert.deepEqual(plain(s.pinStageProc.command.slice(2, 4)), [theme, configs['DP-1'].pinned]);
  assert.equal(s.stagedPinnedPaths[oldKey], '/cache/old.png', 'prior leased snapshot remains available during restaging');
  s.applyPerScreen(s.displayedMap, false);
  assert.equal(s.backgroundVersion, 1, 'equal logical paths still start a fresh renderer generation');
  assert.equal(s.slotAGeneration, 0, 'visible old slot is not reloaded');
  assert.equal(s.slotBGeneration, 1);
  s.applyPerScreen(s.displayedMap, false);
  assert.equal(s.backgroundVersion, 1, 'generation is consumed once');
});

test('theme: publishing a new pin generation cannot replace the visible slot', () => {
  const folder = '/home/test/.local/state/omarchy/current/theme/backgrounds';
  const pin = folder + '/same.png';
  const deferred = [];
  const s = scope(['pinnedStageKey', 'renderPathFor', 'finishPinnedStage', 'applyPerScreen', 'beginTransition', 'displayedIsEmpty', 'incomingReadyForCurrentTransition'], {
    screenNames: () => ['DP-1'], configFor: () => ({ folder, pinned: pin }),
    displayedMap: { 'DP-1': pin }, slotAMap: { 'DP-1': pin },
    safePath: value => value, isStagedSnapshotPath: () => true,
    Qt: { callLater: callback => deferred.push(callback) }, shuffle() {},
  });
  s.stagedPinnedPaths[s.pinnedStageKey(folder, pin)] = '/cache/old.png';
  s.themeContentVersion = 1;
  s.stagingPinFolder = folder; s.stagingPinPath = pin;
  s.stagingPinKey = s.pinnedStageKey(folder, pin);
  s.finishPinnedStage(0, JSON.stringify({ path: '/cache/new.png', lease: 'a'.repeat(32) }));
  const source = (id, logical) => vm.runInNewContext(binding(background, id, 'sourcePath'), {
    root: s, panel: { slotAPath: logical, slotBPath: logical },
  });
  assert.equal(source('frameA', pin), '/cache/old.png', 'front slot must retain old physical media before shuffle');
  s.applyPerScreen({ 'DP-1': pin }, false);
  assert.equal(source('frameA', pin), '/cache/old.png', 'front slot remains unchanged during incoming preparation');
  assert.equal(source('frameB', pin), '/cache/new.png', 'incoming slot resolves its own generation');
  s.incomingReady = { 'DP-1': true };
  s.revealStartedVersion = s.backgroundVersion;
  vm.runInContext(`(function() { ${body(background.slice(background.indexOf('NumberAnimation {')), 'onFinished:')} })()`, s);
  assert.equal(s.frontSlot, 1);
  assert.equal(source('frameB', pin), '/cache/new.png');
  assert.deepEqual(plain(s.slotAMap), {});
});

test('theme: generation binding reloads actual renderer handler without changing source', () => {
  assert.ok(renderer.includes('property int sourceGeneration:'), 'renderer exposes a content-generation input');
  for (const [id, property] of [['frameA', 'slotAGeneration'], ['frameB', 'slotBGeneration']])
    assert.equal(vm.runInNewContext(binding(background, id, 'sourceGeneration', '-1'), { root: { [property]: 7 } }), 7);
  const assignments = [];
  const child = { set active(value) { assignments.push(value); }, sourceComponent: null };
  const s = { sourcePath: '/theme/same.png', sourceGeneration: 1, loadMedia: true, ready: true,
    naturalWidth: 100, naturalHeight: 100, renderer: child, imageComponent: {}, videoComponent: {},
    Qt: { callLater() {} }, requestNaturalSize() {}, isVideoPath: () => false };
  s.root = s;
  vm.createContext(s);
  // Load any shared reload helper from the real component as well.
  if (renderer.includes('function reloadSource(')) vm.runInContext(block(renderer, 'function reloadSource('), s);
  vm.runInContext(body(renderer, 'onSourceGenerationChanged:'), s);
  assert.equal(s.ready, false);
  assert.deepEqual(assignments, [false, true], 'same pathname recreates the decoder');
});

test('theme: stale in-flight stage remains old-generation and obsolete leases prune only after use', () => {
  const theme = '/home/test/.local/state/omarchy/current/theme/backgrounds';
  const pin = `${theme}/same.png`;
  const queued = [];
  const s = scope(['pinnedStageKey', 'finishPinnedStage', 'pruneStagedPinnedPaths', 'samePathMap', 'rendererUsesSnapshot'], {
    themeContentVersion: 2, stagingPinFolder: theme, stagingPinPath: pin,
    stagingPinKey: JSON.stringify([theme, pin, 1]),
    safePath: value => value, isStagedSnapshotPath: value => value.startsWith('/cache/'),
    pinnedLogicalReferences: () => ({ [pin]: true }), rendererSourcePaths: { visible: '/cache/old.png' },
    currentLinkSnapshotPath: '', pendingCurrentLinkSnapshotPath: '', inFlightCurrentLinkSnapshotPath: '',
    uncertainCurrentLinkSnapshotPaths: [], pinnedLeaseReleaseTimer: timer(),
    Qt: { callLater(fn) { queued.push(fn); } }, shuffle() {},
  });
  s.finishPinnedStage(0, JSON.stringify({ path: '/cache/old.png', lease: 'a'.repeat(32) }));
  const currentKey = s.pinnedStageKey(theme, pin);
  assert.equal(s.stagedPinnedPaths[currentKey], undefined, 'old response cannot satisfy a new theme generation');
  s.stagedPinnedPaths[currentKey] = '/cache/new.png';
  s.stagedPinnedLeaseTokens[currentKey] = 'b'.repeat(32);
  s.pruneStagedPinnedPaths();
  assert.equal(Object.keys(s.stagedPinnedPaths).length, 2, 'visible old snapshot remains leased');
  s.rendererSourcePaths = {};
  s.pruneStagedPinnedPaths();
  assert.deepEqual(plain(s.stagedPinnedPaths), { [currentKey]: '/cache/new.png' });
  assert.deepEqual(plain(s.pendingPinnedLeaseReleases), [{ path: '/cache/old.png', lease: 'a'.repeat(32) }]);
  s.stagingPinFolder = theme;
  s.stagingPinPath = pin;
  s.stagingPinKey = currentKey;
  s.finishPinnedStage(1, '');
  assert.equal(s.stagedPinnedPaths[currentKey], '/cache/new.png', 'failed restaging must not delete a leased snapshot');
  assert.equal(s.failedPinnedPaths[currentKey], true);
});

test('preparation: composed hidden incoming slots decode then pause, including OWE suspension', () => {
  for (const [id, slot] of [['frameA', 0], ['frameB', 1]]) {
    for (const suspended of [false, true]) {
      for (const ready of [false, true]) {
        const root = { suspended, frontSlot: 1 - slot, revealProgress: 0, revealArmed: false };
        const panel = { incPath: '/fixture/incoming.mp4', slotAPath: '/fixture/incoming.mp4', slotBPath: '/fixture/incoming.mp4' };
        const context = { root, panel, frameA: { ready }, frameB: { ready } };
        const visible = vm.runInNewContext(binding(background, `${id}Layer`, 'visible'), context);
        context[`${id}Layer`] = { visible };
        const playing = vm.runInNewContext(binding(background, id, 'playing'), context);
        const preparing = vm.runInNewContext(binding(background, id, 'preparing', 'false'), context);
        assert.equal(preparing, !suspended && !ready, `${id}: hidden ready=${ready}, suspended=${suspended}`);
        let action;
        vm.runInNewContext(`${block(renderer, 'function updatePlayback(')}; updatePlayback()`, {
          root: { playing, preparing }, player: { play() { action = 'play'; }, pause() { action = 'pause'; } },
        });
        assert.equal(action, !suspended && !ready ? 'play' : 'pause');
        root.frontSlot = slot;
        assert.equal(vm.runInNewContext(binding(background, id, 'preparing', 'false'), context), false, 'front slot must not prepare');
      }
    }
  }
});
