import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const background = readFileSync(new URL('../../Background.qml', import.meta.url), 'utf8');
const widget = readFileSync(new URL('../../BarWidget.qml', import.meta.url), 'utf8');
function extract(source, name) {
  const m = source.match(new RegExp(`^  function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}`, 'm'));
  assert.ok(m, `function ${name} exists`);
  return m[0];
}
function scannerCommand(source, file) {
  const line = source.split('\n').find(x => x.includes('test -d') && x.trim().startsWith('"'));
  assert.ok(line, `${file} has a fixed scanner command`);
  return vm.runInNewContext(line.trim().replace(/,$/, ''));
}

const root = mkdtempSync(join(tmpdir(), 'wpm-find-guard-'));
try {
  const home = join(root, 'home');
  mkdirSync(home);
  for (const [source, file] of [[background, 'Background.qml'], [widget, 'BarWidget.qml']]) {
    const fn = extract(source, 'safePath');
    const helpers = source === background ? extract(source, 'expandHome') : '';
    const ctx = vm.createContext({ Quickshell: { env: () => home }, home });
    vm.runInContext(`${helpers}; ${fn}; this.safePath=safePath`, ctx);

    for (const bad of ['', 'relative', '-delete', '-L', '!', '(', 'https://host/path', '/tmp/bad\u0001path']) {
      assert.equal(ctx.safePath(bad), '', `${file}: ${JSON.stringify(bad)} rejected`);
    }
    if (file === 'Background.qml') {
      assert.equal(ctx.safePath('~'), home, 'home shorthand expands');
      assert.equal(ctx.safePath('~/Pictures'), `${home}/Pictures`, 'home-relative path expands');
    }

    const good = join(root, 'a space "quote" $dollar;semi (paren)');
    mkdirSync(good, { recursive: true });
    const image = join(good, 'sample image.jpg');
    writeFileSync(image, 'fixture');
    writeFileSync(join(good, 'ignored.txt'), 'fixture');

    const body = extract(source, file === 'Background.qml' ? 'drainScans' : 'loadPicker');
    assert.match(body, /safePath\(/, `${file} validates the configured folder`);
    assert.ok(body.includes('$1'), `${file} passes the folder as positional data`);
    assert.doesNotMatch(body, /Util\.shellQuote\([^)]*folder|\+\s*Util\.shellQuote\(/,
      `${file} does not interpolate the folder into the shell source`);
    assert.ok(body.indexOf('test -d "$1" || exit 0') < body.indexOf('timeout --kill-after=1s 15s find'),
      `${file} checks directory existence before invoking find`);

    const command = scannerCommand(source, file);
    const scan = spawnSync('/bin/bash', ['-c', command, 'wpm-test', good, '-maxdepth 1'],
      { encoding: 'utf8', timeout: 5000 });
    assert.equal(scan.status, 0, `${file} safe fixture scan: ${scan.stderr || ''}`);
    assert.ok(scan.stdout.includes(image), `${file} scans a path with spaces/metacharacters intact`);
    assert.ok(!scan.stdout.includes('ignored.txt'), `${file} keeps the media extension filter`);

    const bin = join(root, `${file}-bin`);
    mkdirSync(bin);
    const marker = join(root, `${file}-find-was-started`);
    const fakeTimeout = join(bin, 'timeout');
    writeFileSync(fakeTimeout, '#!/bin/sh\n: > "$WPM_MARKER"\nexit 0\n');
    chmodSync(fakeTimeout, 0o700);
    const invalidRoot = join(root, `${file}-missing-directory`);
    const invalidScan = spawnSync('/bin/bash', ['-c', command, 'wpm-test', invalidRoot, '-maxdepth 1'], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, WPM_MARKER: marker },
    });
    assert.equal(invalidScan.error, undefined, `${file} missing directory check did not time out`);
    assert.equal(existsSync(marker), false, `${file} never invokes find for a missing directory`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('Find argument guard checks passed for both scanners, including safe fixture paths and missing-directory short circuit.');
