#!/usr/bin/env bash
# Removes LMQS (Linux Mint Quick Settings) and restores the panel layout saved by install.sh (if any).
set -euo pipefail

UUID="lmqs@henzljw"
BACKUP="$HOME/.config/lmqs-applets.bak"
[[ -e "$BACKUP" ]] || BACKUP="$HOME/.config/gnome-quick-settings-applets.bak"   # saved by the old installer

python3 - "$UUID" "$BACKUP" <<'PY'
import os, sys
from gi.repository import Gio
uuid, backup = sys.argv[1], sys.argv[2]
s = Gio.Settings.new("org.cinnamon")
if os.path.exists(backup):
    with open(backup) as f:
        applets = [l for l in f.read().splitlines() if l.strip()]
    os.remove(backup)
    print("✓ Restored your original panel layout")
else:
    applets = [a for a in s.get_strv("enabled-applets") if f":{uuid}:" not in a]
s.set_strv("enabled-applets", applets)
Gio.Settings.sync()
PY

rm -rf "$HOME/.local/share/cinnamon/applets/$UUID" "$HOME/.local/share/cinnamon/applets/gnome-quick-settings@henzljw"

if [[ -e /etc/udev/rules.d/70-gqs-legion-rgb.rules ]]; then
    echo "Removing the keyboard lighting permission rule…"
    sudo rm -f /etc/udev/rules.d/70-gqs-legion-rgb.rules
    sudo udevadm control --reload-rules
    sudo udevadm trigger --subsystem-match=hidraw --action=change
    echo "✓ Keyboard lighting rule removed"
fi

# Camera toggle: turn the camera back on and remove the helper (asks for your password).
if [[ -e /usr/local/libexec/gqs-camera || -e /usr/share/polkit-1/actions/com.henzljw.gqs.camera.policy || -e /etc/modprobe.d/gqs-camera-off.conf ]]; then
    echo "Removing the Camera toggle helper (and turning the camera back on)…"
    sudo rm -f /etc/modprobe.d/gqs-camera-off.conf
    sudo modprobe uvcvideo 2>/dev/null || true
    sudo rm -f /usr/local/libexec/gqs-camera /usr/local/libexec/gqs-camera-on /usr/local/libexec/gqs-camera-off /usr/share/polkit-1/actions/com.henzljw.gqs.camera.policy
    echo "✓ Camera toggle removed"
fi
# Bluetooth at boot: put back the original BlueZ setting if install.sh changed it.
if [[ -e /etc/bluetooth/main.conf.gqs.bak ]]; then
    echo "Restoring the original Bluetooth boot setting…"
    sudo mv -f /etc/bluetooth/main.conf.gqs.bak /etc/bluetooth/main.conf
    echo "✓ Bluetooth boot setting restored"
fi
echo "✓ Removed $UUID"
