# Design tokens — lean GPUI PDF workspace

Status: design contract for the lean shell. This document owns the visual identity only; it does not change Rust, Cargo, or application code.

The shell is a reading instrument. Surfaces are paper, text is ink, one accent marks action. Nothing floats unless it is a menu or a dialog; nothing blurs; nothing glows. PDF pixels are the only uncontrolled colour in the window, so the chrome stays quiet around them.

## 0. Frame invariants

The approved frame is kept, with the lean target measurements:

| Part | Measurement | Rule |
| --- | --- | --- |
| Sidebar | 252 px wide; 232–320 px resizable in 8 px steps | Sits directly on the window/sidebar surface. No panel, border, or shadow. The copied reference shell uses 280 px; the lean target is 252 px. |
| Top band | 48 px high | Search centred; custom window buttons right-aligned. |
| Content | Full-bleed plane, 24 px gutter | No outer card, no floating content panel, no gutter shadow. |
| Window buttons | 32 × 32 px; 7 px horizontal margin each side; 1 × 18 px divider with 12 px margins; group 163 px | Native hit-testing. Close hover is a colour change, never a red fill. |
| Search | 280 × 32 px | 8 px radius, 1 px border, 2 px focus ring. |

The outer window uses the OS corner treatment. Do not round or draw a frame around the native window.

## 1. Token contract

- Colour tokens are semantic. Use `surface.window`, not `sage_100` or `cream`. In Rust, the canonical path converts to snake_case: `surface.window` → `surface_window`.
- Every colour token is an opaque 6-digit sRGB hex value. Alpha exists only in shadows.
- No literal hex at a call site. The only exception is the user's custom-accent input, which is normalised by the rules in §4.
- Theme mode switches are instant. Never cross-fade the whole token set.
- Preset changes replace surfaces and accent together. Status colours do not change between presets.
- The status trio is shared by every preset; only surfaces, text, border, and accent vary.
- Do not add intermediate colours, tints, gradients, or opacity values to solve a local problem. Add a measured semantic token or use an existing one.

### 1.1 Surfaces

| Token | Role | Rules |
| --- | --- | --- |
| `surface.window` | Outer chrome, top band, window frame | Darker than content. No shadow. |
| `surface.sidebar` | Sidebar plane | Sits inside the window. No border, no shadow. |
| `surface.content` | Home, library, and reader surround | Never the PDF page itself. Full-bleed; 24 px gutter. |
| `surface.card` | Cards, menus, popovers, dialogs, search field | The lightest surface. Cards are drawn, not elevated. |
| `surface.hover` | Hover fill for rows, buttons, cards | Background colour only. Never raises elevation. |
| `surface.selected` | Selected row, active tab, pressed row | Must be paired with the accent rail/underline and 500-weight text. Fill alone is not the state cue. |
| `surface.inverse` | Dark HUD, PDF overlay chips, tooltips, toasts | Mode-invariant dark surface. `text.inverse` only. |

Hard rules:

- `surface.content` is not pure white in any light preset; `surface.card` is the white plane. This keeps cards distinct without shadows.
- The PDF page is always rendered by PDFium on `#FFFFFF` with the document's own colours. Do not tint, invert, dim, or apply a theme colour to PDF pixels in either mode. `surface.content` is only the surround.
- Sidebar and content have no outer border and no shadow. The top band's bottom hairline is `border.divider`.

### 1.2 Borders

| Token | Role | Rules |
| --- | --- | --- |
| `border.default` | Control boundary, input, card, menu, dialog, window-control divider | 1 px. This is the only border allowed to carry component meaning. Every preset is ≥ 3:1 against card, content, hover, and selected. |
| `border.divider` | Decorative section rules, chrome hairline, table hairlines | 1 px. 1.27–1.35:1 by design. Never the only boundary of a control, card, or state. |

- Focus is not a border token: 2 px `accent.solid` ring, 2 px offset.
- A 2 px decorative outline is not allowed. Exception: the 2 px focus ring.
- Status colours may be used as a 1 px outline or a 3 px rail for status. Never as a large fill.

### 1.3 Text

| Token | Role | Rules |
| --- | --- | --- |
| `text.primary` | Titles, body, selected-row labels, values | 12.66–14.63:1 minimum on light surfaces; 10.55–11.72:1 on dark surfaces. |
| `text.secondary` | Labels, secondary metadata, icons paired with labels | Still AA body text. Minimum 6.43:1. |
| `text.muted` | Timestamps, counts, helper text, placeholders | Still AA body text. Minimum 4.63:1. It is muted by chroma, not by losing contrast. |
| `text.inverse` | Text and icons on `surface.inverse` | Minimum 12.54:1. Never used on a light surface. |

- No alpha text. No text shadows.
- Placeholders use `text.muted`, not a lighter grey.
- Disabled controls are the only exempt case; do not use a disabled colour for information the user needs.
- All-caps is allowed only at `type.micro`, with 0.02em tracking.

### 1.4 Accent

