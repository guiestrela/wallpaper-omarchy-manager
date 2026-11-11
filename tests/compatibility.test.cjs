const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const widget = fs.readFileSync(path.join(root, 'BarWidget.qml'), 'utf8');
const background = fs.readFileSync(path.join(root, 'Background.qml'), 'utf8');

// Parse balanced QML JS functions, ignoring braces inside comments/strings.
function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is defined`);
  const begin = source.indexOf('{', start);
  let depth = 0, quote = null, escaped = false, line = false, block = false;
  for (let i = begin; i < source.length; i++) {
    const ch = source[i], next = source[i + 1];
    if (line) { if (ch === '\n') line = false; continue; }
    if (block) { if (ch === '*' && next === '/') { block = false; i++; } continue; }
    if (quote) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === quote) quote = null; continue; }
    if (ch === '/' && next === '/') { line = true; i++; continue; }
    if (ch === '/' && next === '*') { block = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Unbalanced function ${name}`);
}
function persistence(callback) {
  const root = {
    moduleName: 'io.github.guiestrela.wallpaperomarchymanager',
    settings: { id: 'io.github.guiestrela.wallpaperomarchymanager', intervalSec: 0, custom: 'keep', displayConfig: { 'DP-1': { folder: '/fixtures/wallpapers' } } },
    settingsError: '', bar: callback ? { shell: { updateEntryInline: callback } } : null,
    _saveQueue: [],
  };
  // The old implementation uses QML's unqualified property/function scope.
  // Supply that scope so RED reflects the missing API behavior, not a JS ReferenceError.
  const persist = new Function('root', 'console', '_saveQueue', 'drainSaves', 'refreshTimer', `${extract(widget, 'persist')}; return persist;`)(root, { warn() {} }, root._saveQueue, () => {}, { restart() {} });
  return { root, persist };
}

