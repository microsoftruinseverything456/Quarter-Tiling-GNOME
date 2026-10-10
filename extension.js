// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {WINDOW_ANIMATION_TIME} from 'resource:///org/gnome/shell/ui/windowManager.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// Built-in mutter keybindings we take over (Super+Up / Super+Down by default).
const MAXIMIZE_BINDING = 'maximize';
const UNMAXIMIZE_BINDING = 'unmaximize';

// Size-hinted windows (terminals, etc.) rarely fill a tile exactly.
const TOLERANCE_PX = 32;

// Give up waiting for a slow client to reach the new geometry after this.
const ANIMATION_WAIT_MS = 1000;

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

        Main.wm.setCustomKeybindingHandler(MAXIMIZE_BINDING,
            Shell.ActionMode.NORMAL,
            (_display, window) => this._onSuperUp(window));
        Main.wm.setCustomKeybindingHandler(UNMAXIMIZE_BINDING,
            Shell.ActionMode.NORMAL,
            (_display, window) => this._onSuperDown(window));
    }

    disable() {
        // A null handler restores mutter's default behaviour.
        Meta.keybindings_set_custom_handler(MAXIMIZE_BINDING, null);
        Meta.keybindings_set_custom_handler(UNMAXIMIZE_BINDING, null);
        Main.wm.allowKeybinding(MAXIMIZE_BINDING, Shell.ActionMode.NONE);
        Main.wm.allowKeybinding(UNMAXIMIZE_BINDING, Shell.ActionMode.NONE);

        for (const window of [...this._animations.keys()])
            this._finishAnimation(window);
        this._animations = null;

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

    _moveToTile(window, workArea, side, slot) {
        const rect = tileRect(workArea, side, slot);
        const actor = window.get_compositor_private();

        // Land any animation still running from a previous key press.
        this._finishAnimation(window);

        if (actor && !rectsEqual(window.get_frame_rect(), rect))
            this._prepareAnimation(window, actor, rect);

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

    // Unmaximizing can queue its own restore geometry; reapply once it settles.
    _settleGeometry(window, rect) {
        this._cancelSettle(window);

        const sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._settleSources.delete(window);
            window.disconnectObject(this);
            if (!rectsEqual(window.get_frame_rect(), rect)) {
                window.move_resize_frame(true, rect.x, rect.y,
                    rect.width, rect.height);
            }
            return GLib.SOURCE_REMOVE;
        });
        this._settleSources.set(window, sourceId);
        window.connectObject('unmanaging', () => this._cancelSettle(window), this);
    }

    _cancelSettle(window) {
        const sourceId = this._settleSources.get(window);
        if (sourceId === undefined)
            return;
        this._settleSources.delete(window);

        GLib.source_remove(sourceId);
        window.disconnectObject(this);
    }

    // Mirrors GNOME Shell's own maximize/tile animation: freeze the window at
    // its old geometry with a snapshot on top, then once the client has resized,
    // scale the window from the old rect to the new one while the snapshot fades.
    _prepareAnimation(window, actor, targetRect) {
        const oldRect = window.get_frame_rect();
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
