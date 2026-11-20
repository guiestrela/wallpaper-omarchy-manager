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
test('theme-folder action updates only the selected output and clears its old pin', () => {
  const original = { 'DP-1': { folder: '/old', pinned: '/old/a.png', mode: 'single', scaling: 'fitHeight' },
    'DP-2': { folder: '/other', pinned: '/other/b.png', mode: 'single' } };
  let saved, rescans = 0;
  const root = { editingKey: 'DP-1', activeThemeFolder: '/home/test/.local/state/omarchy/current/theme/backgrounds',
    folderEdited: true, copyDisplayConfig: () => structuredClone(original), configFor: () => ({}),
    persist(key, value) { saved = value; return true; }, rescanNow() { rescans++; } };
  const use = new Function('root', `${extract(widget, 'useActiveThemeFolder')};return useActiveThemeFolder;`)(root);
  assert.equal(use(), true);
  assert.equal(saved['DP-1'].folder, root.activeThemeFolder);
  assert.equal(saved['DP-1'].pinned, '');
  assert.equal(saved['DP-1'].mode, 'single');
  assert.equal(saved['DP-1'].scaling, 'fitHeight');
  assert.deepEqual(saved['DP-2'], original['DP-2']);
  assert.equal(original['DP-1'].folder, '/old');
  assert.equal(root.folderEdited, false);
  assert.equal(rescans, 1);
});
test('theme-folder action supports shared settings and does not rescan rejected saves', () => {
  const root = { editingKey: 'all', activeThemeFolder: '/home/test/.local/state/omarchy/current/theme/backgrounds',
    folderEdited: true, copyDisplayConfig: () => ({}), configFor: () => ({ recursive: true, mode: 'shuffle' }),
    persist(key, value) { assert.equal(value.all.folder, root.activeThemeFolder); return false; },
    rescanNow() { throw new Error('rejected save must not rescan'); } };
  const use = new Function('root', `${extract(widget, 'useActiveThemeFolder')};return useActiveThemeFolder;`)(root);
  assert.equal(use(), false);
  assert.equal(root.folderEdited, true);
});
test('theme-directory changes invalidate a cached pool only when theme folders are selected', () => {
  let restarts = 0;
  const root = { serviceActive: true, home: '/home/test', screenNames: () => ['DP-1', 'DP-2'],
    configFor: (n) => ({ folder: n === 'DP-1' ? '/home/test/.local/state/omarchy/current/theme/backgrounds' : '/custom' }) };
  const fn = new Function('root', 'configReload', `${extract(background, 'refreshThemeFolder')};return refreshThemeFolder;`)(root, { restart() { restarts++; } });
  fn(); assert.equal(restarts, 1);
  root.configFor = () => ({ folder: '/custom' });
  fn(); assert.equal(restarts, 1);
  root.serviceActive = false;
  fn(); assert.equal(restarts, 1);
});
test('active-theme file watcher refreshes the pool and preview accepts middle click', () => {
  assert.ok(background.includes('id: themeIdentityFile'));
  assert.ok(background.includes('root.refreshThemeFolder()'));
  assert.ok(widget.includes('objectName: "preview-middle-click"'));
  assert.ok(widget.includes('acceptedButtons: Qt.MiddleButton'));
  assert.ok(widget.includes('id: previewHideDelay'), 'preview needs time to receive the pointer');
  assert.ok(widget.includes('previewMouse.containsMouse'), 'preview must remain open under the pointer');
});
test('saving unchanged settings is not reported as an API rejection', () => {
  let calls = 0;
  const { root, persist } = persistence(() => { calls++; return false; });
  root.settingsError = 'old error';
  assert.equal(persist('intervalSec', 0), true);
  assert.equal(root.settingsError, '');
  assert.equal(calls, 0);
});
test('settings no longer invoke a legacy configuration subprocess', () => {
  assert.doesNotMatch(widget, /"setBarWidget"/);
});
test('different-image-per-display toggle is in Displays and keeps its saved key', () => {
  const label = 'label: "Different image per display"';
  const labelIndex = widget.indexOf(label);
  const displaysStart = widget.indexOf('// ═══════════════════════════════════════════════════════ displays');
  const shufflingStart = widget.indexOf('// ══════════════════════════════════════════════════════ shuffling');
  assert.notEqual(labelIndex, -1);
  assert.equal(widget.indexOf(label, labelIndex + label.length), -1, 'there must be only one copy of the control');
  assert.ok(labelIndex > displaysStart && labelIndex < shufflingStart, 'the control belongs to the Displays tab');

  const toggleStart = widget.lastIndexOf('Toggle {', labelIndex);
  const toggleEnd = widget.indexOf('\n          }', labelIndex);
  const toggle = widget.slice(toggleStart, toggleEnd);
  assert.match(toggle, /visible: !root\.perDisplayConfig/);
  assert.match(toggle, /onClicked: root\.persist\("perDisplay", !root\.perDisplay\)/);
});

