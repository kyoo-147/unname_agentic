# Native shell preview

The user rejected the first egui UI and requested the original Quiet.md native shell, with custom Windows titlebar controls. The current scope is UI only. PDF, OCR, capture, and translation expansion are paused while the shell is corrected.

## Source and ownership

The source is copied from https://github.com/s1dashu/quiet-md into native-shell. The upstream MIT license is retained. Home, sidebar, theme tokens, native controls, and layout builders are reused rather than reconstructed with default widgets.

The application is temporarily titled Documents. It uses a separate application ID and a separate library under LocalAppData/PdfWorkspace. It must not read or alter the user's Quiet.md library. Upstream updater requests and global quick-note registration are disabled for this preview.

## Assets

The upstream branding and commercial Nucleo icons are not embedded in the preview binary. scripts/safe-shell-icons.mjs generates replacement Lucide SVGs into native-shell/assets-safe/icons. Their source is the installed lucide 0.468.0 package. The original commercial files remain in the copied source for provenance only and are not a distributable asset set.

The build collector skips assets/icons and assets/branding and embeds the safe aliases instead. Windows resources use Documents and no upstream app icon.

## UI acceptance

- The native window has no default Windows titlebar.
- Custom minimize, maximize or restore, and close controls occupy the GPUI chrome band.
- Drag and double-click behavior use native hit testing. Search, menus, and buttons are non-drag areas.
- Home, sidebar, search, tabs, cards, sort controls, and Settings follow the provided Quiet.md reference.
- A UI preview must not imply that PDF import or translation is connected when it is not.
- A real screenshot of this executable, not the browser or another window, is required before visual acceptance.

The local Claude and Drylab reference projects were inspected for shell density and surface treatment. Their browser reconstruction screenshots are not evidence of native window behavior. The original Quiet.md implementation remains the primary shell reference.