| Token | Role | Rules |
| --- | --- | --- |
| `accent.solid` | Primary button fill, active tab underline, selected rail, focus ring, links | Every preset is ≥ 4.89:1 against every surface and ≥ 3:1 against `accent.subtle`. |
| `accent.hover` | Hover for accent fills and links | Darker in light mode, lighter in dark mode. Always ≥ 7.37:1 with `accent.on`. |
| `accent.subtle` | Active filter chip, tinted badge, selected badge background | Text on it is `text.primary` or `text.muted`, never `accent.on`. |
| `accent.on` | Text/icons on `accent.solid` and `accent.hover` | Never on `accent.subtle`. Minimum 6.03:1 on solid and 7.37:1 on hover. |

- One accent only. Do not introduce a secondary accent, a gradient accent, or a tinted status that reads as an accent.
- `accent.on` may be white (light presets) or a dark ink (dark presets). Follow the mode rule, not the apparent brightness of the swatch.
- Accent text links are 13 px or larger and use `accent.solid`; on hover use `accent.hover`. Accent text is placed on `surface.content` or `surface.card`. In a selected row, use `text.primary` and reserve accent for the rail and icon.
- Focus ring: 2 px `accent.solid`, 2 px offset. No glow, no blur, no shadow.

### 1.5 Status

Status colours are identical across all five presets, in both modes, so the meaning never changes when the user changes theme.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `status.danger` | `#A62A22` | `#F28B82` | Errors, destructive labels, disconnected state, close hover icon |
| `status.warning` | `#7A5200` | `#E8B96B` | Warning labels, rate limits, credentials missing |
| `status.success` | `#2E6B45` | `#7FD1A1` | Connected, complete, saved, checkmarks |

- Status colours are foreground only: text, icons, 3 px rails, 1 px outlines. Never a large fill behind text.
- A destructive button is `surface.card` + 1 px `border.default` + `status.danger` label/icon. Do not paint a red fill; the system has no measured `on-danger` colour.
- Warning is never used as a fill or a badge background. The amber foreground passes; a white-on-amber fill does not.
- Status is never the only signal: pair the icon/colour with a text label.

### 1.6 Radii

| Token | Value | Use |
| --- | --- | --- |
| `radius.xs` | 4 px | Checkbox, 16 px colour swatch, tiny badge |
| `radius.sm` | 8 px | Button, input, sidebar row, window button, tooltip, tab |
| `radius.md` | 12 px | Card, menu, popover, thumbnail |
| `radius.lg` | 20 px | Dialog, empty-state panel, large sheet |
| `radius.full` | 9999 px | Pill, avatar, circular icon button |

No 6, 10, 14, or 16 px radii. The native window itself is not a rounded token.

### 1.7 Spacing

| Token | Value | Use |
| --- | --- | --- |
| `space.0` | 0 px | Flush edges, full-bleed planes |
| `space.1` | 4 px | Badge inner padding, icon optical offset |
| `space.2` | 8 px | Row padding, button padding, icon-to-label gap |
| `space.3` | 12 px | Card padding, form gap, menu padding |
| `space.4` | 16 px | Grid gap, section inner gap |
| `space.5` | 20 px | Comfortable control cluster |
| `space.6` | 24 px | Content gutter, dialog padding |
| `space.8` | 32 px | Section gap, empty-state block |
| `space.10` | 40 px | Large empty-state vertical rhythm |
| `space.12` | 48 px | Hero/top-of-page spacing |
| `space.16` | 64 px | Maximum page-level spacing |

- Use only this scale for spacing. Do not use 5, 10, 14, 18, 28, or 36 px as spacing values.
- The only non-scale spacing value is `layout.window-control-margin: 7 px`, inherited from the approved frame. Layout dimensions such as the 252 px sidebar are not spacing tokens.

### 1.8 Typography

System fonts only. No font files are shipped, and no upstream Quiet.md font may be used.

| Token | Windows | macOS | Linux |
| --- | --- | --- | --- |
| `type.family.ui` | Segoe UI Variable Text, Segoe UI | SF Pro Text, Helvetica Neue | Noto Sans |
| `type.family.display` | Segoe UI Variable Display, Segoe UI | SF Pro Display, Helvetica Neue | Noto Sans |
| `type.family.mono` | Cascadia Mono, Consolas | SF Mono, Menlo | Noto Sans Mono |

Use the first installed family in each list. The PDF document's own fonts are never replaced.

| Token | Size / line height | Weight | Use |
| --- | --- | --- | --- |
| `type.display` | 28 / 34 px | 600 | Home greeting only; maximum two lines |
| `type.title` | 20 / 26 px | 600 | Page title, settings section title, dialog title |
| `type.heading` | 16 / 22 px | 600 | Card title, menu group title |
| `type.body` | 14 / 20 px | 400 | Default UI text, empty-state body |
| `type.body-strong` | 14 / 20 px | 500 | Selected row label, emphasized inline value |
| `type.label` | 13 / 18 px | 500 | Sidebar row, button label, input label |
| `type.caption` | 12 / 16 px | 400 | Metadata, file count, page number, helper text |
| `type.micro` | 11 / 15 px | 500 | Badge, shortcut hint; all-caps only, 0.02em tracking |
| `type.mono` | 12 / 18 px | 400 | File path, page range, technical value |

