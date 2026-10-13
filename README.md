# Quarter Tiling

A GNOME Shell extension that snaps windows into quarters of the screen, with
GNOME's own tiling animation and preview.

Supports GNOME Shell 51.

## Usage

### Keyboard

| Window is…              | Super+Up                     | Super+Down                      |
| ----------------------- | ---------------------------- | ------------------------------- |
| Tiled to a left/right half | Moves to the top quarter of that side | Moves to the bottom quarter of that side |
| In a top quarter        | Maximizes                    | Moves to the bottom quarter     |
| In a bottom quarter     | Moves to the top quarter     | Does nothing                    |

Super+Left / Super+Right on a quarter moves the window to the matching quarter
on the other side of the screen, so a top-right quarter becomes a top-left
quarter and back. Pressing toward the side the window is already on turns it
into a half, as GNOME normally does.

All other windows keep GNOME's normal Super+Arrow behaviour.

### Mouse

Drag a window into a corner of the screen. GNOME's tiling highlight shows the
quarter it will fill; release the mouse button to snap the window there.

- Corners can be reached by moving along the left, right, top or bottom edge
  of the screen.
- Moving back out of the corner along an edge returns to GNOME's usual
  half-tile or maximize preview.
- Like GNOME's own edge tiling, corner snapping is off while Shift is held,
  and when edge tiling is turned off in GNOME's settings.
- Press Escape while dragging to cancel the drag.

## Installation

### From source

```sh
git clone https://github.com/microsoftruinseverything456/quarter-tiling.git
cd quarter-tiling
./install.sh
```

`install.sh` packs, installs and enables the extension, then logs out after a
five-second countdown so GNOME Shell loads it. Pass `--no-logout` to skip the
logout and log out yourself later.

## License

GPL-2.0-or-later
