#!/usr/bin/env python3
"""Load real QML and Omarchy APIs without changing the user's desktop.

The service deliberately has no injected context, so it creates no wallpaper
surfaces. The widget stays closed. Settings writes target an inert callback on
the real PluginShellApi. This is not a graphical/compositor acceptance test.
"""
import os
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import uuid
import zlib

PROJECT = Path(__file__).resolve().parents[1]
NATIVE = Path('/usr/share/omarchy/shell')
QML = r'''
import QtQuick
import Quickshell
import qs.services as Services
import qs.Ui as Ui
import __PLUGIN_URI__ as Plugin
Scope {
  id: probe
  property int writes: 0
  Services.PluginShellApi {
    id: api
    pluginId: "io.github.guiestrela.wallpaperomarchymanager"
    _updateSettings: function(id, entry) {
      if (id !== pluginId || entry.id !== pluginId) throw new Error("wrong owner")
      probe.writes++
      return true
    }
  }
  Ui.PluginBarApi {
    id: facade
    pluginId: "io.github.guiestrela.wallpaperomarchymanager"
    moduleName: pluginId
    shell: api
    fontFamily: "monospace"
    foreground: "white"
    barForeground: "white"
    background: "black"
    urgent: "red"
    position: "top"
    barSize: 32
  }
  Plugin.BarWidget {
    id: widget
    bar: facade
    settings: ({ id: "io.github.guiestrela.wallpaperomarchymanager", intervalSec: 0,
      perDisplayConfig: false, displayConfig: { all: { folder: "", mode: "shuffle" } } })
  }
  Plugin.Background { id: service }
  Plugin.WallpaperRenderer {
    id: renderer
    width: 32
    height: 32
    sourcePath: __FIXTURE_PATH__
    playing: false
  }
  Timer {
    property int attempts: 0
    interval: 200
    running: true
    repeat: true
    onTriggered: {
      if (!renderer.ready) {
        if (++attempts < 20) return
        throw new Error("fixture image did not decode")
      }
      if (service.serviceActive) throw new Error("test service must remain inert")
      var handler = null
      for (var i=0; i<service.data.length; i++) {
        if (service.data[i].target === "background") handler = service.data[i]
      }
      if (!handler) throw new Error("background IPC handler missing")
      handler.setSuspended("true")
      if (!service.suspended) throw new Error("OWE suspend failed")
      handler.setSuspended("false")
      if (service.suspended) throw new Error("OWE resume failed")
      if (widget.opened) throw new Error("test must not open a desktop surface")
      if (!widget.persist("intervalSec", 120)) throw new Error("settings rejected")
      if (!widget.persist("shuffleOnWake", true)) throw new Error("second edit rejected")
      if (widget.settings.intervalSec !== 120 || !widget.settings.shuffleOnWake || probe.writes !== 2)
        throw new Error("consecutive edits lost data")
      if (!widget.acceptFolderUrl("file:///fixtures/my%20walls") || probe.writes !== 3
          || widget.settings.displayConfig.all.folder !== "/fixtures/my walls")
        throw new Error("native folder selection did not persist")
      console.log("WALLPAPER_NATIVE_QML_PASS")
      Qt.quit()
    }
  }
}
'''


def main():
    if not (NATIVE / 'services/PluginShellApi.qml').is_file():
        raise SystemExit('Native Omarchy PluginShellApi is required')
    with tempfile.TemporaryDirectory(prefix='wallpaper-compat-', dir=os.environ.get('TMPDIR')) as temp:
        base = Path(temp)
        runtime = Path(os.environ.get('XDG_RUNTIME_DIR', '/run/user/' + str(os.getuid())))
        sockets = [p for p in runtime.glob('wayland-*') if p.is_socket()]
        if not sockets:
            raise SystemExit('A Wayland session is required to load native PanelWindow, even while hidden')
        for name in ('Commons', 'Ui', 'services'):
            (base / name).symlink_to(NATIVE / name, target_is_directory=True)
        (base / 'plugin').symlink_to(PROJECT, target_is_directory=True)
        # A genuine local PNG, not user media. Decode exercises the real renderer.
        def chunk(kind, data):
            return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
        image = base / 'fixture.png'
        image.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', 8, 8, 8, 2, 0, 0, 0))
                          + chunk(b'IDAT', zlib.compress((b'\x00' + b'\xff\x00\x00' * 8) * 8)) + chunk(b'IEND', b''))
        (base / 'shell.qml').write_text(QML.replace('__PLUGIN_URI__', '"plugin"')
                                        .replace('__FIXTURE_PATH__', json.dumps(str(image))))
        env = os.environ.copy()
        for key in ('WAYLAND_DISPLAY', 'DISPLAY', 'HYPRLAND_INSTANCE_SIGNATURE', 'DBUS_SESSION_BUS_ADDRESS'):
            env.pop(key, None)
        for key, name in (('HOME', 'home'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache'),
                          ('XDG_STATE_HOME', 'state'), ('XDG_DATA_HOME', 'data'), ('XDG_RUNTIME_DIR', 'run')):
            directory = base / name
            directory.mkdir(mode=0o700)
            env[key] = str(directory)
        # Short runtime alias avoids the Unix socket path limit. Connect to the
        # compositor only to construct hidden native popup types; no window opens.
        alias = Path.home() / '.cache' / ('wpm-qa-' + uuid.uuid4().hex[:8])
        alias.symlink_to(base / 'run', target_is_directory=True)
        env.update(QT_QPA_PLATFORM='wayland', QT_QPA_PLATFORMTHEME='', QT_QUICK_BACKEND='software',
                   WAYLAND_DISPLAY=str(sockets[0]), XDG_RUNTIME_DIR=str(alias))
        try:
            result = subprocess.run(['quickshell', '-n', '-p', str(base / 'shell.qml')],
                                    text=True, capture_output=True, env=env, timeout=12)
        except subprocess.TimeoutExpired as error:
            output = error.stdout or b''
            print(output.decode(errors='replace')[-10000:] if isinstance(output, bytes) else output[-10000:])
            raise SystemExit('Native QML probe timed out')
        finally:
            alias.unlink()
        output = result.stdout + result.stderr
        if result.returncode or 'WALLPAPER_NATIVE_QML_PASS' not in output:
            print(output[-10000:])
            raise SystemExit(result.returncode or 1)
        severe = [line for line in output.splitlines() if any(s in line for s in
                  ('TypeError:', 'ReferenceError:', 'Cannot assign', 'is not a type', 'is not installed'))]
        if severe:
            print('\n'.join(severe))
            raise SystemExit('QML runtime errors')
        print('PASS: native QML widget/service load; scoped settings; service inert; popup closed')
        warnings = [line for line in output.splitlines() if 'WARN' in line]
        print('Native probe warning lines:', len(warnings))
        for line in warnings[:8]:
            print(line)


if __name__ == '__main__':
    main()
