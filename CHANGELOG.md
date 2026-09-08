# Changelog

## [1.2.4](https://github.com/guiestrela/wallpaper-omarchy-manager/compare/v1.2.3...v1.2.4) (2026-09-08)

### Bug Fixes

* read service settings through Omarchy's scoped public bar configuration
* ignore wallpaper filenames containing control characters during scans

### Security

* keep service configuration access within the third-party plugin boundary
* reject C1 control characters as well as ASCII controls in user paths

## [1.2.3](https://github.com/guiestrela/wallpaper-omarchy-manager/compare/v1.2.2...v1.2.3) (2026-08-31)

### Bug Fixes

* sanitize path inputs and update documentation ([e21777e](https://github.com/guiestrela/wallpaper-omarchy-manager/commit/e21777e6e81cfcba3c330d0c540513be1196a8a9))

## [1.2.2](https://github.com/guiestrela/wallpaper-omarchy-manager/compare/v1.2.1...v1.2.2) (2026-08-28)


### Bug Fixes

* **bar:** force plain text format for file labels ([23afcca](https://github.com/guiestrela/wallpaper-omarchy-manager/commit/23afccab28c903c277498239baaf2275f5fd2d05))

### Security

* reject control-character and overlong wallpaper paths before scanning
* document the plugin's theme, font, technology, and sandbox limitations

## [1.2.1](https://github.com/guiestrela/wallpaper-omarchy-manager/compare/v1.2.0...v1.2.1) (2026-08-28)


### Bug Fixes

* sanitize path inputs and limit folder scans ([08f2d67](https://github.com/guiestrela/wallpaper-omarchy-manager/commit/08f2d6796f06512c74b98d013b98eb50b1a234fe))

## [1.2.0](https://github.com/guiestrela/wallpaper-omarchy-manager/compare/v1.1.1...v1.2.0) (2026-08-28)


### Features

* prevent recent images from repeating ([5676073](https://github.com/guiestrela/wallpaper-omarchy-manager/commit/567607384446ec8731c9c83962efa8fb204d2252))


### Bug Fixes

* enhance file scanning and image decoding ([c76a99b](https://github.com/guiestrela/wallpaper-omarchy-manager/commit/c76a99b4f5db0b5244e644ad3b02c9350d357ccc))
* improve image decoding for large wallpapers in AnimatedImage component ([40da0ad](https://github.com/guiestrela/wallpaper-omarchy-manager/commit/40da0ad4d5c532023dc09eccb2e9ca0aa05dcaa3))
* optimize wallpaper rendering with persistent buffers for smoother transitions ([4573fa3](https://github.com/guiestrela/wallpaper-omarchy-manager/commit/4573fa3f3c904b096ac945420a090afc6b20e8bc))
* restore marketplace plugin id ([82777a6](https://github.com/guiestrela/wallpaper-omarchy-manager/commit/82777a6b06d4b2a951c20f2b53b82fc7f2462029))

## [1.1.1](https://github.com/guiestrela/wallpaper-omarchy-manager/compare/v1.1.0...v1.1.1) (2026-08-26)


### Bug Fixes

* update version to 1.1.0 and improve README clarity ([e82908b](https://github.com/guiestrela/wallpaper-omarchy-manager/commit/e82908bc1977ac16e1cedc49470f703420f34289))

## [1.1.0](https://github.com/guiestrela/wallpaper-omarchy-manager/compare/v1.0.2...v1.1.0) (2026-08-26)


### Features

* add support for video wallpapers and update changelog ([a77b383](https://github.com/guiestrela/wallpaper-omarchy-manager/commit/a77b38383c23e268045313d553d3f22fb3381bc4))
* enhance video wallpaper support and adjust playing state management ([b8a1c4d](https://github.com/guiestrela/wallpaper-omarchy-manager/commit/b8a1c4dcbf3b37ac901bd726a3314ad3f70be926))
* standardize plugin ID and update version to 1.1.0 ([12b46d0](https://github.com/guiestrela/wallpaper-omarchy-manager/commit/12b46d03789bfd261cc1a21e831a38c8234ac027))
* support animated wallpapers ([e964f78](https://github.com/guiestrela/wallpaper-omarchy-manager/commit/e964f784c0b2ec732f147c821ac02aa29280baf1))


### Bug Fixes

* remove infinite loops from animated images in Background and BarWidget ([577a773](https://github.com/guiestrela/wallpaper-omarchy-manager/commit/577a7730c18b1d8553de00e4055f89d5a5034fab))
* support video wallpapers and reduce playback overhead ([f52e755](https://github.com/guiestrela/wallpaper-omarchy-manager/commit/f52e755704be6211f8238d7e53232d555f4f6e92))

## [1.1.0] (2026-08-26)

### Changes

* standardize the plugin ID as `io.github.guiestrela.wallpaperomarchymanager`

## [1.0.4] (2026-08-26)

### Features

* support MP4 and other common video wallpapers with Qt Multimedia

## [1.0.3] (2026-08-26)

### Features

* support animated GIF wallpapers in the desktop and wallpaper previews

## [1.0.2](https://github.com/guiestrela/wallpaper-omarchy-manager/compare/v1.0.1...v1.0.2) (2026-08-20)


### Bug Fixes

* lowercase plugin ID for consistency ([8af2426](https://github.com/guiestrela/wallpaper-omarchy-manager/commit/8af2426781280298a4031901db785e462c34b5fc))

## Changelog
