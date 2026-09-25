import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../BarWidget.qml', import.meta.url), 'utf8');
const match = source.match(/^  function isPrimaryIpcScreen\([^\n]*\) \{[\s\S]*?^  \}/m);
assert.ok(match, 'BarWidget.qml defines its single IPC-owner predicate');
const context = vm.createContext({});
vm.runInContext(`${match[0]}; this.isPrimaryIpcScreen = isPrimaryIpcScreen`, context);
assert.equal(context.isPrimaryIpcScreen('DP-1', [{ name: 'DP-1' }, { name: 'DP-2' }]), true);
assert.equal(context.isPrimaryIpcScreen('DP-2', [{ name: 'DP-1' }, { name: 'DP-2' }]), false);
assert.equal(context.isPrimaryIpcScreen('', [{ name: 'DP-1' }]), false);
assert.match(source, /IpcHandler\s*\{\s*enabled:\s*root\.ownsIpcTarget\(\)\s*target:\s*root\.ipcTarget/,
  'only the selected screen registers the legacy IPC target');
assert.match(source, /function ownsIpcTarget\(\)[\s\S]*?root\.QsWindow[\s\S]*?window\.screen/,
  'ownership uses the widget window rather than the shared bar API');
assert.match(source, /function ownsIpcTarget\(\)[\s\S]*?isPrimaryIpcScreen\(/,
  'ownership predicate uses the live widget screen');
console.log('Bar widget IPC ownership checks passed (one owner; other screens excluded).');