- Allowed weights: 400 Regular, 500 Medium, 600 Semibold, 700 Bold. 700 is used only for an empty-state count at 20 px or larger; never for chrome, labels, or body.
- Never use 300, 800, or 900. Never use a text size below 11 px.
- Line heights are exact pixels, not multipliers. Use only the pairs above; do not introduce 17 or 19 px line heights.
- Use tabular numerals for counts, page numbers, and file sizes.
- Letter spacing is 0 except `type.micro` all-caps at 0.02em. No negative tracking in the shell.
- Truncate card titles to one line with an ellipsis. Do not shrink type to fit.

### 1.9 Shadows

Shadows are mode-specific and preset-independent. They are the only place alpha is allowed. There are no card shadows, no button shadows, no sidebar shadows, and no inner shadows.

| Token | Light | Dark |
| --- | --- | --- |
| `shadow.0` | none | none |
| `shadow.1` | `0 1px 2px rgba(16,22,17,0.06), 0 4px 12px rgba(16,22,17,0.10)` | `0 1px 2px rgba(0,0,0,0.28), 0 4px 12px rgba(0,0,0,0.36)` |
| `shadow.2` | `0 2px 6px rgba(16,22,17,0.08), 0 16px 40px rgba(16,22,17,0.16)` | `0 2px 6px rgba(0,0,0,0.32), 0 16px 40px rgba(0,0,0,0.48)` |

- `shadow.1`: menus, popovers, tooltips, search suggestions.
- `shadow.2`: modal dialogs, destructive confirmations.
- In dark mode, a floating surface also carries a 1 px `border.default`; the shadow alone is not enough separation.
- No spread radius, no inset shadow. No backdrop blur or acrylic anywhere; the window is opaque. This keeps every measured contrast ratio valid against a known surface.

### 1.10 Motion

| Token | Duration | Use |
| --- | --- | --- |
| `motion.none` | 0 ms | Theme/preset switch, route/page change, sidebar collapse, resize, sort/filter, PDF page change, Aurora gradient. Mandatory for all of these. |
| `motion.press` | 60 ms | Background-colour change on press only |
| `motion.hover` | 90 ms | Background-colour, border-colour, or text-colour change |
| `motion.overlay` | 140 ms | Opacity only; menu, popover, tooltip |
| `motion.dialog` | 180 ms | Opacity only; dialog shell |
| `motion.spin` | 900 ms linear, infinite | Indeterminate progress only. Static "Working…" under reduced motion. |

- Standard easing: `cubic-bezier(0.2, 0, 0, 1)`. No spring, bounce, or overshoot.
- Never animate transform, size, position, box-shadow, or background gradient. No slide-in, scale-in, stagger, skeleton shimmer, parallax, cursor-following glow, or animated gradient.
- Reduced motion: every duration is 0 ms, including the spinner. No exceptions.
- The PDF page never animates.

### 1.11 Layout and component constants

| Token | Value | Use |
| --- | --- | --- |
| `layout.sidebar-width` | 252 px | Default; persists per user |
| `layout.sidebar-min` | 232 px | Resize floor |
| `layout.sidebar-max` | 320 px | Resize ceiling |
| `layout.sidebar-resize-step` | 8 px | Keyboard/pointer resize increment |
| `layout.chrome-height` | 48 px | Top band and window buttons |
| `layout.window-control` | 32 px | Window button square |
| `layout.window-control-margin` | 7 px | Horizontal margin each side of each button |
| `layout.window-controls-width` | 163 px | Divider + margins + three buttons |
| `layout.search-width` | 280 px | Top-band search |
| `layout.search-height` | 32 px | Top-band search |
| `layout.content-gutter` | 24 px | Content plane inset |
| `layout.library-gap` | 16 px | Grid/list gap |
| `layout.row-height` | 32 px | Sidebar row, menu row, tab |
| `layout.control-height` | 32 px | Button, input, select |
| `layout.hit-target-min` | 24 px | WCAG 2.2 minimum; actual controls are 32 px |
| `layout.hairline` | 1 px | Border/divider |
| `layout.icon-sm` | 16 px | Sidebar row, menu row |
| `layout.icon-md` | 18 px | Top band, window controls, toolbar |
| `layout.icon-lg` | 20 px | Empty state, large action |
| `layout.icon-xl` | 24 px | Card placeholder, dialog illustration |
| `layout.icon-stroke` | 1.7 | SVG stroke width at 24×24 viewBox |

Component rules:

