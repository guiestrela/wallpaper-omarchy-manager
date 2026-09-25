// Exercise the production WallpaperRenderer Loader with synthetic media under Qt.
// The installed plugin is not loaded; the only stub is qs.Commons.Util.fileUrl.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const testDir = join(repo, '.github', 'tests');
mkdirSync(testDir, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), 'wpm-qt-lifecycle-'));
const qmlPath = join(testDir, `wpm-renderer-runtime-${process.pid}.qml`);
let passed = false;
try {
  const commons = join(temp, 'imports', 'qs', 'Commons');
  mkdirSync(commons, { recursive: true });
  writeFileSync(join(commons, 'qmldir'), 'module qs.Commons\nsingleton Util 1.0 Util.qml\n');
  writeFileSync(join(commons, 'Util.qml'), `pragma Singleton\nimport QtQuick\nQtObject { function fileUrl(path) { return String(path).startsWith("file:") ? path : "file://" + path } }\n`);

  const gifPath = join(temp, 'fixture.gif');
  writeFileSync(gifPath, Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64'));
  const templatePath = join(testDir, 'renderer-runtime-lifecycle.qml.in');
  const template = readFileSync(templatePath, 'utf8');
  const token = '__WPM_FIXTURE_URL__';
  assert.equal(template.split(token).length - 1, 1, 'QML fixture URL placeholder exists exactly once');
  writeFileSync(qmlPath, template.replace(token, JSON.stringify(pathToFileURL(gifPath).href)));

  const qtFlags = spawnSync('pkg-config', ['--cflags', '--libs', 'Qt6Qml', 'Qt6Quick', 'Qt6Gui', 'Qt6Multimedia'], { encoding: 'utf8' });
  if (qtFlags.error) throw qtFlags.error;
  assert.equal(qtFlags.status, 0, `Qt6 development packages unavailable: ${qtFlags.stderr}`);
  const runnerPath = join(temp, 'renderer-runtime-runner');
  const runnerSource = join(repo, '.github', 'scripts', 'renderer-runtime-runner.cpp');
  const flags = qtFlags.stdout.trim().split(/\s+/);
  const build = spawnSync('c++', [runnerSource, '-std=c++17', '-o', runnerPath, ...flags], { encoding: 'utf8', timeout: 30000 });
  if (build.error) throw build.error;
  assert.equal(build.status, 0, `QML test runner build failed:\n${build.stdout}\n${build.stderr}`);

  const result = spawnSync(runnerPath, [qmlPath], {
    encoding: 'utf8', timeout: 40000,
    env: { ...process.env, QT_QPA_PLATFORM: 'offscreen', QT_QUICK_BACKEND: 'software', QML2_IMPORT_PATH: join(temp, 'imports'), QML_DISABLE_DISK_CACHE: '1', XDG_CACHE_HOME: temp },
  });
  if (result.error) throw result.error;
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  process.stdout.write(output);
  assert.equal(result.status, 0, `Qt QML lifecycle assertions failed (exit ${result.status}):\n${output}`);
  passed = true;
  console.log('Qt QML lifecycle assertions passed (real Loader; 5 cycles; max 3 of 8 loaded).');
} finally {
  if (passed) {
    rmSync(qmlPath, { force: true });
    rmSync(temp, { recursive: true, force: true });
  } else {
    console.error(`Runtime-test fixtures retained for diagnosis: ${qmlPath} and ${temp}`);
  }
}
