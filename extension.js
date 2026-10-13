// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {TilePreview, WINDOW_ANIMATION_TIME} from 'resource:///org/gnome/shell/ui/windowManager.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

// Built-in mutter keybindings we take over (Super+Up / Super+Down by default).
const MAXIMIZE_BINDING = 'maximize';
const UNMAXIMIZE_BINDING = 'unmaximize';

// Size-hinted windows (terminals, etc.) rarely fill a tile exactly.
const TOLERANCE_PX = 32;

// Give up waiting for a slow client to reach the new geometry after this.
const ANIMATION_WAIT_MS = 1000;

// Keep putting a window back in its tile for this long after moving it, in case
// a late configure from the client or a finished drag moves it elsewhere.
const SETTLE_MS = 1000;
const SETTLE_MAX_RETRIES = 5;

// How often to check the pointer while a window is being dragged.
const DRAG_POLL_MS = 16;

// Same factor mutter uses to size its edge-tiling zones from the drag threshold.
const DRAG_THRESHOLD_TO_EDGE_FACTOR = 6;

// A corner zone runs this fraction of the work area's shorter side along
// each edge from the corner.
const CORNER_SIZE_FRACTION = 1 / 8;

const Side = {LEFT: 'left', RIGHT: 'right'};
const Slot = {HALF: 'half', TOP: 'top', BOTTOM: 'bottom'};

function isMaximizedAtAll(window) {
    return window.get_maximize_flags() !== Meta.MaximizeFlags.NONE;
}

function near(a, b) {
    return Math.abs(a - b) <= TOLERANCE_PX;
}

function rectsNear(a, b) {
    return near(a.x, b.x) && near(a.y, b.y) &&
        near(a.width, b.width) && near(a.height, b.height);
}

function rectsEqual(a, b) {
    return a.x === b.x && a.y === b.y &&
        a.width === b.width && a.height === b.height;
}

function tileRect(workArea, side, slot) {
    const halfWidth = Math.floor(workArea.width / 2);
    const halfHeight = Math.floor(workArea.height / 2);

    const x = side === Side.LEFT ? workArea.x : workArea.x + halfWidth;
    const width = side === Side.LEFT ? halfWidth : workArea.width - halfWidth;

    switch (slot) {
    case Slot.TOP:
        return {x, y: workArea.y, width, height: halfHeight};
    case Slot.BOTTOM:
        return {
            x,
            y: workArea.y + halfHeight,
            width,
            height: workArea.height - halfHeight,
        };
    default:
        return {x, y: workArea.y, width, height: workArea.height};
    }
}

// Work out whether the window currently occupies a half or quarter tile.
function detectTile(window) {
    const workArea = window.get_work_area_current_monitor();
    const frame = window.get_frame_rect();

    for (const side of [Side.LEFT, Side.RIGHT]) {
        for (const slot of [Slot.HALF, Slot.TOP, Slot.BOTTOM]) {
            if (rectsNear(frame, tileRect(workArea, side, slot)))
                return {side, slot, workArea};
        }
    }
    return null;
}

// Work out which quarter, if any, a window dragged with the pointer at (x, y)
// should drop into. Mirrors the zones mutter uses for edge tiling: the inside
// left/right edges of the work area and the outside top edge, extended with the
// bottom edge so every corner can be reached.
function cornerAtPointer(window, x, y) {
    const monitor = global.display.get_monitor_index_for_rect(
        new Mtk.Rectangle({x, y, width: 1, height: 1}));
    if (monitor < 0)
        return null;

    const monitorRect = global.display.get_monitor_geometry(monitor);
    const workArea = window.get_work_area_for_monitor(monitor);
    const edge = Meta.prefs_get_drag_threshold() * DRAG_THRESHOLD_TO_EDGE_FACTOR;
    const cornerSize = Math.round(
        Math.min(workArea.width, workArea.height) * CORNER_SIZE_FRACTION);

    const atLeft = x >= monitorRect.x && x < workArea.x + edge;
    const atRight = x >= workArea.x + workArea.width - edge &&
        x < monitorRect.x + monitorRect.width;
    const atTop = y >= monitorRect.y && y <= workArea.y;
    const atBottom = y >= workArea.y + workArea.height - edge &&
        y < monitorRect.y + monitorRect.height;

    const nearLeft = x < workArea.x + cornerSize;
    const nearRight = x >= workArea.x + workArea.width - cornerSize;
    const nearTop = y < workArea.y + cornerSize;
    const nearBottom = y >= workArea.y + workArea.height - cornerSize;

    const inCorner =
        ((atLeft || atRight) && (nearTop || nearBottom)) ||
        ((atTop || atBottom) && (nearLeft || nearRight));
    if (!inCorner)
        return null;

    const side = x < workArea.x + workArea.width / 2 ? Side.LEFT : Side.RIGHT;
    const slot = y < workArea.y + workArea.height / 2 ? Slot.TOP : Slot.BOTTOM;
    return {side, slot, workArea, monitor};
}

