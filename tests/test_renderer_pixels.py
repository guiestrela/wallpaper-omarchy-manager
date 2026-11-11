#!/usr/bin/env python3
"""Render fixtures offscreen using Quickshell's registered native modules."""
import argparse
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import uuid
import zlib
from typing import cast
from PIL import Image

PROJECT = Path(__file__).resolve().parents[1]
NATIVE = Path('/usr/share/omarchy/shell')
QML = r'''
import QtQuick
import QtQuick.Window
import Quickshell
import "plugin" as Plugin
Scope {
  Window {
    id: window
    visible: true
    width: 320; height: 180
    property var cases: __DATA__
    property int index: 0
    property int frames: 0
    property int attempts: 0
    property bool grabbing: false
    Plugin.WallpaperRenderer { id: renderer; width: 320; height: 180; playing: false }
    Timer {
      interval: 100; running: true; repeat: true
      onTriggered: {
        if (window.grabbing) return
        var current = window.cases[window.index]
        if (renderer.sourcePath !== current.path) {
          renderer.sourcePath = current.path; window.frames = 0; window.attempts = 0; return
        }
        if (!renderer.ready) {
          if (++window.attempts < 50) return
          console.error("PIXELS_DECODE_FAIL", current.tag); Qt.quit(); return
        }
        if (++window.frames < 2) return
        window.grabbing = true
        renderer.grabToImage(function(result) {
          if (!result.saveToFile(__OUTPUT__ + "/" + window.index + ".png")) {
            console.error("PIXELS_CAPTURE_FAIL"); Qt.quit(); return
          }
          window.index++; window.frames = 0; window.grabbing = false
          if (window.index === window.cases.length) {
            console.log("WALLPAPER_PIXELS_CAPTURE_PASS"); Qt.quit()
          }
        })
      }
    }
  }
}
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--theme-folder', type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='wallpaper-pixels-', dir=os.environ.get('TMPDIR')) as tmp:
        base = Path(tmp)
        for name in ('Commons', 'Ui', 'services'):
            (base/name).symlink_to(NATIVE/name, target_is_directory=True)
        (base/'plugin').symlink_to(PROJECT, target_is_directory=True)
        def chunk(kind, data):
            return struct.pack('!I',len(data))+kind+data+struct.pack('!I',zlib.crc32(kind+data))
        fixture = base/'fixture.png'
        fixture.write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',8,4,8,2,0,0,0))
                            +chunk(b'IDAT',zlib.compress((b'\x00'+b'\xff\x00\x00'*8)*4))+chunk(b'IEND',b''))
        files = [fixture]
        if args.theme_folder:
            files += sorted(p for p in args.theme_folder.iterdir() if p.is_file() and p.suffix.lower() in ('.png','.jpg','.jpeg','.webp','.bmp'))
        cases = [{'tag':p.name,'path':str(p.resolve())} for p in files]
        output = base/'captures';output.mkdir()
        (base/'shell.qml').write_text(QML.replace('__DATA__',json.dumps(cases)).replace('__OUTPUT__',json.dumps(str(output))))
        env = os.environ.copy()
        for key in ('WAYLAND_DISPLAY','DISPLAY','DBUS_SESSION_BUS_ADDRESS','HYPRLAND_INSTANCE_SIGNATURE'):
            env.pop(key,None)
        for key,name in (('HOME','home'),('XDG_CONFIG_HOME','config'),('XDG_CACHE_HOME','cache'),('XDG_DATA_HOME','data'),('XDG_STATE_HOME','state'),('XDG_RUNTIME_DIR','run')):
            (base/name).mkdir(mode=0o700);env[key]=str(base/name)
        alias=Path.home()/'.cache'/('wpm-pixels-'+uuid.uuid4().hex[:8]);alias.symlink_to(base/'run',target_is_directory=True)
        env.update(QT_QPA_PLATFORM='offscreen',QT_QPA_PLATFORMTHEME='',QT_QUICK_BACKEND='software',XDG_RUNTIME_DIR=str(alias))
        try:
            result=subprocess.run(['quickshell','-n','-p',str(base/'shell.qml')],capture_output=True,text=True,env=env,timeout=40)
        finally:
            alias.unlink()
        text=result.stdout+result.stderr
        if result.returncode or 'WALLPAPER_PIXELS_CAPTURE_PASS' not in text:
            print(text[-8000:]);raise SystemExit(result.returncode or 1)
        for i,case in enumerate(cases):
            with Image.open(output/(str(i)+'.png')) as im:
                rgba=im.convert('RGBA')
                extrema=cast(tuple[tuple[int,int],tuple[int,int],tuple[int,int],tuple[int,int]],rgba.getextrema())
                if extrema[3][1]==0 or max(e[1] for e in extrema[:3])==0:
                    raise SystemExit('BLACK_OR_EMPTY_RENDER: '+case['tag'])
                print('PIXELS_PASS',case['tag'],im.size)
        print('IMAGE_CASES_PASSED',len(cases))


if __name__=='__main__':
    main()
