#!/usr/bin/env python3
"""Pixel regression for multi-display wallpaper readiness using real QML renderers."""
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import uuid
import zlib
from PIL import Image

PROJECT = Path(__file__).resolve().parents[1]
NATIVE = Path('/usr/share/omarchy/shell')
QML = r'''
import QtQuick
import QtQuick.Window
import Quickshell
import "plugin" as Plugin
Scope {
  id: app
  property bool badFrameErrored: false
  property bool timeoutApplied: false
  property int attempts: 0
  QtObject {
    id: transition
    property int frontSlot: 0
    property int backgroundVersion: 9
    property int revealTimedOutVersion: -1
    property real revealProgress: 0
    property bool revealArmed: false
    property var incomingReady: ({})
    property var incomingFailed: ({})
  }
  Window {
    id: window
    visible: true
    width: 320
    height: 160
    color: "black"
    property bool captured: false

    Item {
      id: displayOne
      x: 0; y: 0; width: 160; height: 160
      Plugin.WallpaperRenderer {
        id: oldOne
        anchors.fill: parent
        sourcePath: __OLD_ONE__
        playing: false
        visible: transition.frontSlot === 0
      }
      Plugin.WallpaperRenderer {
        id: newOne
        anchors.fill: parent
        sourcePath: __NEW_ONE__
        playing: false
        visible: transition.frontSlot === 1 || (ready && (transition.revealProgress >= 1 || transition.revealArmed))
        onWallpaperReady: transition.incomingReady = ({ "DP-1": true })
      }
    }

    Item {
      id: displayTwo
      x: 160; y: 0; width: 160; height: 160
      Plugin.WallpaperRenderer {
        id: oldTwo
        anchors.fill: parent
        sourcePath: __OLD_TWO__
        playing: false
        visible: transition.frontSlot === 0
      }
      Plugin.WallpaperRenderer {
        id: badTwo
        anchors.fill: parent
        sourcePath: __BAD_TWO__
        playing: false
        visible: transition.frontSlot === 1 || (ready && (transition.revealProgress >= 1 || transition.revealArmed))
        onWallpaperError: function(path) {
          app.badFrameErrored = true
          transition.incomingFailed = ({ "DP-2": path })
        }
      }
    }

    Timer {
      interval: 50
      running: true
      repeat: true
      onTriggered: {
        if (!oldOne.ready || !oldTwo.ready || !newOne.ready || !app.badFrameErrored) {
          if (++app.attempts < 100) return
          console.error("BACKGROUND_PIXEL_TIMEOUT: real decoder did not reach ready/error")
          Qt.quit()
          return
        }
        if (!app.timeoutApplied) {
          app.timeoutApplied = true
          transition.revealTimedOutVersion = transition.backgroundVersion
          if (transition.revealArmed || transition.frontSlot !== 0
              || transition.incomingReady["DP-2"] === true) {
            console.error("BACKGROUND_PIXEL_STATE_FAIL: failed display was promoted")
            Qt.quit()
            return
          }
          return
        }
        if (window.captured) return
        window.captured = true
        window.contentItem.grabToImage(function(result) {
          if (!result.saveToFile(__OUTPUT__)) {
            console.error("BACKGROUND_PIXEL_CAPTURE_FAIL")
            Qt.quit()
            return
          }
          console.log("BACKGROUND_PIXEL_CAPTURE_PASS")
          Qt.quit()
        })
      }
    }
  }

  Component.onCompleted: {
    transition.frontSlot = 0
    transition.backgroundVersion = 9
    transition.revealTimedOutVersion = -1
    transition.revealProgress = 0
    transition.revealArmed = false
    transition.incomingReady = ({})
    transition.incomingFailed = ({})
  }
}
'''


def png(path: Path, color: tuple[int, int, int]) -> None:
    width = height = 8

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))

    scanline = b'\x00' + bytes(color) * width
    data = b'\x89PNG\r\n\x1a\n'
    data += chunk(b'IHDR', struct.pack('!2I5B', width, height, 8, 2, 0, 0, 0))
    data += chunk(b'IDAT', zlib.compress(scanline * height))
    data += chunk(b'IEND', b'')
    path.write_bytes(data)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix='wallpaper-background-pixels-', dir=os.environ.get('TMPDIR')) as temp:
        base = Path(temp)
        for name in ('Commons', 'Ui', 'services'):
            (base / name).symlink_to(NATIVE / name, target_is_directory=True)
        (base / 'plugin').symlink_to(PROJECT, target_is_directory=True)
        fixtures = {name: base / name for name in ('old-one.png', 'new-one.png', 'old-two.png', 'bad-two.png')}
        png(fixtures['old-one.png'], (255, 0, 0))
        png(fixtures['new-one.png'], (0, 255, 0))
        png(fixtures['old-two.png'], (0, 0, 255))
        fixtures['bad-two.png'].write_bytes(b'not an image')
        output = base / 'capture.png'
        qml = QML
        replacements = {
            '__OLD_ONE__': json.dumps(str(fixtures['old-one.png'])),
            '__NEW_ONE__': json.dumps(str(fixtures['new-one.png'])),
            '__OLD_TWO__': json.dumps(str(fixtures['old-two.png'])),
            '__BAD_TWO__': json.dumps(str(fixtures['bad-two.png'])),
            '__OUTPUT__': json.dumps(str(output)),
        }
        for key, value in replacements.items():
            qml = qml.replace(key, value)
        (base / 'shell.qml').write_text(qml)

        env = os.environ.copy()
        for key in ('WAYLAND_DISPLAY', 'DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'HYPRLAND_INSTANCE_SIGNATURE'):
            env.pop(key, None)
        for key, name in (('HOME', 'home'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache'),
                          ('XDG_DATA_HOME', 'data'), ('XDG_STATE_HOME', 'state'), ('XDG_RUNTIME_DIR', 'run')):
            (base / name).mkdir(mode=0o700)
            env[key] = str(base / name)
        alias = Path.home() / '.cache' / ('wpm-background-pixels-' + uuid.uuid4().hex[:8])
        alias.symlink_to(base / 'run', target_is_directory=True)
        env.update(QT_QPA_PLATFORM='offscreen', QT_QPA_PLATFORMTHEME='', QT_QUICK_BACKEND='software',
                   XDG_RUNTIME_DIR=str(alias))
        try:
            try:
                result = subprocess.run(['quickshell', '-n', '-p', str(base / 'shell.qml')],
                                        capture_output=True, text=True, env=env, timeout=30)
            except subprocess.TimeoutExpired as error:
                for captured in (error.stdout, error.stderr):
                    if captured:
                        print(captured.decode(errors='replace')[-10000:]
                              if isinstance(captured, bytes) else captured[-10000:])
                raise SystemExit('Background pixel probe timed out')
        finally:
            alias.unlink(missing_ok=True)
        output_text = result.stdout + result.stderr
        if result.returncode or 'BACKGROUND_PIXEL_CAPTURE_PASS' not in output_text or not output.is_file():
            print(output_text[-10000:])
            raise SystemExit(result.returncode or 1)
        with Image.open(output) as image:
            pixels = image.convert('RGB')
            observed = (pixels.getpixel((40, 80)), pixels.getpixel((240, 80)))
            expected = ((255, 0, 0), (0, 0, 255))
            if observed != expected:
                raise SystemExit(f'BACKGROUND_PIXEL_MISMATCH: expected={expected}, observed={observed}')
        print('BACKGROUND_PIXEL_PASS', observed, 'size=', image.size)
        print('BACKGROUND_TEST_SERVICE_INERT=true')


if __name__ == '__main__':
    main()