- **Sidebar row:** 32 px high, 8 px horizontal padding, 8 px icon-to-label gap, 16 px icon, 8 px radius. Default `text.secondary`; hover `surface.hover`; selected `surface.selected` + 3 px `accent.solid` rail + `text.primary` at 500 + icon `accent.solid`.
- **Top band:** `surface.window`, 1 px `border.divider` at the bottom. Search is `surface.card` with 1 px `border.default`; placeholder `text.muted`; focus ring 2 px `accent.solid`. Window buttons: icon 18 px, default `text.secondary`; hover `surface.hover`; close hover uses `status.danger` icon on `surface.hover`, not a red fill.
- **Cards:** `surface.card`, 1 px `border.default`, 12 px radius, 12 px padding, no shadow. Hover `surface.hover`, no movement. Selected uses `surface.selected` plus the accent rail.
- **Menus/popovers:** `surface.card`, 1 px `border.default`, 12 px radius, `shadow.1`, 6 px padding. Rows match the sidebar row height.
- **Dialogs:** `surface.card`, 1 px `border.default`, 20 px radius, `shadow.2`, 24 px padding. Title `type.title`; body `type.body`.
- **Tooltips:** `surface.inverse`, `text.inverse`, `type.caption`, 8 px radius, 6 × 8 px padding, `shadow.1`. No arrow, no blur.
- **PDF page:** `#FFFFFF`, exact document colours, no tint, no radius on the page bitmap, 1 px `border.divider` around the page, no drop shadow. The surround is `surface.content` with 24 px.
- **Selected state:** always fill + accent rail/underline + 500 weight. Never colour alone.
- **Focus:** 2 px `accent.solid`, 2 px offset, around the whole control. No inner focus line and no glow.

## 2. Presets

Default: **Sage Lab**, mode follows the OS on first run. A preset persists independently of the mode; the light and dark variants are both part of the preset. A custom accent overrides the preset accent but not its surfaces.

| Preset | Intent | Accent | Use |
| --- | --- | --- | --- |
| Sage Lab | Soft green; clinical research workspace | `#2F6B4F` light / `#7CC79A` dark | Default. Long reading, lab notes, low visual noise. |
| Paper Studio | Warm cream and terracotta; uncoated paper | `#A0432A` light / `#E18B64` dark | Annotation-heavy reading and a warmer library. |
| Mineral Workspace | Cool grey with teal | `#146B73` light / `#5CC2C9` dark | Dense library management and comparison work. |
| Arctic Research | White with cold blue | `#1B5FA9` light / `#6FB0F2` dark | Colour-critical PDFs; the surround is nearly neutral. |
| Aurora Studio | Soft lavender/peach, one restrained gradient | `#7A3F8E` light / `#D3A0EC` dark | Personal workspace. The gradient is limited to the Home greeting/empty state. |

All values are exact sRGB hex. Status rows repeat in both tables because status is shared across presets.

### 2.1 Preset token values — light

| Token | Sage Lab | Paper Studio | Mineral Workspace | Arctic Research | Aurora Studio |
| --- | --- | --- | --- | --- | --- |
| `surface.window` | `#F2F4F0` | `#F4EEE4` | `#EDF1F2` | `#EEF4FA` | `#F6F0F7` |
| `surface.sidebar` | `#ECF0EA` | `#F0E9DE` | `#E7ECEE` | `#E8F1F9` | `#F3ECF6` |
| `surface.content` | `#FAFBF8` | `#FCF8F1` | `#F8FAFA` | `#FAFDFF` | `#FCF8FC` |
| `surface.card` | `#FFFFFF` | `#FFFDF9` | `#FFFFFF` | `#FFFFFF` | `#FFFDFF` |
| `surface.hover` | `#EDF2EA` | `#F4EDE3` | `#EAF0F1` | `#EEF5FC` | `#F6EEF7` |
| `surface.selected` | `#DBE7DA` | `#F0E0D2` | `#DCE8E9` | `#DDECFA` | `#F0E3F4` |
| `surface.inverse` | `#1B3527` | `#3A2419` | `#0F3338` | `#102C4D` | `#352040` |
| `border.default` | `#728172` | `#8D7966` | `#687B7E` | `#6E839A` | `#86738F` |
| `border.divider` | `#D8DFD5` | `#E2D6C7` | `#D3DEE0` | `#D5E3F0` | `#E7DAEA` |
| `text.primary` | `#1A231B` | `#271E17` | `#152025` | `#0E1A25` | `#261D2B` |
| `text.secondary` | `#465247` | `#55463A` | `#405157` | `#3C5065` | `#4F3F58` |
| `text.muted` | `#59665A` | `#6B594A` | `#54666C` | `#53687D` | `#67546F` |
| `text.inverse` | `#F5FAF5` | `#FFF7EF` | `#F4FBFB` | `#F4F9FF` | `#FBF5FC` |
| `accent.solid` | `#2F6B4F` | `#A0432A` | `#146B73` | `#1B5FA9` | `#7A3F8E` |
| `accent.hover` | `#275C43` | `#8C3922` | `#0F5961` | `#164C87` | `#663277` |
| `accent.subtle` | `#DDEBE1` | `#F3E1D7` | `#DCEDEF` | `#DFECFA` | `#F0E2F4` |
| `accent.on` | `#FFFFFF` | `#FFF9F2` | `#FFFFFF` | `#FFFFFF` | `#FFFFFF` |
| `status.danger` | `#A62A22` | `#A62A22` | `#A62A22` | `#A62A22` | `#A62A22` |
| `status.warning` | `#7A5200` | `#7A5200` | `#7A5200` | `#7A5200` | `#7A5200` |
| `status.success` | `#2E6B45` | `#2E6B45` | `#2E6B45` | `#2E6B45` | `#2E6B45` |

### 2.2 Preset token values — dark

