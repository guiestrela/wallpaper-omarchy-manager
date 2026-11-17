// Assert actual captured pixels change when a stable source path gets new bytes.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runRendererFixture } from './renderer-native-host.mjs';

const temp = mkdtempSync(join(tmpdir(), 'wpm-generation-media-'));
try {
  const target = join(temp, 'stable.png');
  const replacement = join(temp, 'replacement.png');
  writeFileSync(target, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NMQEAAAjDMMC/ZzDBvlRA01vZJvwHAAAAAAAAAAAAbx2jxAE/i2AjOgAAAABJRU5ErkJggg==', 'base64'));
  writeFileSync(replacement, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKUlEQVR4nO3NMQEAAAjDsIF/z2ACvlRAU8nks369AwAAAAAAAAAAgMMWocYBP7wfsd0AAAAASUVORK5CYII=', 'base64'));
  runRendererFixture('renderer-content-generation.qml.in', {
    __WPM_TARGET_PATH__: target, __WPM_REPLACEMENT_PATH__: replacement, __WPM_CAPTURE_DIR__: temp,
  });
  const mean = name => {
    const result = spawnSync('magick', [join(temp, name), '-format', '%[fx:mean.r] %[fx:mean.g] %[fx:mean.b]', 'info:'],
      { encoding: 'utf8', timeout: 10000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split(/\s+/).map(Number);
  };
  const before = mean('before.png');
  const after = mean('after.png');

  assert.ok(before[0] > 0.9 && before[1] < 0.1 && before[2] < 0.1, 'Initial capture must be red');
  assert.ok(after[0] < 0.1 && after[1] < 0.1 && after[2] > 0.9,
    `Generation refresh must render blue at the same path; before=${JSON.stringify(before)}, after=${JSON.stringify(after)}`);
  console.log('Quickshell content-generation pixels passed (same path: red → blue).');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
