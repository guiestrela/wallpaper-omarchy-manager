// Exercise thumbnail renderer activation predicates across open/close cycles.
// This contract harness does not launch QtMultimedia or touch real wallpaper files.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const renderer = readFileSync(new URL('../../WallpaperRenderer.qml', import.meta.url), 'utf8');
const widget = readFileSync(new URL('../../BarWidget.qml', import.meta.url), 'utf8');

assert.match(renderer, /property bool loadMedia: true/,
  'renderer preserves eager loading by default for the actual background');
const active = renderer.match(/^\s*active:\s*(.+)$/m)?.[1]?.trim();
assert.equal(active, 'root.loadMedia && root.sourcePath !== ""',
  'Loader activation is gated by loadMedia and a non-empty source');

const previewBlock = widget.match(/WallpaperRenderer \{[^}]*sourcePath: entry\.modelData\.path[^}]*\}/)?.[0];
assert.ok(previewBlock, 'hover preview renderer exists');
const previewExpr = previewBlock.match(/^\s*loadMedia:\s*(.+)$/m)?.[1]?.trim();
assert.equal(previewExpr, 'preview.visible', 'hover preview loads only while its popup is visible');
assert.match(previewBlock, /^\s*playing:\s*false$/m, 'hover thumbnails never play');

const pickerBlock = widget.match(/WallpaperRenderer \{[^}]*sourcePath: modelData[^}]*\}/)?.[0];
assert.ok(pickerBlock, 'picker renderer exists');
const pickerExpr = pickerBlock.match(/^\s*loadMedia:\s*(.+)$/m)?.[1]?.trim();
assert.equal(pickerExpr,
  'root.opened && root.tab === "displays" && root.current.mode === "single"',
  'picker loads only while its owning panel/tab/mode is visible');
assert.match(pickerBlock, /^\s*playing:\s*false$/m, 'picker thumbnails never play');

function evaluate(expression, globals) {
  return vm.runInNewContext(expression, globals);
}
const previewCount = 3;
const pickerVisibleDelegateCount = 6;
const activeCount = (expression, globals, sourcePath, count) => {
  const loadMedia = evaluate(expression, globals);
  const state = { root: { loadMedia, sourcePath } };
  return Array.from({ length: count }, () => evaluate(active, state)).filter(Boolean).length;
};

const previewState = { preview: { visible: false } };
const pickerState = { root: { opened: false, tab: 'displays', current: { mode: 'single' } } };
for (let cycle = 0; cycle < 5; cycle++) {
  assert.equal(activeCount(previewExpr, previewState, '/fixture/preview.mp4', previewCount), 0, 'closed hover popup has zero decoders');
  previewState.preview.visible = true;
  assert.equal(activeCount(previewExpr, previewState, '/fixture/preview.mp4', previewCount), previewCount, 'visible preview loads only its bounded fixture rows');
  assert.equal(activeCount(previewExpr, previewState, '', previewCount), 0, 'empty sources never instantiate decoders');
  previewState.preview.visible = false;
  assert.equal(activeCount(previewExpr, previewState, '/fixture/preview.mp4', previewCount), 0, 'closing hover popup unloads its rows');

  assert.equal(activeCount(pickerExpr, pickerState, '/fixture/picker.gif', pickerVisibleDelegateCount), 0, 'closed panel has zero picker decoders');
  pickerState.root.opened = true;
  assert.equal(activeCount(pickerExpr, pickerState, '/fixture/picker.gif', pickerVisibleDelegateCount), pickerVisibleDelegateCount, 'open single-image picker loads only visible fixture delegates');
  pickerState.root.tab = 'shuffling';
  assert.equal(activeCount(pickerExpr, pickerState, '/fixture/picker.gif', pickerVisibleDelegateCount), 0, 'changing tabs unloads picker decoders');
  pickerState.root.tab = 'displays';
  pickerState.root.current.mode = 'shuffle';
  assert.equal(activeCount(pickerExpr, pickerState, '/fixture/picker.gif', pickerVisibleDelegateCount), 0, 'changing mode unloads picker decoders');
  pickerState.root.current.mode = 'single';
  pickerState.root.opened = false;
  assert.equal(activeCount(pickerExpr, pickerState, '/fixture/picker.gif', pickerVisibleDelegateCount), 0, 'closing panel unloads picker decoders');
}

console.log('Thumbnail renderer lifecycle checks passed (5 open/close/tab/mode cycles; zero hidden decoders).');