function canTile(window) {
    return window &&
        window.window_type === Meta.WindowType.NORMAL &&
        !window.is_fullscreen() &&
        window.allows_resize();
}

export default class QuarterTilingExtension extends Extension {
    enable() {
        this._animations = new Map();
        this._settleSources = new Map();
        this._snapLaterId = 0;
        this._drag = null;
        this._shellPreview = null;

        Main.wm.setCustomKeybindingHandler(MAXIMIZE_BINDING,
            Shell.ActionMode.NORMAL,
            (_display, window) => this._onSuperUp(window));
        Main.wm.setCustomKeybindingHandler(UNMAXIMIZE_BINDING,
            Shell.ActionMode.NORMAL,
            (_display, window) => this._onSuperDown(window));

        global.display.connectObject(
            'grab-op-begin', (_display, window, op) => this._onGrabBegin(window, op),
            'grab-op-end', (_display, window) => this._onGrabEnd(window),
            this);

        // Share the shell's tile preview so moving between a half and a corner
        // animates like GNOME's own previews. Mutter re-requests its preview
        // every 200ms while the pointer moves at an edge; remember those
        // requests, but ignore them while a corner preview owns the highlight.
        Main.wm._tilePreview ??= new TilePreview();
        this._tilePreview = Main.wm._tilePreview;
        this._injections = new InjectionManager();
        const extension = this;
        this._injections.overrideMethod(this._tilePreview, 'open',
            original => function (window, rect, monitor) {
                extension._shellPreview = {window, rect, monitor};
                if (!extension._drag?.corner)
                    original.call(this, window, rect, monitor);
            });
        this._injections.overrideMethod(this._tilePreview, 'close',
            original => function () {
                extension._shellPreview = null;
                if (!extension._drag?.corner)
                    original.call(this);
            });
    }

    disable() {
        // A null handler restores mutter's default behaviour.
        Meta.keybindings_set_custom_handler(MAXIMIZE_BINDING, null);
        Meta.keybindings_set_custom_handler(UNMAXIMIZE_BINDING, null);
        Main.wm.allowKeybinding(MAXIMIZE_BINDING, Shell.ActionMode.NONE);
        Main.wm.allowKeybinding(UNMAXIMIZE_BINDING, Shell.ActionMode.NONE);

        global.display.disconnectObject(this);
        if (this._drag?.corner)
            this._closePreview();
        this._stopDrag();
        this._shellPreview = null;

        this._injections.clear();
        this._injections = null;
        this._tilePreview = null;

        for (const window of [...this._animations.keys()])
            this._finishAnimation(window);
        this._animations = null;

        if (this._snapLaterId) {
            global.compositor.get_laters().remove(this._snapLaterId);
            this._snapLaterId = 0;
        }

        for (const window of [...this._settleSources.keys()])
            this._cancelSettle(window);
        this._settleSources = null;
    }

    _onSuperUp(window) {
        if (!window)
            return;

        const tile = canTile(window) ? detectTile(window) : null;
        if (tile?.slot === Slot.HALF || tile?.slot === Slot.BOTTOM) {
            this._moveToTile(window, tile.workArea, tile.side, Slot.TOP);
            return;
        }

        // Default Super+Up (also used for a top quarter).
        if (window.can_maximize())
            window.maximize();
    }

    _onSuperDown(window) {
        if (!window)
            return;

        const tile = canTile(window) ? detectTile(window) : null;
        if (tile?.slot === Slot.HALF || tile?.slot === Slot.TOP) {
            this._moveToTile(window, tile.workArea, tile.side, Slot.BOTTOM);
            return;
        }
        if (tile?.slot === Slot.BOTTOM)
            return;

        // Default Super+Down.
        if (isMaximizedAtAll(window))
            window.unmaximize();
    }

    _moveToTile(window, workArea, side, slot, fromRect = window.get_frame_rect()) {
        const rect = tileRect(workArea, side, slot);
        const actor = window.get_compositor_private();

        // Land any animation still running from a previous key press.
        this._finishAnimation(window);

        if (actor && !rectsEqual(fromRect, rect))
            this._prepareAnimation(window, actor, fromRect, rect);

        // Natively tiled windows are maximized vertically; mutter's constraints
        // would snap them back unless we release that state first. Our own
        // animation covers the change, so skip the shell's unmaximize effect.
        if (isMaximizedAtAll(window)) {
            if (actor)
                Main.wm.skipNextEffect(actor);
            window.unmaximize();
        }

        window.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
        this._settleGeometry(window, rect);
    }