| Token | Sage Lab | Paper Studio | Mineral Workspace | Arctic Research | Aurora Studio |
| --- | --- | --- | --- | --- | --- |
| `surface.window` | `#101511` | `#161210` | `#0E1415` | `#0C1219` | `#131016` |
| `surface.sidebar` | `#131914` | `#1A1613` | `#11191A` | `#0F171F` | `#17121B` |
| `surface.content` | `#171E18` | `#1F1A16` | `#151F20` | `#131C25` | `#1B1420` |
| `surface.card` | `#1E261F` | `#26201B` | `#1C2729` | `#1A242F` | `#231A29` |
| `surface.hover` | `#252F27` | `#2E2721` | `#233032` | `#202D39` | `#2B2031` |
| `surface.selected` | `#2C3A30` | `#392D25` | `#293A3C` | `#263646` | `#35273D` |
| `surface.inverse` | `#1B3527` | `#3A2419` | `#0F3338` | `#102C4D` | `#352040` |
| `border.default` | `#7C8D7C` | `#97826E` | `#7B9194` | `#72889E` | `#907BA1` |
| `border.divider` | `#2B352E` | `#372F28` | `#293638` | `#26333E` | `#322739` |
| `text.primary` | `#EDF2EC` | `#F4EDE4` | `#ECF3F3` | `#EDF4FB` | `#F4EDF6` |
| `text.secondary` | `#B8C3B7` | `#C8B9A9` | `#B7C6C8` | `#B7C7D8` | `#C9BAD2` |
| `text.muted` | `#9BA89A` | `#A89583` | `#92A5A7` | `#92A5B9` | `#A896B3` |
| `text.inverse` | `#F5FAF5` | `#FFF7EF` | `#F4FBFB` | `#F4F9FF` | `#FBF5FC` |
| `accent.solid` | `#7CC79A` | `#E18B64` | `#5CC2C9` | `#6FB0F2` | `#D3A0EC` |
| `accent.hover` | `#94D8AF` | `#EDA17C` | `#7BD5DA` | `#8CC3FA` | `#E1B5F5` |
| `accent.subtle` | `#26382C` | `#3A2A21` | `#1E3436` | `#1B3045` | `#372943` |
| `accent.on` | `#0E1C12` | `#23150E` | `#082022` | `#071522` | `#22122C` |
| `status.danger` | `#F28B82` | `#F28B82` | `#F28B82` | `#F28B82` | `#F28B82` |
| `status.warning` | `#E8B96B` | `#E8B96B` | `#E8B96B` | `#E8B96B` | `#E8B96B` |
| `status.success` | `#7FD1A1` | `#7FD1A1` | `#7FD1A1` | `#7FD1A1` | `#7FD1A1` |

### 2.3 Aurora gradient

`surface.aurora` is the only gradient in the system. It is used only on the Home greeting band or the empty-state band, never behind PDF cards, lists, or reading content.

| Mode | Exact stops | Limits |
| --- | --- | --- |
| Light | `linear-gradient(135deg, #F4E8F8 0%, #FDF0E7 100%)` | Maximum one band per screen, maximum 240 px high. No blur, no grain, no animated stops. |
| Dark | `linear-gradient(135deg, #2A1E32 0%, #3A241E 100%)` | Same limits. Text on it is `text.primary`/`text.secondary`; icons use `accent.solid`. |

Contrast on the gradient stops:

- Light: `text.primary` 13.72 / 14.54; `text.muted` 5.77 / 6.11; `accent.solid` 6.06 / 6.42.
- Dark: `text.primary` 13.75 / 12.61; `text.muted` 5.77 / 5.29; `accent.solid` 7.52 / 6.90.

No other gradient is allowed in any preset. Aurora does not use blur to soften the transition; the stops are deliberate flat colour.

## 3. Contrast evidence

WCAG 2.2 relative luminance is computed from exact sRGB hex:

`L = 0.2126 R + 0.7152 G + 0.0722 B`, with each channel linearised, and `contrast = (L1 + 0.05) / (L2 + 0.05)` (lighter first).

"Min" means the lowest ratio across every surface the token can touch: `surface.window`, `surface.sidebar`, `surface.content`, `surface.card`, `surface.hover`, `surface.selected`, and `accent.subtle`. `text.inverse` is checked against `surface.inverse` only. All colours are opaque, so no alpha compositing is involved.

### 3.1 Text contrast minima

| Preset | Mode | text.primary | text.secondary | text.muted | text.inverse |
| --- | --- | --- | --- | --- | --- |
| Sage Lab | light | 12.66 (selected) | 6.43 (selected) | 4.74 (selected) | 12.54 |
| Sage Lab | dark | 10.55 (selected) | 6.57 (selected) | 4.82 (selected) | 12.54 |
| Paper Studio | light | 12.69 (selected) | 7.01 (selected) | 5.17 (selected) | 13.69 |
| Paper Studio | dark | 11.47 (selected) | 6.96 (selected) | 4.63 (selected) | 13.69 |
| Mineral Workspace | light | 13.25 (selected) | 6.62 (selected) | 4.80 (selected) | 12.92 |
| Mineral Workspace | dark | 10.59 (selected) | 6.76 (selected) | 4.63 (selected) | 12.92 |
| Arctic Research | light | 14.63 (selected) | 6.91 (selected) | 4.79 (selected) | 13.32 |
| Arctic Research | dark | 11.15 (selected) | 7.17 (selected) | 4.89 (selected) | 13.32 |
| Aurora Studio | light | 13.06 (accent.subtle) | 7.73 (accent.subtle) | 5.49 (accent.subtle) | 13.66 |
| Aurora Studio | dark | 11.72 (accent.subtle) | 7.33 (accent.subtle) | 4.92 (accent.subtle) | 13.66 |

