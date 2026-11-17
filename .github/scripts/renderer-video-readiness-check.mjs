// Decode synthetic incoming videos before reveal using real Quickshell types.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runRendererFixture } from './renderer-native-host.mjs';

const temp = mkdtempSync(join(tmpdir(), 'wpm-video-ready-'));
try {
  const ffmpegCheck = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 10000 });
  if (ffmpegCheck.error?.code === 'ENOENT') {
    console.log('SKIP: ffmpeg unavailable; native video readiness not exercised.');
  } else {
    if (ffmpegCheck.error) throw ffmpegCheck.error;
    assert.equal(ffmpegCheck.status, 0, `ffmpeg probe failed: ${ffmpegCheck.stderr}`);
    const imagePath = join(temp, 'front.png');
    const videoPathA = join(temp, 'incoming-a.mp4');
    const videoPathB = join(temp, 'incoming-b.mp4');
    const create = (args, path) => {
      const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args, '-y', path],
        { encoding: 'utf8', timeout: 20000 });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, `Synthetic media generation failed: ${result.stderr}`);
      assert.ok(statSync(path).size > 0, 'Synthetic media must be non-empty');
    };
    create(['-f', 'lavfi', '-i', 'color=c=blue:size=32x32', '-frames:v', '1'], imagePath);
    for (const [path, color] of [[videoPathA, 'red'], [videoPathB, 'green']]) {
      create(['-f', 'lavfi', '-i', `color=c=${color}:size=32x32:rate=8`, '-frames:v', '8', '-an',
        '-c:v', 'mpeg4', '-q:v', '5', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'], path);
    }
    runRendererFixture('renderer-video-readiness.qml.in', {
      __WPM_IMAGE_URL__: imagePath, __WPM_VIDEO_A_URL__: videoPathA, __WPM_VIDEO_B_URL__: videoPathB,
    });
    console.log('Quickshell image→video and video→video transitions passed with hidden incoming frames prepared before reveal.');
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
