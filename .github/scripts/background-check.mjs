// Run the actual QML JavaScript with stubbed shell/process objects. No desktop,
// installed plugin, or user settings are touched by these regression tests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../Background.qml', import.meta.url), 'utf8');
const functions = [
  'hasServiceContext', 'rescan', 'drainScans', 'shuffle', 'syncCurrentLink',
  'applyGlobal', 'refreshBackground', 'transitionBackgroundWithTheme',
  'openSelector', 'openThemeSwitcher',
];
const code = functions.map(name => {
  const match = source.match(new RegExp(`^  function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}`, 'm'));
  assert.ok(match, `QML function ${name} exists`);
  return match[0];
}).join('\n');

function service(shell, manifest = { id: 'wallpaper' }) {
  const context = vm.createContext({ shell, manifest });
  vm.runInContext(code, context);
  return context;
}

// Includes the Glass Bar facade: it offers serviceFor(), but not barConfig.
for (const shell of [null, {}, { serviceFor() {} }, { barConfig: null }]) {
  const instance = service(shell);
  assert.equal(instance.hasServiceContext(), false);
  // No process/state dependencies are provided, so any side effect would
  // throw. In particular, refresh must not read the primary screen's link.
  for (const name of functions.slice(1)) instance[name]();
}
assert.equal(service({ barConfig: {} }, null).hasServiceContext(), false);

// A real service starts only once both injected properties arrive, in either
// order. Empty config must still support the normal theme wallpaper mode.
for (const order of [['shell', 'manifest'], ['manifest', 'shell']]) {
  const instance = service(null, null);
  const properties = { shell: { barConfig: {} }, manifest: { id: 'wallpaper' } };
  instance[order[0]] = properties[order[0]];
  assert.equal(instance.hasServiceContext(), false);
  instance[order[1]] = properties[order[1]];
  assert.equal(instance.hasServiceContext(), true);
  instance.hasFolder = () => false;
  instance.readlinkProc = { running: false };
  instance.refreshBackground();
  assert.equal(instance.readlinkProc.running, true);
}

const configured = service({ barConfig: { layout: { center: [{ id: 'wallpaper' }] } } });
let shuffled = false;
configured.hasFolder = () => true;
configured.shuffle = () => { shuffled = true; };
configured.readlinkProc = { running: false };
configured.refreshBackground();
assert.equal(shuffled, true);
assert.equal(configured.readlinkProc.running, false);

// The lifecycle guard also controls declarative side effects, not only JS.
assert.match(source, /IpcHandler\s*\{\s*enabled: root\.serviceActive\s*target: "background"/);
assert.match(source, /Variants\s*\{\s*model: root\.serviceActive \? Quickshell\.screens : \[\]/);
assert.match(source, /running: root\.serviceActive && !root\.folderMode/);
assert.match(source, /running: root\.serviceActive && root\.folderMode && root\.intervalSec > 0/);
assert.match(source, /onServiceActiveChanged:\s*\{\s*if \(serviceActive\) configReload\.restart\(\)/);
console.log('Background lifecycle checks passed (uninitialized, compatibility copy, host injection, theme and folder modes).');