Every `text.primary`, `text.secondary`, and `text.muted` value is ≥ 4.5:1 on every listed surface; `text.inverse` is ≥ 12.54:1 on `surface.inverse`. The tightest rows are Paper Studio dark and Mineral Workspace dark `text.muted` at 4.63:1. The 28 px display and 20 px title use `text.primary`, so they also clear the 3:1 large-text threshold by a wide margin.

### 3.2 UI and accent contrast minima

| Preset | Mode | border.default (min surface) | accent.solid (min surface) | accent.on / accent.solid | accent.on / accent.hover |
| --- | --- | --- | --- | --- | --- |
| Sage Lab | light | 3.23 (selected) | 4.93 (selected) | 6.29 | 7.78 |
| Sage Lab | dark | 3.39 (selected) | 5.98 (selected) | 8.79 | 10.64 |
| Paper Studio | light | 3.22 (selected) | 4.89 (selected) | 6.03 | 7.37 |
| Paper Studio | dark | 3.64 (selected) | 5.13 (selected) | 6.82 | 8.43 |
| Mineral Workspace | light | 3.55 (selected) | 4.96 (selected) | 6.21 | 8.01 |
| Mineral Workspace | dark | 3.58 (selected) | 5.68 (selected) | 8.08 | 9.98 |
| Arctic Research | light | 3.25 (selected) | 5.36 (selected) | 6.45 | 8.69 |
| Arctic Research | dark | 3.37 (selected) | 5.40 (selected) | 8.05 | 9.92 |
| Aurora Studio | light | 3.47 (accent.subtle) | 5.77 (accent.subtle) | 7.17 | 9.18 |
| Aurora Studio | dark | 3.55 (accent.subtle) | 6.41 (accent.subtle) | 8.40 | 10.19 |

- `border.default` is ≥ 3:1 on every surface; the tightest is 3.22:1. This is why it is the only border allowed to delimit a control or card.
- `accent.solid` is ≥ 4.89:1 against every surface, so it also works as 13 px link text, not only as a 3:1 focus ring.
- `accent.on` is ≥ 6.03:1 on solid and ≥ 7.37:1 on hover.
- `border.divider` is 1.27–1.35:1 against content by design. It is decorative only and must never be the only boundary of a control, card, or state.

### 3.3 Status contrast minima

| Preset | Mode | status.danger | status.warning | status.success |
| --- | --- | --- | --- | --- |
| Sage Lab | light | 5.53 (selected) | 5.42 (selected) | 4.98 (selected) |
| Sage Lab | dark | 5.01 (selected) | 6.60 (selected) | 6.57 (selected) |
| Paper Studio | light | 5.48 (selected) | 5.37 (selected) | 4.93 (selected) |
| Paper Studio | dark | 5.58 (selected) | 7.35 (selected) | 7.32 (selected) |
| Mineral Workspace | light | 5.63 (selected) | 5.52 (selected) | 5.07 (selected) |
| Mineral Workspace | dark | 4.98 (selected) | 6.56 (selected) | 6.54 (selected) |
| Arctic Research | light | 5.87 (selected) | 5.75 (selected) | 5.28 (selected) |
| Arctic Research | dark | 5.18 (selected) | 6.82 (selected) | 6.79 (selected) |
| Aurora Studio | light | 5.68 (accent.subtle) | 5.57 (accent.subtle) | 5.11 (accent.subtle) |
| Aurora Studio | dark | 5.63 (accent.subtle) | 7.42 (accent.subtle) | 7.39 (accent.subtle) |

Every status foreground is ≥ 4.93:1 on every tested surface. That does not make a status fill safe: the design does not use status fills, because a fill would need a separate measured `on-status` colour.

### 3.4 State and focus notes

- `surface.selected` is deliberately subtle: 1.17–1.42:1 against content. The selected state is carried by the 3 px `accent.solid` rail (or 2 px tab underline), 500-weight text, and the accent icon. Never rely on the fill alone.
- `surface.hover` is a background-only cue. It does not need a 3:1 boundary because it is not the only state signal; the pointer position and the control outline provide the rest.
- The focus ring uses `accent.solid`, which is ≥ 4.89:1 against every surface and ≥ 3:1 against `accent.subtle`. The 2 px offset ensures the ring is visible against both card and selected backgrounds.
- All interactive targets are at least 24 × 24 px (WCAG 2.2 AA); the shell uses 32 × 32 px for controls and window buttons.

## 4. Custom accent

The user may supply one sRGB hex accent. The effective accent is normalised per mode so it remains safe as a fill, a focus ring, and 13 px link text on `surface.content` or `surface.card`. The picker must show the effective hex, not only the raw input; the raw input is stored so the result can be recomputed when the mode or preset changes.

