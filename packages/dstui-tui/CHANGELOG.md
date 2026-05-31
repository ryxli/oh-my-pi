# Changelog

All notable changes to this package are documented here.

## [Unreleased]

### Added

- New package: `@oh-my-pi/pi-dstui-tui`. Adapts a `ComponentInstance`
  from `@oh-my-pi/pi-dstui` into a focusable `@oh-my-pi/pi-tui`
  `Component`, with a helper that mounts a DSL module inside an
  `ExtensionUIContext.custom(...)` factory and resolves the settle
  event back to the host. Chunk 2 of #1564.
- Bundled DSL components: `picker`, `confirm`, `progress`. Sources are
  baked into the package and exposed via `BUNDLED_DSTUI_SOURCES`,
  `getBundledSource(name)`, and convenience `mountPicker` /
  `mountConfirm` / `mountProgress` helpers. Chunk 5 of #1564.
