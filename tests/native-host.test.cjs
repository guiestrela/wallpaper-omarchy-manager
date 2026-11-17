const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const helper = path.resolve(__dirname, '../.github/scripts/renderer-native-host.mjs');

test('native renderer host validates assertion results, not only process exit', async () => {
  assert.ok(fs.existsSync(helper), 'a Quickshell-native renderer host is required');
  const { assertFixtureResult } = await import(pathToFileURL(helper).href);
  const result = (stdout, status = 0) => ({ stdout, stderr: '', status });
  assert.doesNotThrow(() => assertFixtureResult(result('qml: WPM_RENDERER_TEST_RESULT 0\n')));
  assert.throws(() => assertFixtureResult(result('qml: WPM_RENDERER_TEST_RESULT 1\n')), /assertions failed/);
  assert.throws(() => assertFixtureResult(result('no assertion ran\n')), /completion marker/);
  assert.throws(() => assertFixtureResult(result('WPM_RENDERER_TEST_RESULT 0\n', 1)), /host failed/);
  assert.throws(() => assertFixtureResult(result('WPM_RENDERER_TEST_RESULT 1\nWPM_RENDERER_TEST_RESULT 0\n')), /completion marker/);
});

test('native renderer host rejects QML runtime errors even after completion', async () => {
  const { assertFixtureResult } = await import(pathToFileURL(helper).href);
  for (const error of ['ReferenceError: missing scope', 'TypeError: null item', 'Binding loop detected']) {
    assert.throws(() => assertFixtureResult({ status: 0,
      stdout: `${error}\nWPM_RENDERER_TEST_RESULT 0\n`, stderr: '' }), /runtime error/);
  }
});
