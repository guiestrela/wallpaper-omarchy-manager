import QtQuick
import QtMultimedia
import qs.Commons

// Renders both image wallpapers and video wallpapers through one small API.
// The parent controls the final size, so all existing scaling modes continue
// to work for either kind of media.
Item {
  id: root

  property string sourcePath: ""
  property string fillModeName: "zoom"
  property bool ready: false
  property bool playing: true
  function isVideoPath(path) {
    var value = String(path || "").toLowerCase()
    return [".mp4", ".webm", ".mkv", ".mov", ".avi"].some(function(ext) {
      return value.slice(-ext.length) === ext
    })
  }
  readonly property bool videoMode: isVideoPath(sourcePath)

  signal wallpaperReady()
  signal wallpaperError(string path)

  implicitWidth: renderer.item ? renderer.item.implicitWidth : 0
  implicitHeight: renderer.item ? renderer.item.implicitHeight : 0

  Loader {
    id: renderer
    anchors.fill: parent
    active: root.sourcePath !== ""
    sourceComponent: root.videoMode ? videoComponent : imageComponent
  }

  onSourcePathChanged: {
    ready = false
    // Loader bindings can be evaluated before a newly assigned path reaches
    // videoMode. Select the component imperatively so MP4 never passes through
    // the image decoder during a source change.
    renderer.active = false
    renderer.sourceComponent = isVideoPath(sourcePath) ? videoComponent : imageComponent
    renderer.active = sourcePath !== ""
  }

  Component {
    id: imageComponent

    AnimatedImage {
      anchors.fill: parent
      source: root.videoMode ? "" : Util.fileUrl(root.sourcePath)
      // Decode static and animated images near their rendered size. Some
      // wallpapers are tens of thousands of pixels wide and otherwise exceed
      // Qt's 256 MiB decoded-image limit even when the compressed file is small.
      // A wallpaper larger than the viewport has no visible detail beyond
      // the viewport. Cap decoding at the monitor/widget size so "actual"
      // scaling cannot turn a very large source image into a large allocation.
      sourceSize: Qt.size(
        Math.max(1, Math.ceil(Math.min(width, root.width))),
        Math.max(1, Math.ceil(Math.min(height, root.height))))
      fillMode: root.fillModeName === "zoom" ? Image.PreserveAspectCrop : Image.Stretch
      asynchronous: true
      cache: false
      smooth: true
      playing: root.playing
      onStatusChanged: {
        if (status === Image.Ready) { root.ready = true; root.wallpaperReady() }
        else if (status === Image.Error && !root.videoMode) root.wallpaperError(root.sourcePath)
      }
    }
  }

  Component {
    id: videoComponent

    Video {
      id: video
      anchors.fill: parent
      source: root.videoMode ? Util.fileUrl(root.sourcePath) : ""
      fillMode: root.fillModeName === "zoom"
        ? VideoOutput.PreserveAspectCrop : VideoOutput.Stretch
      autoPlay: root.playing
      loops: MediaPlayer.Infinite
      muted: true
      onPlaybackStateChanged: {
        if (playbackState === MediaPlayer.PlayingState) { root.ready = true; root.wallpaperReady() }
      }
      onErrorChanged: {
        if (error !== MediaPlayer.NoError) root.wallpaperError(root.sourcePath)
      }
      Component.onCompleted: if (root.playing) play()
      Connections {
        target: root
        function onPlayingChanged() {
          if (root.playing) video.play()
          else video.pause()
        }
      }
    }
  }
}
