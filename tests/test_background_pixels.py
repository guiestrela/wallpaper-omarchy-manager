#!/usr/bin/env python3
"""Exercise Background.qml transitions and real renderer pixels offscreen."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
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
  property int stage: 0
  property int elapsed: 0
  property int attempts: 0
  property int captures: 0
  Window {
    id: window
    visible: true
    width: 320
    height: 160
    color: "black"
    Plugin.Background {
      id: background
      anchors.fill: parent
    }
    function keepStage(logical, snapshot, lease) {
      var key = JSON.stringify(["/fixture/pins", logical])
      var paths = ({})
      for (var oldKey in background.stagedPinnedPaths) paths[oldKey] = background.stagedPinnedPaths[oldKey]
      paths[key] = snapshot
      background.stagedPinnedPaths = paths
      var tokens = ({})
      for (var tokenKey in background.stagedPinnedLeaseTokens) tokens[tokenKey] = background.stagedPinnedLeaseTokens[tokenKey]
      tokens[key] = lease
      background.stagedPinnedLeaseTokens = tokens
    }
    Component.onCompleted: {
      background.__testScreens = [
        { name: "DP-1", x: 0, y: 0, width: 160, height: 160 },
        { name: "DP-2", x: 160, y: 0, width: 160, height: 160 }
      ]
      window.keepStage(__OLD_ONE__, __OLD_ONE_STAGE__, __OLD_ONE_TOKEN__)
      window.keepStage(__OLD_TWO__, __OLD_TWO_STAGE__, __OLD_TWO_TOKEN__)
    }
    Timer {
      interval: 10
      running: true
      repeat: true
      onTriggered: {
        if (app.stage === 0) {
          if (!background.__testPanels || background.__testPanels.length !== 2) {
            if (++app.attempts > 200) {
              console.error("BACKGROUND_COMPONENT_TIMEOUT: two materialized panels absent")
              Qt.quit()
            }
            return
          }
          background.displayedMap = ({ "DP-1": __OLD_ONE__, "DP-2": __OLD_TWO__ })
          background.slotAMap = ({ "DP-1": __OLD_ONE__, "DP-2": __OLD_TWO__ })
          background.revealProgress = 1
          app.stage = 1
          return
        }
        if (app.stage === 1) {
          if (!background.__testPanels[0].__testFrameAReady
              || !background.__testPanels[1].__testFrameAReady) return
          window.keepStage(__NEW_ONE__, __NEW_ONE_STAGE__, __NEW_ONE_TOKEN__)
          window.keepStage(__BAD_TWO__, __BAD_TWO_STAGE__, __BAD_TWO_TOKEN__)
          background.applyPerScreen({ "DP-1": __NEW_ONE__, "DP-2": __BAD_TWO__ }, false)
          app.stage = 2
          return
        }
        if (app.stage === 2) {
          if (!background.badImages[__BAD_TWO__]) return
          if (++app.elapsed < 80) return
          if (background.frontSlot !== 0
              || background.slotAMap["DP-1"] !== __OLD_ONE__
              || background.slotAMap["DP-2"] !== __OLD_TWO__) {
            console.error("BACKGROUND_OLD_SLOT_RELEASED", background.frontSlot,
                          JSON.stringify(background.slotAMap))
            Qt.quit()
            return
          }
          var oldOneKey = JSON.stringify(["/fixture/pins", __OLD_ONE__])
          var oldTwoKey = JSON.stringify(["/fixture/pins", __OLD_TWO__])
          if (background.stagedPinnedPaths[oldOneKey] !== __OLD_ONE_STAGE__
              || background.stagedPinnedLeaseTokens[oldOneKey] !== __OLD_ONE_TOKEN__
              || background.stagedPinnedPaths[oldTwoKey] !== __OLD_TWO_STAGE__
              || background.stagedPinnedLeaseTokens[oldTwoKey] !== __OLD_TWO_TOKEN__) {
            console.error("BACKGROUND_VISIBLE_SLOT_LEASE_RELEASED",
                          JSON.stringify(background.stagedPinnedPaths),
                          JSON.stringify(background.stagedPinnedLeaseTokens))
            Qt.quit()
            return
          }
          if (background.rendererSourcePaths[JSON.stringify(["DP-1", "slotA"])] !== __OLD_ONE_STAGE__
              || background.rendererSourcePaths[JSON.stringify(["DP-2", "slotA"])] !== __OLD_TWO_STAGE__) {
            console.error("BACKGROUND_OLD_RENDERER_SOURCE_RELEASED",
                          JSON.stringify(background.rendererSourcePaths))
            Qt.quit()
            return
          }
          if (background.revealTimedOutVersion !== background.backgroundVersion
              || background.revealArmed
              || background.revealStartedVersion === background.backgroundVersion) {
            console.error("BACKGROUND_TIMEOUT_DID_NOT_HOLD_REVEAL",
                          background.revealTimedOutVersion, background.backgroundVersion,
                          background.revealArmed, background.revealStartedVersion)
            Qt.quit()
            return
          }
          if (background.incomingReady["DP-1"] !== true
              || background.incomingReady["DP-2"] === true) {
            console.error("BACKGROUND_DECODER_READINESS_NOT_ASYMMETRIC",
                          JSON.stringify(background.incomingReady))
            Qt.quit()
            return
          }
          // A decoder callback delivered after this transition failed must not
          // revive that failed slot.
          var failedVersion = background.backgroundVersion
          background.noteIncomingReady("DP-2", failedVersion, __BAD_TWO__)
          if (background.incomingReady["DP-2"] === true) {
            console.error("BACKGROUND_LATE_FAILED_CALLBACK_ACCEPTED")
            Qt.quit()
            return
          }
          app.stage = 3
          app.elapsed = 0
          return
        }
        if (app.stage === 3) {
          // Start a new generation, then deliver readiness from the prior one.
          // This reaches the actual Background.qml method, not a copied helper.
          var staleVersion = background.backgroundVersion
          background.applyPerScreen({ "DP-1": __NEW_ONE__, "DP-2": __BAD_TWO__ }, false)
          if (background.backgroundVersion === staleVersion) {
            console.error("BACKGROUND_TEST_SETUP_FAIL: generation did not advance")
            Qt.quit()
            return
          }
          background.noteIncomingReady("DP-1", staleVersion, __NEW_ONE__)
          if (background.incomingReady["DP-1"] === true) {
            console.error("BACKGROUND_STALE_GENERATION_CALLBACK_ACCEPTED")
            Qt.quit()
            return
          }
          app.stage = 4
          app.elapsed = 0
          return
        }
        if (app.stage === 4) {
          if (++app.elapsed < 30) return
          background.__testPanels[0].contentItem.grabToImage(function(result) {
            if (!result.saveToFile(__OUTPUT_ONE__)) {
              console.error("BACKGROUND_PIXEL_CAPTURE_FAIL: DP-1")
              Qt.quit()
              return
            }
            app.captures++
            if (app.captures === 2) {
              console.log("BACKGROUND_PRODUCTION_TRANSITION_PASS")
              Qt.quit()
            }
          })
          background.__testPanels[1].contentItem.grabToImage(function(result) {
            if (!result.saveToFile(__OUTPUT_TWO__)) {
              console.error("BACKGROUND_PIXEL_CAPTURE_FAIL: DP-2")
              Qt.quit()
              return
            }
            app.captures++
            if (app.captures === 2) {
              console.log("BACKGROUND_PRODUCTION_TRANSITION_PASS")
              Qt.quit()
            }
          })
          app.stage = 5
        }
      }
    }
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


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f'expected one {label} anchor, found {count}')
    return source.replace(old, new, 1)


def make_test_background(source: str) -> str:
    # Keep production transitions, renderers, and lease pruning intact. The
    # forced service flag exists only to exercise map-based snapshot retention;
    # shell context and IPC stay absent/disabled in this offscreen harness.
    source = replace_once(source, 'Item {\n  id: root\n',
        'Item {\n  id: root\n  property var __testScreens: []\n  property var __testPanels: []\n', 'root test properties')
    source = replace_once(source, 'readonly property bool serviceActive: hasServiceContext()',
        'readonly property bool serviceActive: true', 'test-only lease accounting state')
    source = replace_once(source, 'enabled: root.serviceActive\n    target: "background"',
        'enabled: false\n    target: "background"', 'inert service IPC')
    service_handler = ('  onServiceActiveChanged: {\n'
        '    if (serviceActive) {\n'
        '      if (hasFolder()) prepareCurrentLinkState()\n'
        '      root.renewPinnedLeaseSnapshots()\n'
        '      configReload.restart()\n'
        '    }\n'
        '    else root.deactivateService()\n'
        '  }\n')
    source = replace_once(source, service_handler, '', 'service lifecycle handler')
    source = replace_once(source, 'var screens = Quickshell.screens || []',
        'var screens = root.__testScreens || []', 'screen source injection')
    source = replace_once(source, 'model: root.serviceActive ? Quickshell.screens : []',
        'model: root.__testScreens', 'variant screen model')
    source, count = re.subn(r'(id: revealArmTimeout\s+interval:\s*)1500', r'\g<1>80', source, count=1)
    if count != 1:
        raise RuntimeError('expected exactly one reveal timeout interval')
    source = replace_once(source, 'import QtQuick\n',
        'import QtQuick\nimport QtQuick.Window\n', 'window import')
    source = replace_once(source, 'PanelWindow {\n      id: panel\n      required property var modelData\n',
        'Window {\n      id: panel\n      required property var modelData\n'
        '      x: modelData.x\n      y: modelData.y\n      width: modelData.width\n      height: modelData.height\n'
        '      property bool __testFrameAReady: frameA.ready\n'
        '      property string __testSlotASource: frameA.sourcePath\n'
        '      property string __testSlotBSource: frameB.sourcePath\n'
        '      property bool __testLayerAVisible: frameALayer.visible\n'
        '      property bool __testLayerBVisible: frameBLayer.visible\n'
        '      Component.onCompleted: root.__testPanels = root.__testPanels.concat([panel])\n',
        'platform panel host')
    source = replace_once(source, 'visible: !remapGuard.remapping && !root.suspended',
        'visible: !root.suspended', 'panel visibility')
    for old, label in [
        ('      screen: modelData\n', 'panel screen property'),
        ('      anchors { top: true; bottom: true; left: true; right: true }\n', 'panel anchors'),
        ('      color: panel.scaling === "zoom" ? "transparent" : Commons.Color.background\n', 'panel color'),
        ('      updatesEnabled: true\n', 'panel updates property'),
        ('      WlrLayershell.namespace: "omarchy-background"\n', 'layershell namespace'),
        ('      WlrLayershell.layer: WlrLayer.Background\n', 'layershell layer'),
        ('      WlrLayershell.keyboardFocus: WlrKeyboardFocus.None\n', 'layershell focus'),
        ('      exclusionMode: ExclusionMode.Ignore\n', 'panel exclusion mode'),
        ('      ScreenMoveRemap {\n        id: remapGuard\n        window: panel\n      }\n', 'screen remap helper'),
    ]:
        if old not in source:
            raise RuntimeError(f'missing platform host block: {label}')
        source = source.replace(old, '', 1)
    return source


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--background-source', type=Path, default=PROJECT / 'Background.qml')
    args = parser.parse_args()
    original = args.background_source.read_text()
    with tempfile.TemporaryDirectory(prefix='wallpaper-background-production-', dir=os.environ.get('TMPDIR')) as temp:
        base = Path(temp)
        plugin = base / 'plugin'
        plugin.mkdir()
        (plugin / 'Background.qml').write_text(make_test_background(original))
        for name in ('WallpaperRenderer.qml', 'publish-current-background.py', 'stage-pinned-media.py'):
            (plugin / name).symlink_to(PROJECT / name)
        for name in ('Commons', 'Ui', 'services'):
            (base / name).symlink_to(NATIVE / name, target_is_directory=True)
        cache_home = base / 'cache'
        stage_root = cache_home / 'omarchy/wallpaperomarchymanager/pinned'
        logical = {name: f'/fixture/pins/{name}.png'
                   for name in ('old-one', 'new-one', 'old-two', 'bad-two')}
        colors = {'old-one': (255, 0, 0), 'new-one': (0, 255, 0), 'old-two': (0, 0, 255)}
        snapshots = {}
        tokens = {}
        for name in logical:
            digest = hashlib.sha256(name.encode()).hexdigest()
            snapshot = stage_root / digest / 'media.png'
            snapshot.parent.mkdir(parents=True)
            if name == 'bad-two':
                snapshot.write_bytes(b'not an image')
            else:
                png(snapshot, colors[name])
            snapshots[name] = snapshot
            tokens[name] = hashlib.sha256(('lease-' + name).encode()).hexdigest()[:32]
        output_one = base / 'capture-dp1.png'
        output_two = base / 'capture-dp2.png'
        qml = QML
        replacements = {
            '__OLD_ONE__': json.dumps(logical['old-one']),
            '__OLD_ONE_STAGE__': json.dumps(str(snapshots['old-one'])),
            '__OLD_ONE_TOKEN__': json.dumps(tokens['old-one']),
            '__NEW_ONE__': json.dumps(logical['new-one']),
            '__NEW_ONE_STAGE__': json.dumps(str(snapshots['new-one'])),
            '__NEW_ONE_TOKEN__': json.dumps(tokens['new-one']),
            '__OLD_TWO__': json.dumps(logical['old-two']),
            '__OLD_TWO_STAGE__': json.dumps(str(snapshots['old-two'])),
            '__OLD_TWO_TOKEN__': json.dumps(tokens['old-two']),
            '__BAD_TWO__': json.dumps(logical['bad-two']),
            '__BAD_TWO_STAGE__': json.dumps(str(snapshots['bad-two'])),
            '__BAD_TWO_TOKEN__': json.dumps(tokens['bad-two']),
            '__OUTPUT_ONE__': json.dumps(str(output_one)),
            '__OUTPUT_TWO__': json.dumps(str(output_two)),
        }
        for key, value in replacements.items():
            qml = qml.replace(key, value)
        (base / 'shell.qml').write_text(qml)

        env = os.environ.copy()
        for key in ('WAYLAND_DISPLAY', 'DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'HYPRLAND_INSTANCE_SIGNATURE'):
            env.pop(key, None)
        for key, name in (('HOME', 'home'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache'),
                          ('XDG_DATA_HOME', 'data'), ('XDG_STATE_HOME', 'state'), ('XDG_RUNTIME_DIR', 'run')):
            (base / name).mkdir(mode=0o700, exist_ok=True)
            env[key] = str(base / name)
        alias = Path.home() / '.cache' / ('wpm-background-production-' + uuid.uuid4().hex[:8])
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
                raise SystemExit('Background production pixel probe timed out')
        finally:
            alias.unlink(missing_ok=True)
        output_text = result.stdout + result.stderr
        if (result.returncode or 'BACKGROUND_PRODUCTION_TRANSITION_PASS' not in output_text
                or not output_one.is_file() or not output_two.is_file()):
            print(output_text[-12000:])
            raise SystemExit(result.returncode or 1)
        with Image.open(output_one) as image_one, Image.open(output_two) as image_two:
            observed = (image_one.convert('RGB').getpixel((80, 80)),
                        image_two.convert('RGB').getpixel((80, 80)))
            expected = ((255, 0, 0), (0, 0, 255))
            if observed != expected:
                print(output_text[-12000:])
                raise SystemExit(f'BACKGROUND_PIXEL_MISMATCH: expected={expected}, observed={observed}')
        print('BACKGROUND_PRODUCTION_PIXEL_PASS', observed, 'size=', (image_one.size, image_two.size))
        print('BACKGROUND_SOURCE=', args.background_source)
        print('SHELL_API_INERT=true; SHELL_IPC_DISABLED=true; OFFSCREEN_DISPLAYS=2')


if __name__ == '__main__':
    main()
