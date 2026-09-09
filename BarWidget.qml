import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// Bar icon + settings panel for the folder-backed background service.
//
// The widget exists mainly so the settings have somewhere to live: shell.json
// plugin settings can only be persisted through `setBarWidget`, which targets
// entries in bar.layout.*. Everything here writes through that IPC rather than
// touching shell.json, so the shell stays the only writer.
//
// The service reads the same entry back out of the scoped public bar config, so
// change reaches the wallpaper without a restart.
Panel {
  id: root
  moduleName: "io.github.guiestrela.wallpaperomarchymanager"
  ipcTarget: "io.github.guiestrela.wallpaperomarchymanager"
  manageIpc: false

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  readonly property bool perDisplay: setting("perDisplay", true) === true
  readonly property int intervalSec: Math.max(0, Number(setting("intervalSec", 0)) || 0)
  readonly property bool shuffleOnWake: setting("shuffleOnWake", false) === true
  // ---------------------------------------------------- per-display config

  readonly property bool perDisplayConfig: setting("perDisplayConfig", true) === true
  readonly property var displayConfig: setting("displayConfig", null)

  // Which display's settings the panel is showing. Empty means the shared
  // "all" entry, which is also what every display reads when the per-display
  // toggle is off.
  property string editing: ""

  // Must resolve exactly as editingTabLabel() does. `editing` stays empty until
  // a display tab is actually clicked, and falling back to "all" here while the
  // tab row already highlights the first display meant that a change made
  // before any click landed on the shared entry rather than on the display
  // shown as selected: the setting saved, the panel updated to match, and
  // nothing happened on screen.
  readonly property string editingKey: {
    if (!perDisplayConfig) return "all"
    var tabs = displayTabs()
    if (editing !== "" && tabs.indexOf(editing) !== -1) return editing
    return tabs.length ? tabs[0] : "all"
  }

  // The same resolution the service performs, so the panel shows what is
  // actually in effect rather than what was last typed. Legacy top-level
  // folder/recursive are the fallback, which is what makes an older settings
  // file open correctly instead of looking empty.
  function configFor(key) {
    var dc = displayConfig
    var c = (dc && typeof dc === "object" && dc[key] && typeof dc[key] === "object") ? dc[key] : null
    if (!c && dc && dc.all && typeof dc.all === "object") c = dc.all
    var pick = function(k, legacy) {
      return (c && c[k] !== undefined && c[k] !== null) ? c[k] : legacy
    }
    var mode = String(pick("mode", "shuffle"))
    var scaling = String(pick("scaling", "zoom"))
    var folder = String(pick("folder", setting("folder", "")))
    var pinned = String(pick("pinned", ""))
    if (folder.trim() === "") pinned = ""
    return {
      folder: folder,
      recursive: pick("recursive", setting("recursive", true)) === true,
      mode: mode === "single" ? "single" : "shuffle",
      pinned: pinned,
      scaling: ["zoom", "fitHeight", "fitWidth", "actual"].indexOf(scaling) !== -1 ? scaling : "zoom"
    }
  }

  readonly property var current: configFor(editingKey)

  // Writes the whole displayConfig back, because setBarWidget replaces a key
  // rather than merging into it. Seeding from the resolved config also folds
  // any legacy top-level settings into the new shape on the first edit, which
  // is the only migration this needs.
  function copyDisplayConfig() {
    var dc = ({})
    var existing = displayConfig
    if (existing && typeof existing === "object") {
      for (var k in existing) {
        if (existing[k] && typeof existing[k] === "object") {
          var copy = ({})
          for (var f in existing[k]) copy[f] = existing[k][f]
          dc[k] = copy
        }
      }
    }
    return dc
  }

  function persistDisplay(key, value) {
    var dc = copyDisplayConfig()
    if (!dc[editingKey]) dc[editingKey] = configFor(editingKey)
    dc[editingKey][key] = value
    persist("displayConfig", dc)
  }

  // When switching from per-display settings to one shared setting, preserve
  // the configuration currently shown in the panel instead of falling back to
  // the empty legacy top-level folder. Queue the displayConfig write first so
  // the following toggle cannot race it.
  function setPerDisplayConfig(enabled) {
    enabled = enabled === true
    if (!enabled) {
      var dc = copyDisplayConfig()
      if (!dc.all || typeof dc.all !== "object") dc.all = configFor(editingKey)
      persist("displayConfig", dc)
    }
    persist("perDisplayConfig", enabled)
  }

  // Clearing a folder must also clear its pin. Otherwise the service still
  // considers the plugin active because a stale pinned path remains.
  function clearFolder() {
    var dc = copyDisplayConfig()
    if (!dc[editingKey]) dc[editingKey] = configFor(editingKey)
    dc[editingKey].folder = ""
    dc[editingKey].pinned = ""
    persist("displayConfig", dc)
  }

  readonly property var scalingOptions: [
    { key: "zoom", label: "Zoom" },
    { key: "fitHeight", label: "Fit ↕" },
    { key: "fitWidth", label: "Fit ↔" },
    { key: "actual", label: "Actual" }
  ]

  function scalingLabels() {
    var out = []
    for (var i = 0; i < scalingOptions.length; i++) out.push(scalingOptions[i].label)
    return out
  }

  function scalingLabelFor(key) {
    for (var i = 0; i < scalingOptions.length; i++)
      if (scalingOptions[i].key === key) return scalingOptions[i].label
    return "Zoom"
  }

  function scalingKeyFor(label) {
    for (var i = 0; i < scalingOptions.length; i++)
      if (scalingOptions[i].label === label) return scalingOptions[i].key
    return "zoom"
  }

  function displayTabs() {
    var out = []
    for (var i = 0; i < displays.length; i++)
      out.push(String(displays[i]))
    return out
  }

  function displayTabLabels() {
    return displayTabs()
  }

  function tabLabelToDisplay(label) {
    return String(label)
  }

  // Which group of settings is on show.
  property string tab: "displays"

  function tabLabel() {
    if (tab === "shuffling") return "Shuffling"
    return "Displays"
  }

  function editingTabLabel() {
    var tabs = displayTabs()
    return editing !== "" && tabs.indexOf(editing) !== -1 ? editing : (tabs.length ? tabs[0] : "")
  }

  // ------------------------------------------------------------- the picker

  property var pickerImages: []

  // Listed by the widget rather than taken from the service's pool: the pool
  // holds only what the *service* is configured to use, and the picker has to
  // show the folder being edited, which may be a different display's.
  function loadPicker() {
    var folder = safePath(current.folder)
    if (folder === "" || pickerProc.running) { pickerImages = []; return }
    pickerProc.command = ["bash", "-c",
      "timeout --kill-after=1s 15s find -P " + Util.shellQuote(folder) +
      " -xdev" + (current.recursive ? " -maxdepth 32" : " -maxdepth 1") +
      " -type f \\( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.gif'" +
      " -o -iname '*.mp4' -o -iname '*.webm' -o -iname '*.mkv' -o -iname '*.mov' -o -iname '*.avi'" +
      " -o -iname '*.bmp' -o -iname '*.webp' \\) -print0 2>/dev/null | LC_ALL=C grep -zav '[[:cntrl:]]'" +
      " | LC_ALL=C.UTF-8 grep -zavP '[\\\\x{80}-\\\\x{9f}]' | tr '\\\\0' '\\\\n' | head -n 10000 | sort -u"]
    pickerProc.running = true
  }

  // Keep picker input consistent with the service. Control characters would
  // corrupt the newline-delimited result returned by find.
  function safePath(path) {
    var value = String(path || "").trim()
    var homePath = Quickshell.env("HOME")
    if (value === "~") value = homePath
    else if (value.indexOf("~/") === 0) value = homePath + value.substring(1)
    if (value.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return ""
    return value
  }

  Process {
    id: pickerProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.pickerImages = String(text || "").split("\n").filter(function(p) { return p !== "" })
      }
    }
  }

  // The picker shows the folder of whichever display is being edited, so it
  // has to reload when either changes -- not only when single mode is chosen.
  // Guarded: both fire while the component is still being built, before the
  // `current` binding has produced anything to read.
  onEditingChanged: if (current && current.mode === "single") loadPicker()
  onDisplayConfigChanged: if (current && current.mode === "single") loadPicker()

  // Read the outputs directly from Quickshell. The service also reports them
  // in its status payload, but waiting for that IPC response made the panel
  // show only the shared configuration while the service was still starting.
  readonly property var displays: {
    var out = []
    var screens = Quickshell.screens || []
    for (var i = 0; i < screens.length; i++) {
      var name = String(screens[i] && screens[i].name || "")
      if (name !== "" && out.indexOf(name) === -1) out.push(name)
    }
    return out
  }

  readonly property color fg: bar ? bar.foreground : Color.foreground
  readonly property string fontFamily: Style.fontFamily

  property int poolSize: -1
  property var screenPicks: ({})
  property var nextPicks: ({})

  property int skipped: 0

  // PluginBarApi deliberately exposes a scoped PluginShellApi, not the host's
  // registry. Read the local manifest instead of traversing a private API that
  // is not present in the third-party plugin boundary.
  property string manifestVersion: ""
  readonly property string version: manifestVersion

  FileView {
    id: manifestFile
    path: String(Qt.resolvedUrl("manifest.json")).replace(/^file:\/\//, "")
    watchChanges: false
    printErrors: false
    onLoaded: {
      try {
        var data = JSON.parse(manifestFile.text())
        root.manifestVersion = data && data.version !== undefined ? String(data.version) : ""
      } catch (e) {
        root.manifestVersion = ""
      }
    }
    onLoadFailed: root.manifestVersion = ""
  }

  // Which display keys are in play. Before the service has reported its
  // outputs -- and whenever displays share one configuration -- that is the
  // single "all" entry.
  function displayKeysInUse() {
    if (!perDisplayConfig || !displays.length) return ["all"]
    var out = []
    for (var i = 0; i < displays.length; i++) out.push(String(displays[i]))
    return out
  }

  // Whether there is a next image to fetch at all. A display in single mode
  // keeps its pinned image, so with every display pinned -- or with no folder
  // set -- the button would do nothing and is hidden instead.
  readonly property bool canAdvance: {
    var keys = displayKeysInUse()
    for (var i = 0; i < keys.length; i++) {
      var c = configFor(keys[i])
      if (c.mode === "shuffle" && String(c.folder).trim() !== "") return true
    }
    return false
  }

  readonly property bool anyFolderSet: {
    var keys = displayKeysInUse()
    for (var i = 0; i < keys.length; i++)
      if (String(configFor(keys[i]).folder).trim() !== "") return true
    return false
  }

  // Sorted, because the service reports its outputs in whatever order
  // Quickshell hands them over and a card that reorders itself between
  // restarts is hard to read.
  readonly property var nextEntries: {
    var names = []
    for (var n in nextPicks) names.push(n)
    names.sort()
    var out = []
    for (var i = 0; i < names.length; i++) {
      var p = String(nextPicks[names[i]] || "")
      if (p === "") continue
      out.push({ screen: names[i], path: p, file: p.substring(p.lastIndexOf("/") + 1) })
    }
    return out
  }

      readonly property string previewTitle: "wallpaperOmarchyManager" + (version === "" ? "" : " v" + version)

  // Only when there is nothing to list; otherwise the images speak for
  // themselves.
  readonly property string previewNote: {
    if (!canAdvance)
      return anyFolderSet
        ? "Every display is pinned to one image."
        : "Using the default backgrounds."
    if (!nextEntries.length) return "No images to deal yet."
    return ""
  }

  readonly property string statusLine: {
    if (current.folder === "") return "No folder set — using the default backgrounds."
    if (poolSize < 0) return "Scanning…"
    if (poolSize === 0)
      return skipped > 0
        ? "No usable images — " + skipped + (skipped === 1 ? " file" : " files")
          + " could not be decoded."
        : "No images found in that folder."
    var line = poolSize + (poolSize === 1 ? " image" : " images") + " found."
    if (skipped > 0)
      line += " " + skipped + (skipped === 1 ? " image was" : " images were")
        + " skipped as undecodable; rescan to retry."
    return line
  }

  // ------------------------------------------------------------- persistence

  property var _saveQueue: []

  function persist(key, value) {
    _saveQueue = _saveQueue.concat([[key, value]])
    drainSaves()
  }

  function drainSaves() {
    if (saveProc.running || !_saveQueue.length) return
    var job = _saveQueue[0]
    _saveQueue = _saveQueue.slice(1)
    saveProc.command = ["omarchy-shell", "shell", "setBarWidget",
      root.moduleName, String(job[0]), JSON.stringify(job[1]), "{}"]
    saveProc.running = true
  }

  Process {
    id: saveProc
    onExited: function(code, status) {
      if (code !== 0) console.warn("wallpaperOmarchyManager: failed to save setting (exit " + code + ")")
      root.drainSaves()
      if (!root._saveQueue.length) refreshTimer.restart()
    }
  }

  // ------------------------------------------------------------------ status

  // quiet leaves poolSize alone: the hover refresh below runs behind an open
  // panel, and resetting it there would flash "Scanning…" over a count that
  // was already correct.
  function refreshStatus(quiet) {
    if (statusProc.running) return
    if (quiet !== true) root.poolSize = -1
    statusProc.running = true
  }

  // No -q here: the omarchy-shell wrapper's quiet mode suppresses stdout
  // entirely, so the reply would arrive as an empty string and parse into a
  // poolSize of 0 — the panel would report "no images found" for a folder
  // that had just scanned hundreds. Quiet mode is only right for the
  // fire-and-forget calls below, whose output nobody reads.
  Process {
    id: statusProc
    command: ["omarchy-shell", "background", "status"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var raw = String(text || "").trim()
        if (raw === "") return
        var data = null
        try { data = JSON.parse(raw) } catch (e) { return }
        if (!data || data.poolSize === undefined) return
        root.poolSize = Number(data.poolSize)
        root.skipped = Number(data.skipped || 0)
        root.screenPicks = data.screens || ({})
        root.nextPicks = data.next || ({})
      }
    }
  }

  // Settings land asynchronously (write -> shell.json -> service rescan), so
  // give the service a beat before asking it what it found.
  Timer {
    id: refreshTimer
    interval: 400
    repeat: false
    onTriggered: root.refreshStatus()
  }

  // ----------------------------------------------------------------- actions

  function browse() {
    if (browseProc.running) return
    // Choosing the dialog supersedes anything half-typed in the field.
    root.folderEdited = false

    // Close before launching so zenity can receive focus instead of opening
    // behind the panel's layer-shell surface.
    root.close()
    var cmd = ["zenity", "--file-selection", "--directory",
      "--title=Choose a wallpaper folder"]
    if (root.current.folder !== "") cmd.push("--filename=" + root.current.folder + "/")
    browseProc.command = cmd
    browseProc.running = true
  }

  Process {
    id: browseProc
    onExited: if (!root.opened) root.open()
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var err = String(text || "").trim()
      if (err !== "") console.warn("wallpaperOmarchyManager: zenity: " + err)
      }
    }
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var picked = String(text || "").trim()
        if (picked === "") return
        root.folderEdited = false
        root.persistDisplay("folder", picked)
      }
    }
  }

  // Quickshell.execDetached with an argv array, NOT Util.execDetached: that
  // helper takes a command *string* and wraps it in `bash -lc`, so an array
  // silently stringifies to "omarchy-shell,-q,background,next" and the button
  // does nothing.
  //
  // "next", not "shuffle": the pool is dealt from a queue that only reshuffles
  // once it empties, so this hands out the following image rather than
  // re-randomising what is left. It is a no-op when nothing shuffles.
  function nextImage() {
    Quickshell.execDetached(["omarchy-shell", "-q", "background", "next"])
    refreshTimer.restart()
  }

  function rescanNow() {
    Quickshell.execDetached(["omarchy-shell", "-q", "background", "rescan"])
    refreshTimer.restart()
  }

  // True only while the user has typed something not yet committed. Guards the
  // field's write-back so it can never resurrect a stale path.
  property bool folderEdited: false

  // The setting changes from more places than this field: the file dialog, the
  // CLI, or this same panel on another monitor. Mirror it back unless the user
  // is part-way through typing something else.
  // The folder can change from the file dialog, the CLI, or by switching to
  // another display's tab. Mirror it back unless the user is mid-edit.
  onCurrentChanged: if (!folderEdited && folderField) folderField.text = current.folder

  onOpenedChanged: if (opened) {
    folderEdited = false
    folderField.text = root.current.folder
    refreshStatus()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  // The bar is instantiated once per screen, so on a multi-monitor setup this
  // registers twice and Quickshell logs "another handler is registered for
  // target wallpapermanager". First one wins, the panel still opens, and the
  // stock omarchy.power / omarchy.dropbox widgets emit the same warning — it
  // is the house pattern, not a fault here.
  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
    function next(): string { root.nextImage(); return "ok" }
    function shuffle(): string { root.nextImage(); return "ok" }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰸉"
    // No tooltipText: the bar's tooltip is a single line of text, and the card
    // below shows the images instead.
    active: root.opened
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.MiddleButton) root.nextImage()
      else root.toggle()
    }
  }

  // ------------------------------------------------------------ hover preview
  //
  // A card of our own rather than the bar's tooltip, which takes text and
  // nothing else. Being our own popup also keeps it out of the bar's popout
  // coordinator, which closes whatever panel is open when a new one is
  // requested -- fine for a click, wrong for a pointer merely crossing an icon.
  property bool previewShown: false

  Timer {
    id: previewDelay
    interval: 400
    repeat: false
    onTriggered: root.previewShown = button.tooltipHovered && !root.opened
  }

  Connections {
    target: button
    function onTooltipHoveredChanged() {
      if (!button.tooltipHovered) {
        previewDelay.stop()
        root.previewShown = false
        return
      }
      // The images go stale as soon as anything shuffles; the reply lands well
      // inside the delay below.
      root.refreshStatus(true)
      previewDelay.restart()
    }
  }

  PopupWindow {
    id: preview

    readonly property var anchorWindow: button.QsWindow ? button.QsWindow.window : null
    readonly property int gap: Style.space(6)
    readonly property string barPosition: root.bar ? root.bar.position : "top"

    visible: root.previewShown && !!anchorWindow
    color: "transparent"
    implicitWidth: Math.ceil(previewCard.implicitWidth)
    implicitHeight: Math.ceil(previewCard.implicitHeight)

    // The placement the bar gives its own tooltip: off the bar's inner edge,
    // centred on the icon, slid back inside the screen rather than hanging
    // over an edge.
    anchor {
      id: previewAnchor
      window: preview.anchorWindow
      adjustment: PopupAdjustment.Slide
      edges: Edges.Top | Edges.Left
      gravity: Edges.Bottom | Edges.Right
      rect.width: 1
      rect.height: 1

      onAnchoring: {
        var window = preview.anchorWindow
        if (!window) return

        var w = preview.implicitWidth
        var h = preview.implicitHeight
        var localX = button.width / 2 - w / 2
        var localY = button.height + preview.gap

        if (preview.barPosition === "bottom") {
          localY = -h - preview.gap
        } else if (preview.barPosition === "left") {
          localX = button.width + preview.gap
          localY = button.height / 2 - h / 2
        } else if (preview.barPosition === "right") {
          localX = -w - preview.gap
          localY = button.height / 2 - h / 2
        }

        var point = window.contentItem.mapFromItem(button, localX, localY)
        if (preview.barPosition === "top" || preview.barPosition === "bottom")
          point.x = Math.max(preview.gap, Math.min(point.x, window.width - w - preview.gap))
        else
          point.y = Math.max(preview.gap, Math.min(point.y, window.height - h - preview.gap))

        previewAnchor.rect.x = Math.round(point.x)
        previewAnchor.rect.y = Math.round(point.y)
      }
    }

    BorderSurface {
      id: previewCard

      readonly property color text: Color.tooltip.text
      readonly property color dim: Qt.darker(Color.tooltip.text, 1.5)

      implicitWidth: previewColumn.width + contentLeftInset + contentRightInset
      implicitHeight: previewColumn.implicitHeight + contentTopInset + contentBottomInset
      padding: Style.space(10)
      color: Color.tooltip.background
      borderSpec: Border.surfaceSpec("tooltip", "border", Color.tooltip.border, 1)
      radius: Style.cornerRadius

      Column {
        id: previewColumn
        x: previewCard.contentLeftInset
        y: previewCard.contentTopInset
        width: Style.space(250)
        spacing: Style.space(8)

        Text {
          text: root.previewTitle
          color: previewCard.text
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          font.bold: true
        }

        Text {
          visible: root.previewNote !== ""
          width: parent.width
          text: root.previewNote
          color: previewCard.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }

        Text {
          visible: root.nextEntries.length > 0
          text: "Next Images"
          color: previewCard.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        Repeater {
          model: root.nextEntries

          Row {
            id: entry
            required property var modelData
            width: previewColumn.width
            spacing: Style.space(8)

            // Decoded at thumbnail size, not full resolution: a 4K wallpaper
            // decoded to fill 90 pixels would cost tens of megabytes to draw
            // something the size of a postage stamp.
            Rectangle {
              width: Style.space(90)
              height: Math.round(width * 9 / 16)
              color: "transparent"
              clip: true

              WallpaperRenderer {
                anchors.fill: parent
                sourcePath: entry.modelData.path
                fillModeName: "zoom"
              }
            }

            Column {
              width: previewColumn.width - Style.space(98)
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(2)

              Text {
                width: parent.width
                text: entry.modelData.screen
                textFormat: Text.PlainText
                color: previewCard.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                elide: Text.ElideRight
              }

              Text {
                width: parent.width
                text: entry.modelData.file
                textFormat: Text.PlainText
                color: previewCard.text
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                elide: Text.ElideMiddle
              }
            }
          }
        }

        Text {
          visible: root.canAdvance
          width: parent.width
          text: "middle click to change to next image"
          color: previewCard.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }
      }
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(400))
    // No cap. The cap is a maximum, not a scroll viewport, so content taller
    // than it spills past the panel's border rather than becoming reachable.
    // The stock
    // panels whose content is a fixed set of controls (clock, weather) also
    // pass no cap and let fittedContentHeight clamp to the screen instead;
    // the ones that do cap are those listing an unbounded number of devices.
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // Typing in the folder field must reach the field, not the panel's
      // single-key shortcuts.
      blocked: folderField.activeFocus
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "n" || t === "N") root.nextImage()
        else if (t === "r" || t === "R") root.rescanNow()
        else if (t === "b" || t === "B") root.browse()
      }

      Column {
        id: column
        width: parent.width
        spacing: Style.space(12)

        // Two groups of settings, one visible at a time. The panel outgrew a
        // single scroll of controls once displays could be configured
        // individually, and the cap on its height is a clamp rather than a
        // viewport -- content past it spills outside the border instead of
        // becoming reachable.
        ButtonGroup {
          width: parent.width
          options: ["Displays", "Shuffling"]
          value: root.tabLabel()
          foreground: root.fg
          fontFamily: root.fontFamily
          onChanged: function(v) { root.tab = String(v).toLowerCase() }
        }

        // ═══════════════════════════════════════════════════════ displays

        Column {
          visible: root.tab === "displays"
          width: parent.width
          spacing: Style.space(12)

          Toggle {
            width: parent.width
            label: "Configure each display separately"
            description: "Off: one configuration shared by every display."
            checked: root.perDisplayConfig
            foreground: root.fg
            fontFamily: root.fontFamily
            onClicked: root.setPerDisplayConfig(!root.perDisplayConfig)
          }

          ButtonGroup {
            visible: root.perDisplayConfig && root.displays.length > 0
            width: parent.width
            options: root.displayTabLabels()
            value: root.editingTabLabel()
            foreground: root.fg
            fontFamily: root.fontFamily
            onChanged: function(v) { root.editing = root.tabLabelToDisplay(v) }
          }

          Text {
            visible: !root.perDisplayConfig
            width: parent.width
            text: "All displays"
            color: Qt.darker(root.fg, 1.5)
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          PanelSectionHeader {
            text: "FOLDER"
            foreground: root.fg
            fontFamily: root.fontFamily
          }

          Row {
            width: parent.width
            spacing: Style.space(8)

            TextField {
              id: folderField
              width: parent.width - browseButton.implicitWidth - parent.spacing
              foreground: root.fg
              placeholderText: "~/Pictures/wallpapers"
              // Only a keystroke counts as an edit. Assigning text from the
              // setting must not arm the write-back.
              onTextChanged: if (activeFocus) root.folderEdited = true
              onAccepted: {
                root.folderEdited = false
                root.persistDisplay("folder", text.trim())
              }
              // editingFinished fires on any focus loss, including the panel
              // being dismissed because the file dialog took focus. Writing
              // back unconditionally there is what made Browse… look broken:
              // the field still held the old path and overwrote the one just
              // chosen.
              onEditingFinished: {
                if (!root.folderEdited) return
                root.folderEdited = false
                if (text.trim() !== root.current.folder) root.persistDisplay("folder", text.trim())
              }
            }

            Button {
              id: browseButton
              text: "Browse…"
              bordered: true
              foreground: root.fg
              fontFamily: root.fontFamily
              anchors.verticalCenter: parent.verticalCenter
              onClicked: root.browse()
            }
          }

          Text {
            width: parent.width
            text: root.statusLine
            color: Qt.darker(root.fg, 1.5)
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          Button {
            visible: root.current.folder !== ""
            text: "Clear folder (use default backgrounds)"
            bordered: true
            leftAlign: true
            width: parent.width
            foreground: root.fg
            fontFamily: root.fontFamily
            onClicked: root.clearFolder()
          }

          Toggle {
            width: parent.width
            label: "Search subfolders"
            description: "Include images nested below the chosen folder."
            checked: root.current.recursive
            foreground: root.fg
            fontFamily: root.fontFamily
            onClicked: root.persistDisplay("recursive", !root.current.recursive)
          }

          PanelSectionHeader {
            text: "MODE"
            foreground: root.fg
            fontFamily: root.fontFamily
          }

          ButtonGroup {
            width: parent.width
            options: ["Shuffle", "Single"]
            value: root.current.mode === "single" ? "Single" : "Shuffle"
            foreground: root.fg
            fontFamily: root.fontFamily
            onChanged: function(v) {
              var mode = String(v).toLowerCase()
              root.persistDisplay("mode", mode)
              if (mode === "single") root.loadPicker()
            }
          }

          // The picker. Thumbnails come straight off disk, and GridView only
          // instantiates the delegates in view, so a folder of hundreds costs
          // a screenful of decodes rather than hundreds.
          Rectangle {
            visible: root.current.mode === "single"
            width: parent.width
            height: Style.space(220)
            color: "transparent"
            border.width: Style.normalBorderWidth
            border.color: Qt.darker(root.fg, 2.0)

            GridView {
              id: picker
              anchors.fill: parent
              anchors.margins: Style.space(4)
              clip: true
              cellWidth: Math.floor((width - 1) / 3)
              cellHeight: Math.round(cellWidth * 9 / 16)
              model: root.pickerImages

              delegate: Item {
                required property var modelData
                width: picker.cellWidth
                height: picker.cellHeight

                WallpaperRenderer {
                  anchors.fill: parent
                  anchors.margins: Style.space(3)
                  sourcePath: modelData
                  fillModeName: "zoom"
                  clip: true

                  Rectangle {
                    anchors.fill: parent
                    color: "transparent"
                    border.width: Style.normalBorderWidth * 2
                    border.color: Color.accent
                    visible: root.current.pinned === modelData
                  }
                }

                MouseArea {
                  anchors.fill: parent
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.persistDisplay("pinned", String(modelData))
                }
              }
            }
          }

          Text {
            visible: root.current.mode === "single"
            width: parent.width
            text: root.current.pinned === ""
              ? "No image chosen yet."
              : root.current.pinned.substring(root.current.pinned.lastIndexOf("/") + 1)
            textFormat: Text.PlainText
            color: Qt.darker(root.fg, 1.5)
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideMiddle
          }

          PanelSectionHeader {
            text: "SCALING"
            foreground: root.fg
            fontFamily: root.fontFamily
          }

          ButtonGroup {
            width: parent.width
            options: root.scalingLabels()
            value: root.scalingLabelFor(root.current.scaling)
            foreground: root.fg
            fontFamily: root.fontFamily
            onChanged: function(v) { root.persistDisplay("scaling", root.scalingKeyFor(v)) }
          }
        }

        // ══════════════════════════════════════════════════════ shuffling

        Column {
          visible: root.tab === "shuffling"
          width: parent.width
          spacing: Style.space(12)

          NumberField {
            label: "Auto-shuffle every (seconds, 0 = off)"
            value: root.intervalSec
            from: 0
            to: 86400
            stepSize: 60
            foreground: root.fg
            fontFamily: root.fontFamily
            onModified: function(v) { root.persist("intervalSec", v) }
          }

          Toggle {
            width: parent.width
            label: "Shuffle on unlock or wake"
            description: "Change wallpaper on unlock or screensaver exit rather than on a timer."
            checked: root.shuffleOnWake
            foreground: root.fg
            fontFamily: root.fontFamily
            onClicked: root.persist("shuffleOnWake", !root.shuffleOnWake)
          }

          Toggle {
            // With each display configured separately this has no meaning:
            // every display already draws from its own folder.
            visible: !root.perDisplayConfig
            width: parent.width
            label: "Different image per display"
            description: "Off mirrors one image across every display."
            checked: root.perDisplay
            foreground: root.fg
            fontFamily: root.fontFamily
            onClicked: root.persist("perDisplay", !root.perDisplay)
          }

          Text {
            width: parent.width
            text: "Displays set to Single keep their image and are left alone."
            color: Qt.darker(root.fg, 1.6)
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }
        }

        // ════════════════════════════════════════════ always visible

        PanelSeparator {}

        Row {
          width: parent.width
          spacing: Style.space(8)

          // Hidden rather than disabled when every display is pinned: there is
          // no next image to fetch, and a greyed button invites a click that
          // was never going to do anything.
          Button {
            visible: root.canAdvance
            text: "Next image"
            bordered: true
            foreground: root.fg
            fontFamily: root.fontFamily
            onClicked: root.nextImage()
          }

          Button {
            text: "Rescan"
            bordered: true
            foreground: root.fg
            fontFamily: root.fontFamily
            onClicked: root.rescanNow()
          }

        }

        Column {
          width: parent.width
          spacing: Style.space(2)

          Repeater {
            model: {
              var out = []
              for (var name in root.screenPicks) {
                var p = String(root.screenPicks[name] || "")
                out.push({ screen: name, file: p.substring(p.lastIndexOf("/") + 1) })
              }
              return out
            }
            Text {
              required property var modelData
              width: column.width
              text: modelData.screen + "  ·  " + modelData.file
              textFormat: Text.PlainText
              color: Qt.darker(root.fg, 1.6)
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideMiddle
            }
          }
        }
      }
    }
  }
}