    _onGrabBegin(window, op) {
        this._stopDrag();
        this._cancelSettle(window);

        if (op !== Meta.GrabOp.MOVING && op !== Meta.GrabOp.MOVING_UNCONSTRAINED)
            return;
        if (!canTile(window))
            return;

        this._drag = {
            window,
            corner: null,
            startRect: window.get_frame_rect(),
            frameRect: window.get_frame_rect(),
            pollId: GLib.timeout_add(GLib.PRIORITY_DEFAULT, DRAG_POLL_MS, () => {
                this._updateDrag();
                return GLib.SOURCE_CONTINUE;
            }),
        };
    }

    _onGrabEnd(window) {
        const drag = this._drag;
        if (drag?.window !== window)
            return;

        // By now mutter may already have tiled or maximized the window on
        // release, so use the state from the last poll during the drag.
        const {corner, startRect, frameRect} = drag;
        this._stopDrag();
        this._shellPreview = null;

        if (!corner)
            return;

        this._closePreview();

        // Escape cancels the drag by putting the window back where it started.
        if (rectsEqual(window.get_frame_rect(), startRect) &&
            !rectsEqual(frameRect, startRect))
            return;

        // Mutter still treats the drag as active while emitting grab-op-end;
        // snap once it is torn down, but before the window is next drawn so the
        // animation starts from where it was dropped.
        const laters = global.compositor.get_laters();
        if (this._snapLaterId)
            laters.remove(this._snapLaterId);
        this._snapLaterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._snapLaterId = 0;
            if (window.get_compositor_private()) {
                this._moveToTile(window, corner.workArea, corner.side,
                    corner.slot, frameRect);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateDrag() {
        const drag = this._drag;
        const {window} = drag;
        const [x, y, mods] = global.get_pointer();

        // Like mutter: no tiling while snapping with Shift, or before a
        // maximized or tiled window has been dragged loose.
        const corner = Meta.prefs_get_edge_tiling() &&
            !(mods & Clutter.ModifierType.SHIFT_MASK) &&
            !isMaximizedAtAll(window)
            ? cornerAtPointer(window, x, y)
            : null;

        // Where the window is drawn when released, to animate from.
        drag.frameRect = window.get_frame_rect();

        const wasInCorner = drag.corner !== null;
        drag.corner = corner;

        const actor = window.get_compositor_private();
        if (corner) {
            // Mutter will half-tile the window on release if the pointer is in
            // its side zone; skip that animation and play the quarter one.
            if (actor)
                Main.wm.skipNextEffect(actor);
            this._showCornerPreview();
        } else if (wasInCorner) {
            if (actor)
                Main.wm._skippedActors.delete(actor);
            this._restoreShellPreview();
        }
    }

    _stopDrag() {
        const drag = this._drag;
        if (!drag)
            return;
        this._drag = null;

        GLib.source_remove(drag.pollId);

        // Mutter has tiled the window by now (consuming the skip) if it was
        // going to; don't let a stale skip swallow a later animation.
        const actor = drag.window.get_compositor_private();
        if (drag.corner && actor)
            Main.wm._skippedActors.delete(actor);
    }

    // Call the unpatched methods, which the shell's requests can't override.
    _showCornerPreview() {
        const {window, corner} = this._drag;
        const rect = new Mtk.Rectangle(
            tileRect(corner.workArea, corner.side, corner.slot));
        TilePreview.prototype.open.call(this._tilePreview, window, rect,
            corner.monitor);
    }

    _closePreview() {
        TilePreview.prototype.close.call(this._tilePreview);
    }

    // Put back whatever mutter's own edge-tiling preview should be showing.
    _restoreShellPreview() {
        const preview = this._shellPreview;
        if (preview && this._drag?.window === preview.window) {
            TilePreview.prototype.open.call(this._tilePreview, preview.window,
                preview.rect, preview.monitor);
        } else {
            this._closePreview();
        }
    }

    // Clients and mutter can apply older geometry after ours (the restore rect
    // from unmaximizing, or a configure tied to a just-finished drag), so keep
    // reapplying the tile for a short while whenever the window drifts.
    _settleGeometry(window, rect) {
        this._cancelSettle(window);

        const settle = {idleId: 0, timeoutId: 0, retries: SETTLE_MAX_RETRIES};
        const reapply = () => {
            settle.idleId = 0;
            if (rectsEqual(window.get_frame_rect(), rect) || settle.retries <= 0)
                return GLib.SOURCE_REMOVE;
            settle.retries--;
            window.move_resize_frame(true, rect.x, rect.y,
                rect.width, rect.height);
            return GLib.SOURCE_REMOVE;
        };
        const queueReapply = () => {
            if (!settle.idleId)
                settle.idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, reapply);
        };

        settle.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
            settle.timeoutId = 0;
            this._cancelSettle(window);
            return GLib.SOURCE_REMOVE;
        });
        this._settleSources.set(window, settle);
        window.connectObject(
            'position-changed', queueReapply,
            'size-changed', queueReapply,
            // Tiling or maximizing again is deliberate; stop fighting it.
            'notify::maximized-horizontally', () => this._cancelSettle(window),
            'notify::maximized-vertically', () => this._cancelSettle(window),
            'unmanaging', () => this._cancelSettle(window),
            this);
        queueReapply();
    }

    _cancelSettle(window) {
        const settle = this._settleSources.get(window);
        if (!settle)
            return;
        this._settleSources.delete(window);

        if (settle.idleId)
            GLib.source_remove(settle.idleId);
        if (settle.timeoutId)
            GLib.source_remove(settle.timeoutId);
        window.disconnectObject(this);
    }

    // Mirrors GNOME Shell's own maximize/tile animation: freeze the window at
    // its old geometry with a snapshot on top, then once the client has resized,
    // scale the window from the old rect to the new one while the snapshot fades.
    _prepareAnimation(window, actor, oldRect, targetRect) {
        if (oldRect.width <= 0 || oldRect.height <= 0)
            return;

        const clone = new St.Widget({content: actor.paint_to_content(oldRect)});
        clone.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
        clone.set_position(oldRect.x, oldRect.y);
        clone.set_size(oldRect.width, oldRect.height);

        actor.freeze();

        const animation = {
            actor,
            clone,
            oldRect,
            frozen: true,
            started: false,
            timeoutId: 0,
        };
        this._animations.set(window, animation);

        const onGeometryChanged = () => {
            if (rectsNear(window.get_frame_rect(), targetRect))
                this._startAnimation(window);
        };
        window.connectObject(
            'size-changed', onGeometryChanged,
            'position-changed', onGeometryChanged,
            'unmanaged', () => this._finishAnimation(window),
            clone);
        actor.connectObject('destroy', () => {
            animation.actor = null;
            this._finishAnimation(window);
        }, clone);

        animation.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            ANIMATION_WAIT_MS, () => {
                animation.timeoutId = 0;
                if (rectsEqual(window.get_frame_rect(), oldRect))
                    this._finishAnimation(window);
                else
                    this._startAnimation(window);
                return GLib.SOURCE_REMOVE;
            });
    }

    _startAnimation(window) {
        const animation = this._animations?.get(window);
        if (!animation || animation.started)
            return;
        animation.started = true;

        const {actor, clone, oldRect} = animation;
        window.disconnectObject(clone);

        const {reducedMotion} = St.Settings.get();
        const useMotion = reducedMotion !== St.ReducedMotion.REDUCE;
        const targetRect = useMotion ? window.get_frame_rect() : oldRect;
        const scaleX = targetRect.width / oldRect.width;
        const scaleY = targetRect.height / oldRect.height;

        Main.uiGroup.add_child(clone);
        clone.ease({
            x: targetRect.x,
            y: targetRect.y,
            scale_x: scaleX,
            scale_y: scaleY,
            opacity: 0,
            duration: WINDOW_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        actor.translation_x = oldRect.x - targetRect.x;
        actor.translation_y = oldRect.y - targetRect.y;
        actor.scale_x = 1 / scaleX;
        actor.scale_y = 1 / scaleY;
        actor.ease({
            scale_x: 1,
            scale_y: 1,
            translation_x: 0,
            translation_y: 0,
            duration: WINDOW_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => this._finishAnimation(window),
        });

        // With animations off the ease completes synchronously and cleans up.
        if (!this._animations.has(window))
            return;

        // Thaw now so the scale applies to the new texture, not the old one.
        actor.thaw();
        animation.frozen = false;
    }

    _finishAnimation(window) {
        const animation = this._animations?.get(window);
        if (!animation)
            return;
        this._animations.delete(window);

        const {actor, clone} = animation;
        if (animation.timeoutId)
            GLib.source_remove(animation.timeoutId);
        window.disconnectObject(clone);

        if (actor) {
            actor.disconnectObject(clone);
            actor.remove_all_transitions();
            actor.set_scale(1, 1);
            actor.translation_x = 0;
            actor.translation_y = 0;
            if (animation.frozen)
                actor.thaw();
        }

        clone.destroy();
    }
}