test('picker records the latest request while an earlier scan is active', () => {
  const root = {
    editingKey: 'DP-2',
    current: { folder: '/fixtures/B', recursive: false },
    pickerRequestGeneration: 4,
    queuedPickerRequest: null,
    activePickerRequest: { generation: 3, display: 'DP-1', folder: '/fixtures/A', recursive: true },
    pickerResultContext: { generation: 3, display: 'DP-1', folder: '/fixtures/A', recursive: true },
    pickerImages: ['/fixtures/A/old.png'],
    pickerProc: { running: true, command: ['scan-A'] },
    safePath: (value) => String(value || '')
  };
  const load = new Function('root', 'current', 'safePath', 'pickerProc', 'pickerImages',
    `${extract(widget, 'loadPicker')};return loadPicker;`)(
      root, root.current, root.safePath, root.pickerProc, root.pickerImages);

  load();
  assert.deepEqual(root.queuedPickerRequest,
    { generation: 5, display: 'DP-2', folder: '/fixtures/B', recursive: false });
  assert.equal(root.pickerRequestGeneration, 5);
  assert.deepEqual(root.pickerImages, []);
  assert.equal(root.pickerResultContext, null);
  assert.deepEqual(root.pickerProc.command, ['scan-A'], 'an active process must not be retargeted');
});
test('picker starts the latest scan after stale output and rejects stale image clicks', () => {
  const root = {
    editingKey: 'DP-1',
    current: { folder: '/fixtures/A', recursive: true },
    pickerRequestGeneration: 0,
    activePickerRequest: null,
    queuedPickerRequest: null,
    pickerResultContext: null,
    pickerImages: [],
    pickerOutput: '',
    pickerProc: { running: false, command: [] },
    safePath: (value) => String(value || ''),
    saved: [],
    persistDisplay(key, value) { this.saved.push([key, value]); return true; }
  };
  const names = ['loadPicker', 'startPickerRequest', 'pickerRequestIsCurrent',
    'finishPickerRequest', 'selectPickerImage'];
  const api = new Function('root', 'pickerProc',
    `${names.map(name => extract(widget, name)).join(';')};return {${names.join(',')}};`)(root, root.pickerProc);
  Object.assign(root, api);

  root.loadPicker();
  const first = root.activePickerRequest;
  assert.equal(first.folder, '/fixtures/A');
  assert.equal(root.pickerProc.command[4], '/fixtures/A');
  assert.equal(root.pickerProc.command[5], '-maxdepth 32');

  root.current = { folder: '/fixtures/B', recursive: false };
  root.editingKey = 'DP-2';
  root.loadPicker();
  const latest = root.queuedPickerRequest;
  assert.deepEqual(latest, { generation: 2, display: 'DP-2', folder: '/fixtures/B', recursive: false });

  root.pickerProc.running = false;
  root.finishPickerRequest(first, '/fixtures/A/old.png');
  assert.equal(root.pickerProc.running, true);
  assert.equal(root.activePickerRequest.generation, latest.generation);
  assert.equal(root.pickerProc.command[4], '/fixtures/B');
  assert.equal(root.pickerProc.command[5], '-maxdepth 1');
  assert.deepEqual(root.pickerImages, []);
  assert.equal(root.pickerResultContext, null);

  root.pickerProc.running = false;
  root.finishPickerRequest(latest, ['/fixtures/B/one.png', '/fixtures/B/two.png'].join(String.fromCharCode(10)));
  assert.deepEqual(root.pickerImages, ['/fixtures/B/one.png', '/fixtures/B/two.png']);
  assert.equal(root.pickerResultContext, latest);
  assert.equal(root.selectPickerImage('/fixtures/A/old.png', first), false);
  assert.equal(root.selectPickerImage('/fixtures/B/one.png', latest), true);
  assert.deepEqual(root.saved, [['pinned', '/fixtures/B/one.png']]);
});

