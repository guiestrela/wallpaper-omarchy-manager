#!/usr/bin/env python3
"""Exercise BarWidget's real Process/StdioCollector picker handoff."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import uuid

PROJECT = Path(__file__).resolve().parents[1]
NATIVE = Path('/usr/share/omarchy/shell')
PLUGIN_ID = 'io.github.guiestrela.wallpaperomarchymanager'

QML = r'''
import QtQuick
import Quickshell
import qs.services as Services
import qs.Ui as Ui
import "plugin" as Plugin
Scope {
  id: app
  property int stage: 0
  property int attempts: 0
  property var requestA: null
  Services.PluginShellApi {
    id: api
    pluginId: "io.github.guiestrela.wallpaperomarchymanager"
    _updateSettings: function(id, entry) { return true }
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
    settings: ({ id: "io.github.guiestrela.wallpaperomarchymanager",
      perDisplayConfig: false,
      displayConfig: { all: { folder: "", recursive: true, mode: "shuffle", pinned: "" } } })
  }
  Timer {
    interval: 10
    running: true
    repeat: true
    onTriggered: {
      if (app.stage === 0) {
        widget.settings = ({ id: "io.github.guiestrela.wallpaperomarchymanager",
          perDisplayConfig: false,
          displayConfig: { all: { folder: __FOLDER_A__, recursive: true, mode: "shuffle", pinned: "" } } })
        widget.loadPicker()
        app.stage = 1
        return
      }
      if (app.stage === 1) {
        if (!widget.__testPickerProcess.running) {
          if (++app.attempts > 150) {
            console.error("PICKER_PROCESS_TIMEOUT: first scan did not start")
            Qt.quit()
          }
          return
        }
        if (!widget.activePickerRequest || widget.activePickerRequest.folder !== __FOLDER_A__) {
          console.error("PICKER_PROCESS_FAIL: first request context", JSON.stringify(widget.activePickerRequest))
          Qt.quit()
          return
        }
        app.requestA = widget.activePickerRequest
        widget.settings = ({ id: "io.github.guiestrela.wallpaperomarchymanager",
          perDisplayConfig: false,
          displayConfig: { all: { folder: __FOLDER_B__, recursive: false, mode: "shuffle", pinned: "" } } })
        widget.loadPicker()
        app.stage = 2
        return
      }
      if (app.stage === 2) {
        if (!widget.queuedPickerRequest) return
        if (widget.queuedPickerRequest.folder !== __FOLDER_B__
            || widget.activePickerRequest.folder !== __FOLDER_A__
            || !widget.__testPickerProcess.running
            || widget.pickerImages.length !== 0
            || widget.pickerResultContext !== null) {
          console.error("PICKER_PROCESS_QUEUE_FAIL", JSON.stringify(widget.queuedPickerRequest),
                        JSON.stringify(widget.activePickerRequest), JSON.stringify(widget.pickerImages))
          Qt.quit()
          return
        }
        app.stage = 3
        return
      }
      if (app.stage === 3) {
        if (!widget.activePickerRequest || widget.activePickerRequest.folder !== __FOLDER_B__
            || !widget.__testPickerProcess.running) return
        if (widget.pickerImages.length !== 0 || widget.pickerResultContext !== null) {
          console.error("PICKER_PROCESS_STALE_OUTPUT_APPLIED", JSON.stringify(widget.pickerImages))
          Qt.quit()
          return
        }
        app.stage = 4
        return
      }
      if (app.stage === 4) {
        if (widget.__testPickerProcess.running || !widget.pickerResultContext) return
        if (widget.pickerResultContext.folder !== __FOLDER_B__
            || widget.pickerImages.length !== 1 || widget.pickerImages[0] !== __B_ROOT__) {
          console.error("PICKER_PROCESS_LATEST_OUTPUT_FAIL", JSON.stringify(widget.pickerResultContext),
                        JSON.stringify(widget.pickerImages))
          Qt.quit()
          return
        }
        if (widget.selectPickerImage(__A_ROOT__, app.requestA) !== false) {
          console.error("PICKER_PROCESS_STALE_CLICK_ACCEPTED")
          Qt.quit()
          return
        }
        console.log("PICKER_REAL_PROCESS_HANDOFF_PASS")
        Qt.quit()
      }
    }
  }
}
'''


def replace_once(source: str, old: str, new: str) -> str:
    if source.count(old) != 1:
        raise RuntimeError(f'expected exactly one source anchor: {old!r}')
    return source.replace(old, new, 1)


def main() -> None:
    if not (NATIVE / 'services/PluginShellApi.qml').is_file():
        raise SystemExit('Native Omarchy PluginShellApi is required')
    source = (PROJECT / 'BarWidget.qml').read_text()
    source = replace_once(source, 'Panel {\n  id: root\n',
        'Panel {\n  id: root\n  property alias __testPickerProcess: pickerProc\n')
    with tempfile.TemporaryDirectory(prefix='wallpaper-picker-process-', dir=os.environ.get('TMPDIR')) as temp:
        base = Path(temp)
        for name in ('Commons', 'Ui', 'services'):
            (base / name).symlink_to(NATIVE / name, target_is_directory=True)
        plugin = base / 'plugin'
        plugin.mkdir()
        (plugin / 'BarWidget.qml').write_text(source)
        (plugin / 'WallpaperRenderer.qml').symlink_to(PROJECT / 'WallpaperRenderer.qml')
        (plugin / 'manifest.json').symlink_to(PROJECT / 'manifest.json')
        folder_a = base / 'A'
        folder_b = base / 'B'
        nested_a = folder_a / 'nested'
        nested_b = folder_b / 'nested'
        nested_a.mkdir(parents=True)
        nested_b.mkdir(parents=True)
        a_root = folder_a / 'a-root.jpg'
        (nested_a / 'a-nested.jpg').write_bytes(b'fixture')
        a_root.write_bytes(b'fixture')
        b_root = folder_b / 'b-root.png'
        (nested_b / 'b-nested.png').write_bytes(b'fixture')
        b_root.write_bytes(b'fixture')
        bindir = base / 'bin'
        bindir.mkdir()
        find_wrapper = bindir / 'find'
        find_wrapper.write_text('#!/bin/sh\n/bin/sleep 0.45\nexec /usr/bin/find "$@"\n')
        find_wrapper.chmod(0o755)
        (base / 'shell.qml').write_text(
            QML.replace('__FOLDER_A__', json.dumps(str(folder_a)))
                .replace('__FOLDER_B__', json.dumps(str(folder_b)))
                .replace('__A_ROOT__', json.dumps(str(a_root)))
                .replace('__B_ROOT__', json.dumps(str(b_root))))

        env = os.environ.copy()
        runtime = Path(env.get('XDG_RUNTIME_DIR', '/run/user/' + str(os.getuid())))
        sockets = [path for path in runtime.glob('wayland-*') if path.is_socket()]
        if not sockets:
            raise SystemExit('A Wayland session is required for the native hidden Panel widget')
        for key in ('WAYLAND_DISPLAY', 'DISPLAY', 'HYPRLAND_INSTANCE_SIGNATURE', 'DBUS_SESSION_BUS_ADDRESS'):
            env.pop(key, None)
        for key, name in (('HOME', 'home'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache'),
                          ('XDG_STATE_HOME', 'state'), ('XDG_DATA_HOME', 'data'), ('XDG_RUNTIME_DIR', 'run')):
            directory = base / name
            directory.mkdir(mode=0o700)
            env[key] = str(directory)
        alias = Path.home() / '.cache' / ('wpm-picker-process-' + uuid.uuid4().hex[:8])
        alias.symlink_to(base / 'run', target_is_directory=True)
        env.update(QT_QPA_PLATFORM='wayland', QT_QPA_PLATFORMTHEME='', QT_QUICK_BACKEND='software',
                   WAYLAND_DISPLAY=str(sockets[0]), XDG_RUNTIME_DIR=str(alias),
                   PATH=str(bindir) + os.pathsep + env.get('PATH', ''))
        try:
            result = subprocess.run(['quickshell', '-n', '-p', str(base / 'shell.qml')],
                                    text=True, capture_output=True, env=env, timeout=15)
        except subprocess.TimeoutExpired as error:
            output = error.stdout or b''
            print(output.decode(errors='replace')[-12000:] if isinstance(output, bytes) else output[-12000:])
            raise SystemExit('Native picker process probe timed out')
        finally:
            alias.unlink(missing_ok=True)
        output = result.stdout + result.stderr
        if result.returncode or 'PICKER_REAL_PROCESS_HANDOFF_PASS' not in output:
            print(output[-12000:])
            raise SystemExit(result.returncode or 1)
        print('PICKER_REAL_PROCESS_HANDOFF_PASS')
        print('PROCESS=', 'Quickshell Process + StdioCollector; delayed find output; folder/recursion switch')
        print('WIDGET_SURFACE_OPENED=false; SETTINGS_CALLBACK_INERT=true')


if __name__ == '__main__':
    main()
