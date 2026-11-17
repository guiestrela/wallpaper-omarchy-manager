// Exercise the production WallpaperRenderer Loader with synthetic media.
// No installed plugin, user settings, desktop surface or media is touched.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRendererFixture } from './renderer-native-host.mjs';

const temp = mkdtempSync(join(tmpdir(), 'wpm-lifecycle-media-'));
try {
  const gifPath = join(temp, 'fixture.gif');
  writeFileSync(gifPath, Buffer.from('R0lGODdhCAAEAIEAAP8AAAAAAAAAAAAAACwAAAAACAAEAAAIDAABCBxIsKDBgwQDAgA7', 'base64'));
  runRendererFixture('renderer-runtime-lifecycle.qml.in', { __WPM_FIXTURE_URL__: gifPath });
  console.log('Quickshell lifecycle assertions passed (real Loader; 5 cycles; max 3 of 8 loaded).');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