### 4.1 Normalisation algorithm

1. Parse the input as sRGB. If it fails, reject it and keep the previous accent.
2. Set `accent.on` by mode: `#FFFFFF` in light mode, `#101411` in dark mode. These are the only two custom on-accent colours.
3. Normalise `accent.solid` in 2% sRGB steps:
   - Light: mix toward `#000000` until `accent.on` vs accent ≥ 4.5, accent vs `surface.content` ≥ 4.5, accent vs `surface.card` ≥ 4.5, and accent vs `surface.selected` ≥ 3.0.
   - Dark: mix toward `#FFFFFF` with the same gates.
   - Maximum 50 steps. The light mode darkens; the dark mode lightens.
4. `accent.hover`: light = mix effective accent with `#000000` at 10%; dark = mix with `#FFFFFF` at 10%. Both directions increase the relevant contrast.
5. `accent.subtle`: light = mix `surface.content` with effective accent at 12%; dark = mix at 18%. Then, while `text.primary` or `text.muted` vs subtle < 4.5, or effective accent vs subtle < 3.0, reduce the accent percentage by 2% and recompute. Minimum 2%.
6. Validate the final tokens. If any gate fails, reject the custom accent rather than shipping an unreadable state.
7. Custom accent changes only `accent.solid`, `accent.hover`, `accent.subtle`, and `accent.on`. It never tints surfaces, text, borders, or status.

### 4.2 Worked example

Input `#7C3AED`, applied to Sage Lab in both modes:

| Token / check | Light | Dark |
| --- | --- | --- |
| Input | `#7C3AED` | `#7C3AED` |
| Effective `accent.solid` | `#7C3AED` | `#A173ED` |
| `accent.hover` | `#7034D5` | `#AA81EF` |
| `accent.subtle` | `#EBE4F7` | `#302D3E` |
| `accent.on` | `#FFFFFF` | `#101411` |
| `accent.solid` vs `surface.content` | 5.49 | 5.01 |
| `accent.solid` vs `accent.subtle` | 4.61 | 3.94 |
| `accent.on` vs `accent.solid` | 5.70 | 5.48 |
| `accent.on` vs `accent.hover` | 6.69 | 6.28 |
| `text.primary` vs `accent.subtle` | 13.05 | 11.79 |
| `text.muted` vs `accent.subtle` | 4.89 | 5.39 |

The dark effective accent is lighter than the input because the raw violet is only 3.32:1 against Sage Lab dark content and would fail as link text. The normaliser lifted it to 5.01:1 and switched `accent.on` to dark ink. This is expected: custom accents are normalised, not used literally.

## 5. Icon inventory

The lean icon set is generated from **lucide@0.468.0**. The semantic filename is the API. Every file is 24 × 24 viewBox, `fill="none"`, `stroke="currentColor"`, `stroke-width="1.7"`, round caps and joins.

### 5.1 Navigation and actions

| Semantic name | File | Lucide 0.468.0 | Use |
| --- | --- | --- | --- |
| home | `icons/home.svg` | `house` | Home / start |
| library | `icons/library.svg` | `library-big` | Library |
| tabs | `icons/tabs.svg` | `notebook-tabs` | Open document tabs |
| search | `icons/search.svg` | `search` | Search field and search action |
| plus | `icons/plus.svg` | `plus` | Import PDF, add action |
| settings | `icons/settings.svg` | `settings` | Settings |
| favourite | `icons/favourite.svg` | `star` | Favourite / starred |
| translate | `icons/translate.svg` | `languages` | Translate |
| capture | `icons/capture.svg` | `scan-line` | Window or region capture |
| sidebar-collapse | `icons/sidebar-collapse.svg` | `panel-left-close` | Collapse sidebar |
| sidebar-expand | `icons/sidebar-expand.svg` | `panel-left-open` | Expand sidebar; companion state |

### 5.2 Window controls

| Semantic name | File | Lucide 0.468.0 | Use |
| --- | --- | --- | --- |
| window-minimize | `icons/window-minimize.svg` | `minus` | Minimise |
| window-maximize | `icons/window-maximize.svg` | `maximize` | Maximise |
| window-close | `icons/window-close.svg` | `x` | Close |
| window-restore | `icons/window-restore.svg` | `copy` | Restore from maximised |

### 5.3 Disclosure and state

| Semantic name | File | Lucide 0.468.0 | Use |
| --- | --- | --- | --- |
| chevron-down | `icons/chevron-down.svg` | `chevron-down` | Collapsed disclosure, dropdown |
| chevron-right | `icons/chevron-right.svg` | `chevron-right` | Closed disclosure, next |
| chevron-left | `icons/chevron-left.svg` | `chevron-left` | Back, previous |
| chevron-up | `icons/chevron-up.svg` | `chevron-up` | Open disclosure, collapse |
| check | `icons/check.svg` | `check` | Done, selected, success |
| x | `icons/x.svg` | `x` | Clear, dismiss |
| more | `icons/more.svg` | `ellipsis` | More actions |

