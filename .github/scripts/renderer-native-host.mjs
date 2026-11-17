// Renderer-only fixtures need Quickshell's registered Process/StdioCollector
// types. A standalone QQmlApplicationEngine cannot load those native plugins.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../..', import.meta.url));

export function assertFixtureResult(result) {
  if (result.error) throw result.error;
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  assert.equal(result.status, 0, `Quickshell host failed:\n${output.slice(-6000)}`);
  const markers = [...output.matchAll(/WPM_RENDERER_TEST_RESULT\s+(-?\d+)/g)];
  assert.equal(markers.length, 1, `Expected one completion marker:\n${output.slice(-6000)}`);
  assert.equal(Number(markers[0][1]), 0, `Renderer assertions failed:\n${output.slice(-6000)}`);
  assert.ok(!/(?:ReferenceError:|TypeError:|Binding loop|Cannot assign)/.test(output),
    `QML runtime error:\n${output.slice(-6000)}`);
  return output;
}

export function runRendererFixture(templateName, values) {
  const temp = mkdtempSync(join(tmpdir(), 'wpm-native-renderer-'));
  let alias;
  let aliasCreated = false;
  try {
    for (const name of ['home', 'config', 'cache', 'state', 'data', 'run', 'Commons']) {
      mkdirSync(join(temp, name), { mode: 0o700 });
    }
    mkdirSync(join(temp, 'plugin'), { mode: 0o700 });
    copyFileSync(join(repo, 'WallpaperRenderer.qml'), join(temp, 'plugin', 'WallpaperRenderer.qml'));
    // Only the path utility is stubbed; media decoding and Quickshell.Io are real.
    // Match native Commons' contract: input is a raw local path, not a file URL.
    writeFileSync(join(temp, 'Commons', 'qmldir'), 'module qs.Commons\nsingleton Util 1.0 Util.qml\n');
    writeFileSync(join(temp, 'Commons', 'Util.qml'), `pragma Singleton
import QtQuick
QtObject {
  function fileUrl(path) {
    return path ? "file://" + String(path).split("/").map(encodeURIComponent).join("/") : ""
  }
}
`);
    let qml = readFileSync(join(repo, '.github', 'tests', templateName), 'utf8');
    for (const [token, value] of Object.entries(values)) {
      assert.equal(qml.split(token).length - 1, 1, `Expected one fixture token ${token}`);
      qml = qml.replace(token, JSON.stringify(value));
    }
    // Keep the fixture's assertion body; adapt only its host and import scope.
    assert.ok(qml.includes('import "../.."') && qml.includes('Window {'), 'Unsupported fixture host');
    qml = 'import Quickshell\n' + qml.replace('import "../.."', 'import "plugin" as Plugin')
      .replace(/\bWallpaperRenderer\s*\{/g, 'Plugin.WallpaperRenderer {')
      .replace('Window {', 'Scope {\nWindow {') + '\n}\n';
    qml = qml.replace(/Qt\.quit\(\)/g,
      '{ console.log("WPM_RENDERER_TEST_RESULT", testRoot.testCompleted ? testRoot.testExitCode : 1); Qt.quit() }');
    const qmlPath = join(temp, 'shell.qml');
    writeFileSync(qmlPath, qml);
    const nativeRuntime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
    assert.ok(existsSync(nativeRuntime), 'A writable session runtime directory is required');
    alias = join(nativeRuntime, `wpm-${randomBytes(4).toString('hex')}`);
    symlinkSync(join(temp, 'run'), alias, 'dir');
    aliasCreated = true;
    const env = { ...process.env, HOME: join(temp, 'home'), XDG_CONFIG_HOME: join(temp, 'config'),
      XDG_CACHE_HOME: join(temp, 'cache'), XDG_STATE_HOME: join(temp, 'state'),
      XDG_DATA_HOME: join(temp, 'data'), XDG_RUNTIME_DIR: alias,
      QT_QPA_PLATFORM: 'offscreen', QT_QPA_PLATFORMTHEME: '', QT_QUICK_BACKEND: 'software',
      QT_FORCE_STDERR_LOGGING: '1', QML_DISABLE_DISK_CACHE: '1' };
    for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'HYPRLAND_INSTANCE_SIGNATURE',
      'QML_IMPORT_PATH', 'QML2_IMPORT_PATH']) delete env[key];
    const result = spawnSync('quickshell', ['-n', '-p', qmlPath], { env, encoding: 'utf8', timeout: 40000 });
    return assertFixtureResult(result);
  } finally {
    if (aliasCreated) rmSync(alias, { force: true });
    rmSync(temp, { recursive: true, force: true });
  }
}
