// Prove that a hidden incoming video yields its first decoded frame while
// visible playback remains paused; the fixture is generated locally by ffmpeg.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const testDir = join(repo, '.github', 'tests');
const temp = mkdtempSync(join(tmpdir(), 'wpm-video-ready-'));
const qmlPath = join(testDir, `wpm-video-ready-${process.pid}.qml`);
const imagePath = join(temp, 'front.png');
const videoPathA = join(temp, 'incoming-a.mp4');
const videoPathB = join(temp, 'incoming-b.mp4');
const templatePath = join(testDir, 'renderer-video-readiness.qml.in');

try {
  const rendererSource = readFileSync(join(repo, 'WallpaperRenderer.qml'), 'utf8');
  assert.match(rendererSource, /property\s+bool\s+preparing\b/, 'WallpaperRenderer must expose preparation independently of visible playback');

  const ffmpegCheck = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 10000 });
  if (ffmpegCheck.error?.code === 'ENOENT') {
    console.log('SKIP: ffmpeg unavailable; Qt video readiness not exercised.');
  } else {
    if (ffmpegCheck.error) throw ffmpegCheck.error;
    assert.equal(ffmpegCheck.status, 0, `ffmpeg probe failed: ${ffmpegCheck.stderr}`);

    function makeVideo(path, color) {
      const fixture = spawnSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
        `color=c=${color}:size=32x32:rate=8`, '-frames:v', '8', '-an',
        '-c:v', 'mpeg4', '-q:v', '5', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        '-y', path,
      ], { encoding: 'utf8', timeout: 20000 });
      if (fixture.error) throw fixture.error;
      assert.equal(fixture.status, 0, `synthetic video generation failed: ${fixture.stderr}`);
      assert.ok(statSync(path).size > 0, `synthetic MP4 fixture is non-empty: ${path}`);
    }

    const image = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'color=c=blue:size=32x32', '-frames:v', '1', '-y', imagePath,
    ], { encoding: 'utf8', timeout: 20000 });
    if (image.error) throw image.error;
    assert.equal(image.status, 0, `synthetic image generation failed: ${image.stderr}`);
    assert.ok(statSync(imagePath).size > 0, 'synthetic PNG fixture is non-empty');
    makeVideo(videoPathA, 'red');
    makeVideo(videoPathB, 'green');

    const template = readFileSync(templatePath, 'utf8');
    const replacements = [
      ['__WPM_IMAGE_URL__', imagePath],
      ['__WPM_VIDEO_A_URL__', videoPathA],
      ['__WPM_VIDEO_B_URL__', videoPathB],
    ];
    let qml = template;
    for (const [token, path] of replacements) {
      assert.equal(qml.split(token).length - 1, 1, `QML fixture URL placeholder ${token} exists exactly once`);
      qml = qml.replace(token, JSON.stringify(pathToFileURL(path).href));
    }
    writeFileSync(qmlPath, qml);

    const imports = join(temp, 'imports', 'qs', 'Commons');
    mkdirSync(imports, { recursive: true });
    writeFileSync(join(imports, 'qmldir'), 'module qs.Commons\nsingleton Util 1.0 Util.qml\n');
    writeFileSync(join(imports, 'Util.qml'), `pragma Singleton\nimport QtQuick\nQtObject { function fileUrl(path) { return String(path).startsWith("file:") ? path : "file://" + path } }\n`);

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
    assert.equal(result.status, 0, `Qt QML video readiness assertions failed (exit ${result.status}):\n${output}`);
    console.log('Qt QML image→video and video→video transitions passed with hidden incoming frames prepared before reveal.');
  }
} finally {
  rmSync(qmlPath, { force: true });
  rmSync(temp, { recursive: true, force: true });
}