test('settings use scoped inline API and preserve unrelated keys', () => {
  const calls = [];
  const { root, persist } = persistence((id, entry) => { calls.push({ id, entry }); return true; });
  assert.equal(persist('intervalSec', 600), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, root.moduleName);
  assert.equal(root.settings.intervalSec, 600);
  assert.equal(root.settings.custom, 'keep');
  assert.equal(root.settings.displayConfig['DP-1'].folder, '/fixtures/wallpapers');
});
test('consecutive edits retain the immediately preceding accepted edit', () => {
  const calls = [];
  const { root, persist } = persistence((id, entry) => { calls.push(entry); return true; });
  assert.equal(persist('intervalSec', 120), true);
  assert.equal(persist('shuffleOnWake', true), true);
  assert.equal(calls[1].intervalSec, 120);
  assert.equal(root.settings.shuffleOnWake, true);
});
test('rejected settings leave current values intact and expose an error', () => {
  const { root, persist } = persistence(() => false);
  const previous = root.settings;
  assert.equal(persist('intervalSec', 300), false);
  assert.equal(root.settings, previous);
  assert.ok(root.settingsError);
});
test('missing public API fails safely without spawning a shell writer', () => {
  const { root, persist } = persistence();
  assert.equal(persist('intervalSec', 300), false);
  assert.equal(root.settings.intervalSec, 0);
  assert.ok(root.settingsError);
});
test('throwing settings callback cannot modify local state', () => {
  const { root, persist } = persistence(() => { throw new Error('storage unavailable'); });
  const previous = root.settings;
  assert.equal(persist('intervalSec', 300), false);
  assert.equal(root.settings, previous);
  assert.ok(root.settingsError);
});
test('successful retry clears a previous write error', () => {
  let accept = false;
  const { root, persist } = persistence(() => accept);
  assert.equal(persist('intervalSec', 300), false);
  accept = true;
  assert.equal(persist('intervalSec', 300), true);
  assert.equal(root.settings.intervalSec, 300);
  assert.equal(root.settingsError, '');
});
test('both IPC surfaces register with modern shell socket registry', () => {
  assert.match(widget, /ShellIpc\s*\{/);
  assert.match(background, /ShellIpc\s*\{/);
  assert.doesNotMatch(widget, /\bIpcHandler\s*\{/);
  assert.doesNotMatch(background, /\bIpcHandler\s*\{/);
});
test('manifest declares the background service replacement', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.omarchy?.clonedFrom, 'omarchy.background');
});
test('theme intro handoff preserves folder selection instead of advancing it', () => {
  let shuffles = 0, repairs = 0, deferred = 0;
  const fn = new Function('hasServiceContext', 'hasFolder', 'shuffle', 'applyGlobal',
    'syncDisplayedCurrentLink', 'folderLinkRepairTimer', `${extract(background, 'setBackground')};return setBackground;`)(
      () => true, () => true, () => { shuffles++; }, () => { throw new Error('theme overwrote folder'); },
      () => { repairs++; }, { restart() { deferred++; } });
  fn('/theme/new.jpg', true);
  assert.equal(shuffles, 0);
  assert.equal(repairs, 1);
  assert.equal(deferred, 1);
});
test('theme transition renderers retain durable paths, not expiring snapshots', () => {
  let transition;
  const fn = new Function('hasServiceContext', 'screenNames', 'currentBackground', 'displayedMap',
    'beginTransition', 'displayedIsEmpty', `${extract(background, 'applyGlobal')};return applyGlobal;`)(
      () => true, () => ['DP-1', 'DP-2'], '/old.jpg', { 'DP-1': '/old.jpg', 'DP-2': '/old.jpg' },
      (...args) => { transition = args; }, () => false);
  fn('/tmp/old-snapshot.jpg', '/tmp/next-snapshot.jpg', '/theme/durable.jpg', false, true);
  assert.equal(transition[1]['DP-1'], '/theme/durable.jpg');
  assert.equal(transition[1]['DP-2'], '/theme/durable.jpg');
});
test('OWE can suspend/resume surfaces and media', () => {
  assert.ok(background.includes('function setSuspended(value: string)'), 'OWE IPC method missing');
  assert.ok(background.includes('visible: !remapGuard.remapping && !root.suspended'), 'surface ignores suspension');
  assert.ok(background.includes('playing: !root.suspended && frameALayer.visible'), 'media ignores suspension');
});
test('wake UI does not promise unavailable authentication-service access', () => {
  assert.ok(widget.includes('Shuffle on wake is unavailable'), 'unsupported option must be labelled');
  assert.ok(!background.includes('shell.serviceFor("omarchy.lock")'), 'do not query an isolated authentication service');
});
test('stock m4v videos use the video renderer', () => {
  const source = fs.readFileSync(path.join(root, 'WallpaperRenderer.qml'), 'utf8');
  const isVideo = new Function(`${extract(source, 'isVideoPath')};return isVideoPath;`)();
  assert.equal(isVideo('/fixtures/intro.m4v'), true);
  assert.equal(isVideo('/fixtures/intro.M4V'), true);
  assert.equal(isVideo('/fixtures/image.png'), false);
});
test('folder browsing uses the native Qt dialog, not missing zenity', () => {
  let closes = 0, opens = 0;
  const root = { current: { folder: '/fixtures/wallpapers' }, close() { closes++; }, folderEdited: true };
  const dialog = { currentFolder: '', open() { opens++; } };
  const fn = new Function('root', 'folderDialog', 'Util', 'Quickshell', 'browseProc', `${extract(widget, 'browse')};return browse;`)(
    root, dialog, { fileUrl: (p) => 'file://' + p }, { env: () => '/fixtures/home' }, { running: false });
  fn();
  assert.equal(closes, 1);
  assert.equal(opens, 1);
  assert.equal(dialog.currentFolder, 'file:///fixtures/wallpapers');
  assert.ok(!widget.includes('["zenity"'), 'do not require an absent executable');
});
test('native folder selection decodes local URLs and rejects remote URLs', () => {
  const saved = [];
  const root = { folderEdited: true, settingsError: '', persistDisplay(key, value) { saved.push([key, value]); return true; } };
  const fn = new Function('root', 'safePath', `${extract(widget, 'acceptFolderUrl')};return acceptFolderUrl;`)(
    root, (p) => p.startsWith('/') ? p : '');
  assert.equal(fn('file:///fixtures/my%20walls'), true);
  assert.deepEqual(saved, [['folder', '/fixtures/my walls']]);
  assert.equal(fn('https://example.test/walls'), false);
  assert.equal(fn('file://remote-host/walls'), false);
  assert.equal(saved.length, 1);
});
test('settings no longer invoke a legacy configuration subprocess', () => {
  assert.doesNotMatch(widget, /"setBarWidget"/);
});
