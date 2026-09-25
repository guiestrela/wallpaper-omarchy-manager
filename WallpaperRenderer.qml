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
  property bool preparing: false
  property bool loadMedia: true
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
    active: root.loadMedia && root.sourcePath !== ""
    sourceComponent: root.videoMode ? videoComponent : imageComponent
  }

  onSourcePathChanged: {
    ready = false
    // Loader bindings can be evaluated before a newly assigned path reaches
    // videoMode. Select the component imperatively so MP4 never passes through
    // the image decoder during a source change.
    renderer.active = false
    renderer.sourceComponent = isVideoPath(sourcePath) ? videoComponent : imageComponent
    renderer.active = loadMedia && sourcePath !== ""
  }

  onLoadMediaChanged: {
    ready = false
    renderer.active = false
    renderer.active = loadMedia && sourcePath !== ""
  }

  Component {
    id: imageComponent

    AnimatedImage {
      anchors.fill: parent
      source: root.videoMode ? "" : Util.fileUrl(root.sourcePath)
      // Decode near the rendered width while leaving height unspecified.
      // Supplying both viewport dimensions can make an image provider decode
      // directly into the screen's aspect ratio before PreserveAspectCrop is
      // applied. Asking for one dimension lets Qt derive the other from the
      // source, so Zoom always receives undistorted pixels to crop.
      sourceSize: Qt.size(
        Math.max(1, Math.ceil(Math.min(width, root.width))),
        0)
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

    Item {
      id: video
      anchors.fill: parent

      VideoOutput {
        id: videoOutput
        anchors.fill: parent
        fillMode: root.fillModeName === "zoom"
          ? VideoOutput.PreserveAspectCrop : VideoOutput.Stretch
      }

      MediaPlayer {
        id: player
        source: root.videoMode ? Util.fileUrl(root.sourcePath) : ""
        autoPlay: root.playing || root.preparing
        loops: MediaPlayer.Infinite
        videoOutput: videoOutput
        audioOutput: AudioOutput { muted: true }
        onErrorOccurred: function(error, errorString) {
          if (error !== MediaPlayer.NoError) root.wallpaperError(root.sourcePath)
        }
      }

      Connections {
        target: videoOutput.videoSink
        function onVideoFrameChanged() {
          if (root.ready || player.mediaStatus === MediaPlayer.NoMedia
              || videoOutput.sourceRect.width <= 0 || videoOutput.sourceRect.height <= 0) return
          root.ready = true
          root.wallpaperReady()
        }
      }

      function updatePlayback() {
        if (root.playing || root.preparing) player.play()
        else player.pause()
      }

      Component.onCompleted: updatePlayback()
      Connections {
        target: root
        function onPlayingChanged() {
          video.updatePlayback()
        }
        function onPreparingChanged() {
          video.updatePlayback()
        }
      }
    }
  }
}