The single inventory item "chevrons" expands to the four directional names. Do not use one rotated glyph for all four; the optical alignment differs.

### 5.4 Library and files

| Semantic name | File | Lucide 0.468.0 | Use |
| --- | --- | --- | --- |
| grid | `icons/grid.svg` | `layout-grid` | Grid view |
| list | `icons/list.svg` | `list` | List view |
| sort | `icons/sort.svg` | `arrow-up-down` | Sort order |
| filter | `icons/filter.svg` | `filter` | Filter |
| folder | `icons/folder.svg` | `folder` | Folder |
| file | `icons/file.svg` | `file-text` | PDF/document |
| pin | `icons/pin.svg` | `pin` | Pinned |
| trash | `icons/trash.svg` | `trash-2` | Delete / trash |
| external | `icons/external.svg` | `external-link` | Open externally |

### 5.5 Playback and appearance

| Semantic name | File | Lucide 0.468.0 | Use |
| --- | --- | --- | --- |
| pause | `icons/pause.svg` | `pause` | Pause capture/translation |
| play | `icons/play.svg` | `play` | Resume/start |
| refresh | `icons/refresh.svg` | `refresh-cw` | Retry/refresh |
| moon | `icons/moon.svg` | `moon` | Dark mode |
| sun | `icons/sun.svg` | `sun` | Light mode |
| palette | `icons/palette.svg` | `palette` | Preset/custom accent |
| monitor | `icons/monitor.svg` | `monitor` | Display/system theme |

### 5.6 Icon rules

- Display sizes: 14 px inline, 16 px sidebar/menu, 18 px top band/window/toolbar, 20 px large action, 24 px placeholder. Do not scale below 14 px.
- Every icon-only button carries a text tooltip with the action name. The icon is decorative in the accessibility tree; the tooltip is the label.
- No filled variants. Active favourite/pin is shown with `accent.solid` plus 500-weight text, not a filled glyph. If a filled state is ever required, add a separate semantic filename and generate it; do not inline raw SVG at the call site.
- No colour is baked into an asset. `currentColor` is the only stroke colour.
- Keep the 24 × 24 viewBox and 1.7 stroke. A 16 px render has an effective stroke of about 1.13 px; do not compensate by changing the asset.
- The 56 transition aliases in `assets-safe/icons` are for the approved reference shell only. They are not part of the lean icon inventory and must not be used by new lean call sites.

## 6. Generation and verification

The generator is `scripts/safe-shell-icons.mjs`. It reads `native-shell/assets/icons` when that copied source exists; in this checkout it does not, so it regenerates the existing transition aliases from the current safe output for as long as the reference shell remains. The 38 lean semantic icons are always generated from the Lucide package named above. A missing Lucide mapping for a lean icon is a hard failure.

Run from the workspace root:

```sh
node scripts/safe-shell-icons.mjs
```

Observed output on 2026-11-08:

```text
Generated 94 Lucide SVGs at 24x24, stroke 1.7, currentColor: 56 transition aliases + 38 lean semantic icons.
Original commercial icons will not be embedded.
```

Verification checks:

- 94 / 94 SVG files in `native-shell/assets-safe/icons` contain `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`, and `stroke-width="1.7"`.
- The 38 lean files are the semantic set below; every other file is a transition alias.
- No `cargo` or `pnpm` build was run for this design task.

Lean file list:

```text
home.svg
library.svg
tabs.svg
search.svg
plus.svg
settings.svg
favourite.svg
translate.svg
capture.svg
window-minimize.svg
window-maximize.svg
window-close.svg
window-restore.svg
chevron-down.svg
chevron-right.svg
chevron-left.svg
chevron-up.svg
check.svg
x.svg
grid.svg
list.svg
sort.svg
filter.svg
folder.svg
file.svg
more.svg
pause.svg
play.svg
refresh.svg
external.svg
trash.svg
pin.svg
moon.svg
sun.svg
palette.svg
monitor.svg
sidebar-collapse.svg
sidebar-expand.svg
```

## 7. Acceptance checklist

- [ ] Default is Sage Lab, following the OS mode on first run.
- [ ] All five presets and both modes carry the exact hex values in §2.
- [ ] Every text token is ≥ 4.5:1 on every surface; `text.muted` is not a low-contrast grey.
- [ ] `border.default` is ≥ 3:1 on every surface it touches; `border.divider` is never used as a control boundary.
- [ ] `accent.on` is never used on `accent.subtle`.
- [ ] Status colours are foreground only; no red/amber/green fills behind text.
- [ ] PDF pixels are rendered on white with no tint, inversion, or blur in either mode.
- [ ] No blur, acrylic, glass, glow, gradient other than Aurora's one band, or animated theme transition.
- [ ] Cards have a 1 px `border.default` and no shadow; menus/dialogs are the only floating surfaces.
- [ ] Focus ring is 2 px `accent.solid` with 2 px offset; selected state has a rail/underline and 500 weight, not colour alone.
- [ ] Every lean icon resolves to the listed Lucide name; all are 24 × 24, 1.7 stroke, `currentColor`.
- [ ] `node scripts/safe-shell-icons.mjs` regenerates all 94 files with the attributes above.
