#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# Pack, install and enable the extension, then log out so GNOME Shell loads it.
# Pass --no-logout to skip the logout.

set -eu

UUID='quarter-tiling@microsoftruinseverything456.github.io'
PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
LOGOUT_DELAY=5
LOGOUT=1

for arg in "$@"; do
    case $arg in
        --no-logout)
            LOGOUT=0
            ;;
        *)
            echo "Usage: $0 [--no-logout]" >&2
            exit 1
            ;;
    esac
done

if ! command -v gnome-extensions >/dev/null 2>&1; then
    echo "gnome-extensions is required to install Quarter Tiling." >&2
    exit 1
fi

BUILD_DIR=$(mktemp -d)
trap 'rm -rf "$BUILD_DIR"' EXIT

gnome-extensions pack --force --out-dir="$BUILD_DIR" "$PROJECT_DIR"

ACCOUNT_HOME=$(getent passwd "$(id -u)" | cut -d: -f6)
ACCOUNT_HOME=${ACCOUNT_HOME:-$HOME}
TARGET_DIR="${XDG_DATA_HOME:-"$ACCOUNT_HOME/.local/share"}/gnome-shell/extensions/$UUID"

# A development symlink to the source tree may be in place; unlink it so the
# forced install replaces the link instead of writing into the source tree.
if [ -L "$TARGET_DIR" ]; then
    echo "Removing development symlink: $TARGET_DIR"
    rm "$TARGET_DIR"
fi

gnome-extensions install --force "$BUILD_DIR/$UUID.shell-extension.zip"
echo "Installed $UUID"

# GNOME Shell only discovers a new extension after logging back in, so enable
# it through the setting it reads at startup instead of gnome-extensions enable.
ENABLED=$(gsettings get org.gnome.shell enabled-extensions)
case $ENABLED in
    *"'$UUID'"*)
        ;;
    @as\ \[\])
        gsettings set org.gnome.shell enabled-extensions "['$UUID']"
        ;;
    *)
        gsettings set org.gnome.shell enabled-extensions "${ENABLED%]}, '$UUID']"
        ;;
esac
echo "Enabled $UUID"

if [ "$LOGOUT" -eq 0 ]; then
    echo "Log out and back in to load the extension."
    exit 0
fi

if ! command -v gnome-session-quit >/dev/null 2>&1; then
    echo "gnome-session-quit not found; log out manually to load the extension." >&2
    exit 1
fi

i=$LOGOUT_DELAY
while [ "$i" -gt 0 ]; do
    printf '\rLogging out in %d seconds... (Ctrl+C to cancel) ' "$i"
    sleep 1
    i=$((i - 1))
done
echo

gnome-session-quit --logout --no-prompt