test('picker scan command searches only the requested temporary folder and recursion depth', () => {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'wpm-picker-'));
  try {
    const folderA = path.join(temporary, 'A');
    const folderB = path.join(temporary, 'B');
    fs.mkdirSync(path.join(folderA, 'nested'), { recursive: true });
    fs.mkdirSync(path.join(folderB, 'nested'), { recursive: true });
    for (const file of ['top.png', 'nested/deep.jpg']) fs.writeFileSync(path.join(folderA, file), 'fixture');
    for (const file of ['root.png', 'nested/deep.jpg']) fs.writeFileSync(path.join(folderB, file), 'fixture');
    const root = {
      editingKey: 'DP-1', current: { folder: folderA, recursive: true },
      pickerRequestGeneration: 0, activePickerRequest: null, queuedPickerRequest: null,
      pickerResultContext: null, pickerImages: [], pickerOutput: '',
      pickerProc: { running: false, command: [] }, safePath: value => String(value || ''),
      persistDisplay() { return true; }
    };
    const names = ['loadPicker', 'startPickerRequest', 'pickerRequestIsCurrent', 'finishPickerRequest'];
    const api = new Function('root', 'pickerProc',
      `${names.map(name => extract(widget, name)).join(';')};return {${names.join(',')}};`)(root, root.pickerProc);
    Object.assign(root, api);

    root.loadPicker();
    const scanA = spawnSync(root.pickerProc.command[0], root.pickerProc.command.slice(1), { encoding: 'utf8', timeout: 5000 });
    assert.equal(scanA.status, 0, scanA.stderr);
    root.pickerProc.running = false;
    root.finishPickerRequest(root.activePickerRequest, scanA.stdout);
    assert.deepEqual(root.pickerImages, [path.join(folderA, 'nested/deep.jpg'), path.join(folderA, 'top.png')]);

    root.current = { folder: folderB, recursive: false };
    root.editingKey = 'DP-2';
    root.loadPicker();
    const scanB = spawnSync(root.pickerProc.command[0], root.pickerProc.command.slice(1), { encoding: 'utf8', timeout: 5000 });
    assert.equal(scanB.status, 0, scanB.stderr);
    root.pickerProc.running = false;
    root.finishPickerRequest(root.activePickerRequest, scanB.stdout);
    assert.deepEqual(root.pickerImages, [path.join(folderB, 'root.png')]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('empty picker folder invalidates an in-flight result without starting another scan', () => {
  const root = {
    editingKey: 'DP-1', current: { folder: '', recursive: true },
    pickerRequestGeneration: 2,
    activePickerRequest: { generation: 2, display: 'DP-1', folder: '/fixtures/A', recursive: true },
    queuedPickerRequest: { generation: 2, display: 'DP-1', folder: '/fixtures/A', recursive: true },
    pickerResultContext: { generation: 2, display: 'DP-1', folder: '/fixtures/A', recursive: true },
    pickerImages: ['/fixtures/A/old.png'], pickerOutput: '',
    pickerProc: { running: true, command: ['scan-A'] }, safePath: value => String(value || ''),
  };
  const load = new Function('root', 'pickerProc', `${extract(widget, 'loadPicker')};return loadPicker;`)(root, root.pickerProc);
  load();
  assert.equal(root.pickerRequestGeneration, 3);
  assert.equal(root.queuedPickerRequest, null);
  assert.equal(root.pickerResultContext, null);
  assert.deepEqual(root.pickerImages, []);
  root.pickerProc.running = false;
  const names = ['pickerRequestIsCurrent', 'startPickerRequest', 'finishPickerRequest'];
  const callbacks = new Function('root', 'pickerProc',
    `${names.map(name => extract(widget, name)).join(';')};return {${names.join(',')}};`)(root, root.pickerProc);
  Object.assign(root, callbacks);
  root.finishPickerRequest(root.activePickerRequest, '/fixtures/A/late.png');
  assert.deepEqual(root.pickerImages, []);
  assert.equal(root.pickerResultContext, null);
});

test('shared-mode toggle stops after the display-config write is rejected', () => {
  const calls = [];
  const { root, persist } = persistence((id, entry) => {
    calls.push({ id, entry });
    return calls.length !== 1;
  });
  root.settings.perDisplayConfig = true;
  const previous = root.settings;
  const toggle = new Function('root', 'editingKey', 'copyDisplayConfig', 'configFor', 'persist',
    `${extract(widget, 'setPerDisplayConfig')};return setPerDisplayConfig;`)(
      root,
      'DP-1',
      () => structuredClone(root.settings.displayConfig),
      (key) => structuredClone(root.settings.displayConfig[key] || { folder: '/fixtures/wallpapers' }),
      persist);

  toggle(false);
  assert.equal(calls.length, 1, 'must not persist the mode after the required config write fails');
  assert.equal(calls[0].entry.displayConfig.all.folder, '/fixtures/wallpapers');
  assert.equal(calls[0].entry.perDisplayConfig, false);
  assert.equal(calls[0].entry.custom, 'keep');
  assert.equal(root.settings, previous);
  assert.ok(root.settingsError);
});
