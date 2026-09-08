# wallpaperOmarchyManager

Current version: **1.2.4**

Wallpaper manager for [Omarchy](https://omarchy.org) Quattro. Every
display gets its own image, its own settings if you want them, and your whole
setup can mix independent folders and shuffle controls per display.

This project is a fork of [Omawall](https://github.com/matjam/omawall),
adapted and maintained as wallpaperOmarchyManager.

Version 1.2.0 improves the shuffle queue so recently displayed images are kept
out of the next picks when possible, and makes recursive scanning and decoding
more robust for large or unsupported files.

> **Rewritten by Codex**, OpenAI's coding agent. Tested on real hardware, but
> tested isn't proven — and Omarchy plugins run unsandboxed inside your shell
> process, with your permissions. Read the source first. No promises about
> your cat.

![wallpaperOmarchyManager](preview.png)

## Features

- **Per-display configuration** — each screen gets its own folder, mode and
  scaling, or share one configuration across all of them.
- **Shuffle or pin** — rotate a folder, or hold one image chosen from a
  thumbnail grid. Mix the two across screens.
- **Four scaling modes** — zoom, fit height, fit width, or actual size.
- **Every image before any repeat** — picks come off a shuffled queue that only
  reshuffles when it empties. Recently displayed images are also kept away from
  the start of a new queue when the folder is large enough.
- **Shuffle** on a timer, on unlock and screensaver exit, or by hand.
- **Recursive scan** of `.jpg` `.jpeg` `.png` `.gif` `.bmp` `.webp` `.mp4`
  `.webm` `.mkv` `.mov` `.avi`; animated media plays as wallpapers
  automatically.
- **Skips files it can't decode** and re-deals that display.
- **Bar widget** for all of it. Middle-click the icon for the next image;
  hover it to see thumbnails of what each display is about to get.

For responsiveness, recursive scans stay on the selected filesystem, descend
at most 32 levels, stop after 10,000 entries, and time out after 15 seconds.
Pinned wallpapers must be inside the configured folder.

### Animated wallpapers

Place animated `.gif` or video files (`.mp4`, `.webm`, `.mkv`, `.mov`, `.avi`)
in any configured folder. They are discovered and played automatically in both
**Shuffle** and **Single** modes, alongside static wallpapers. Videos use Qt
Multimedia and loop silently. The same scaling options and per-display
configuration are used for both types.

With no folder set it behaves like the built-in background service, so you can
install it and decide later.

## Install, update and remove

Install the plugin directly from GitHub and enable it:

```bash
omarchy plugin add https://github.com/guiestrela/wallpaper-omarchy-manager.git --enable
```

When prompted, place the widget in the `right` section of the bar. Enabling
this plugin disables the built-in `omarchy.background` service so the two
services do not compete for control of the wallpaper.

To update an existing installation, run:

```bash
omarchy plugin update io.github.guiestrela.wallpaperomarchymanager
```

To remove the plugin, run:

```bash
omarchy plugin remove io.github.guiestrela.wallpaperomarchymanager
```

Removing it restores the built-in `omarchy.background` service.

## Settings

Click the wallpaper icon in the bar. Two tabs: **Displays** and
**Shuffling**. Actions and what's on each screen stay visible below them.

**Displays** — per display, or shared by all of them:

| Setting | Default | Does |
| --- | --- | --- |
| Configure each display separately | off | On: a tab per display. Off: one shared configuration. |
| Folder | _empty_ | Where images come from. Empty = current theme backgrounds. Paths may use `~`. |
| Search subfolders | on | Scan recursively. |
| Mode | Shuffle | **Single** pins one image, chosen from a thumbnail grid. |
| Scaling | Zoom | Zoom, Fit ↕, Fit ↔, or Actual. |

**Shuffling** — global:

| Setting | Default | Does |
| --- | --- | --- |
| Auto-shuffle every | `0` | Seconds. `0` is off. |
| Shuffle on unlock or wake | off | Shuffle on unlock or screensaver exit instead. |
| Different image per display | on | Off mirrors one image across displays sharing a folder. |

### Mixing displays

Set one display to **Single** and another to **Shuffle** and you get exactly
that: the pinned one never moves while the other rotates. Displays pointed at
the same folder share a pool and a deal queue, so they never show the same
image at once and still see every image before repeating; displays on
different folders rotate independently.

The four scaling modes only differ when the image and the screen disagree
about shape. A 3440×1440 wallpaper on a 3440×1440 screen looks identical under
Zoom, Fit ↕ and Actual, because it is.

### Next image

The pool is dealt from a shuffled queue that only reshuffles once it empties,
so there is always a next image waiting rather than a fresh roll of the dice.
**Next image** hands it out — to every display set to Shuffle, leaving the
pinned ones alone. With every display pinned there is no next image and the
button is not shown.

Middle-click the bar icon for the same thing. Hovering it shows a thumbnail of
what each display is about to get.

Keys while the panel is open: `n` next image · `r` rescan · `b` browse

```bash
omarchy-shell background next           # next image (shuffle is an alias)
omarchy-shell background rescan         # re-read the folder
omarchy-shell background status         # JSON state

# hyprland bind
bind = SUPER SHIFT, W, exec, omarchy-shell -q background next
```

## Requirements

Omarchy Quattro · `zenity` for the Browse button · Qt Multimedia for video
playback. Animated GIF playback uses Qt Quick's built-in `AnimatedImage`
support.

The runtime does not use the network. Settings are stored through Omarchy in
`~/.config/omarchy`; the service also updates Omarchy's current-wallpaper link
at `~/.local/state/omarchy/current/background` so the lock screen can use it.

## Theme and fonts

The plugin keeps Omarchy's theme behavior intact. In folder mode, changing the
theme keeps the selected wallpaper but immediately applies the theme's color
payload to the bar and settings panel. In the default mode, the normal
Omarchy background transition is preserved.

Text uses Quickshell's `Style.fontFamily` and themed size tokens, so the widget
automatically follows the active Omarchy font and its accessibility sizing.
It does not bundle, download, or install fonts.

## Technology

The plugin is built with QML for Quickshell and uses Qt Quick for the UI and
transitions, Qt Multimedia for video playback, and Omarchy's shell/IPC
interfaces for settings, theme changes, status, and the current-wallpaper
link. File discovery is performed by a bounded local `find` process; no
network service or background updater is included.

## Security notes

Omarchy plugins run in the user's shell process and are not sandboxed. Only
choose wallpaper folders containing files you trust: Qt Multimedia and the
image decoders process the selected media. The plugin does not execute files
from wallpaper folders, follow symlinks during scans, request elevated
permissions, or use the network.

Folder paths are shell-quoted before scanning, control characters and paths
over 4096 characters are rejected, scans stay on the selected filesystem, do
not follow symlinks, descend at most 32 levels, stop after 10,000 entries, and
time out after 15 seconds. These limits reduce accidental resource exhaustion;
they do not turn an Omarchy plugin into a sandbox.

## Credits

Extends Omarchy's built-in `omarchy.background`
([basecamp/omarchy](https://github.com/basecamp/omarchy), MIT).

MIT — see [LICENSE](LICENSE).
