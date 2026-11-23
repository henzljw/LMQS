#!/usr/bin/env bash
# LMQS (Linux Mint Quick Settings) — installer
#
#   ./install.sh               install, place Quick Settings on the right side of the panel and
#                              remove Mint's own Sound, Network and Battery (Power) applets
#   ./install.sh --keep-mint   same, but keep Mint's Sound, Network and Battery applets
#   ./install.sh --no-add      only copy the files (add it yourself from System Settings › Applets)
#   ./install.sh --camera      also set up the Camera privacy toggle (asks for your password once)
#   ./install.sh --no-camera   never ask about the Camera toggle
#   ./install.sh --keyboard    set up Legion RGB keyboard lighting (asks for your password once)
#   ./install.sh --no-keyboard never ask about keyboard lighting
#   ./install.sh --bt-boot-off stop Linux switching Bluetooth on at every boot (AutoEnable=false)
#   ./install.sh --no-bt-boot  never ask about that
set -euo pipefail

UUID="lmqs@henzljw"
OLD_UUID="gnome-quick-settings@henzljw"   # name before LMQS: moved over automatically
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/cinnamon/applets/$UUID"
MODE="--replace"
CAMERA="ask"
KEYBOARD="ask"
BTBOOT="ask"
for arg in "$@"; do
    case "$arg" in
        --replace) MODE="--replace" ;;
        --keep-mint) MODE="--keep-mint" ;;
        --no-add) MODE="--no-add" ;;
        --camera) CAMERA="yes" ;;
        --no-camera) CAMERA="no" ;;
        --keyboard) KEYBOARD="yes" ;;
        --no-keyboard) KEYBOARD="no" ;;
        --bt-boot-off) BTBOOT="yes" ;;
        --no-bt-boot) BTBOOT="no" ;;
        *) echo "Unknown option: $arg" >&2; exit 1 ;;
    esac
done

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -r "$HERE/$UUID" "$DEST"
echo "✓ Installed to $DEST"

# ---- Coming from "GNOME Quick Settings" (the name before LMQS): keep your settings and panel spot ----
OLD_DEST="$HOME/.local/share/cinnamon/applets/$OLD_UUID"
OLD_CFG="$HOME/.config/cinnamon/spices/$OLD_UUID"
NEW_CFG="$HOME/.config/cinnamon/spices/$UUID"
if [[ -d "$OLD_CFG" && ! -e "$NEW_CFG/$UUID.json" ]]; then
    src=""
    if [[ -f "$OLD_CFG/$OLD_UUID.json" ]]; then src="$OLD_CFG/$OLD_UUID.json"
    else src="$(ls -t "$OLD_CFG"/*.json 2>/dev/null | grep -v '\.bak' | head -n1 || true)"; fi
    if [[ -n "$src" ]]; then
        mkdir -p "$NEW_CFG"
        cp -p "$src" "$NEW_CFG/$UUID.json"
        echo "✓ Moved your settings over from GNOME Quick Settings"
    fi
fi
python3 - "$OLD_UUID" "$UUID" <<'PY'
import sys
from gi.repository import Gio
old, new = sys.argv[1], sys.argv[2]
s = Gio.Settings.new("org.cinnamon")
applets = list(s.get_strv("enabled-applets"))
if any(f":{old}:" in a or a.endswith(f":{old}") for a in applets):
    # Same panel, same place, same instance: only the name changes.
    s.set_strv("enabled-applets", [a.replace(f":{old}:", f":{new}:") if f":{old}:" in a else
                                   (a[: -len(old)] + new if a.endswith(f":{old}") else a) for a in applets])
    Gio.Settings.sync()
    print("✓ Replaced GNOME Quick Settings with LMQS on your panel")
PY
if [[ -d "$OLD_DEST" ]]; then rm -rf "$OLD_DEST"; echo "✓ Removed the old GNOME Quick Settings files"; fi

if [[ "$MODE" != "--no-add" ]]; then
python3 - "$UUID" "$MODE" <<'PY'
import os, sys
from gi.repository import Gio

uuid, mode = sys.argv[1], sys.argv[2]
s = Gio.Settings.new("org.cinnamon")
applets = list(s.get_strv("enabled-applets"))

backup = os.path.expanduser("~/.config/lmqs-applets.bak")
old_backup = os.path.expanduser("~/.config/gnome-quick-settings-applets.bak")
if os.path.exists(old_backup) and not os.path.exists(backup):
    os.replace(old_backup, backup)   # keep the original layout saved by the old installer
if not os.path.exists(backup):
    with open(backup, "w") as f:
        f.write("\n".join(applets))
    print(f"✓ Backed up your panel layout to {backup}")

def parse(a):
    p = a.split(":")
    if len(p) < 5:
        return None
    try:
        return {"panel": p[0], "zone": p[1], "order": int(p[2]), "uuid": p[3], "id": p[4], "rest": p[5:]}
    except ValueError:
        return None

def build(e):
    return ":".join([e["panel"], e["zone"], str(e["order"]), e["uuid"], e["id"]] + e["rest"])

entries, others = [], []
for a in applets:
    e = parse(a)
    (entries if e else others).append(e if e else a)

if mode == "--replace":
    drop = {"sound@cinnamon.org", "network@cinnamon.org", "power@cinnamon.org"}
    removed = [e["uuid"] for e in entries if e["uuid"] in drop]
    entries = [e for e in entries if e["uuid"] not in drop]
    names = {"sound@cinnamon.org": "Sound", "network@cinnamon.org": "Network", "power@cinnamon.org": "Battery"}
    if removed:
        print("✓ Removed Mint's " + ", ".join(names[u] for u in ["sound@cinnamon.org", "network@cinnamon.org", "power@cinnamon.org"] if u in removed) + " applets (Quick Settings replaces them)")

# Take our applet out (we'll put it back on the right), keeping its instance id and settings.
ours = next((e for e in entries if e["uuid"] == uuid), None)
entries = [e for e in entries if e["uuid"] != uuid]
if ours is None:
    new_id = s.get_int("next-applet-id")
    s.set_int("next-applet-id", new_id + 1)
    ours = {"panel": "", "zone": "right", "order": 0, "uuid": uuid, "id": str(new_id), "rest": []}

# Use the panel that holds the clock (or the system tray), else panel1.
anchor = next((e for e in entries if e["uuid"] == "calendar@cinnamon.org"), None) \
      or next((e for e in entries if e["uuid"] in ("systray@cinnamon.org", "xapp-status@cinnamon.org")), None)
panel = anchor["panel"] if anchor else "panel1"
ours["panel"], ours["zone"] = panel, "right"

# Right zone of that panel, in display order.
right = sorted([e for e in entries if e["panel"] == panel and e["zone"] == "right"], key=lambda e: e["order"])
rest = [e for e in entries if not (e["panel"] == panel and e["zone"] == "right")]

# Like GNOME, sit at the right: just before the clock if it's on the right side,
# otherwise just before "show desktop" (cornerbar), otherwise at the very end.
idx = next((i for i, e in enumerate(right) if e["uuid"] == "calendar@cinnamon.org"), None)
if idx is None:
    idx = next((i for i, e in enumerate(right) if e["uuid"] in ("cornerbar@cinnamon.org", "show-desktop@cinnamon.org")), len(right))
right.insert(idx, ours)
for i, e in enumerate(right):
    e["order"] = i

s.set_strv("enabled-applets", [build(e) for e in rest + right] + others)
Gio.Settings.sync()
print(f"✓ Quick Settings placed on the right side of {panel}")
PY
fi

# ---- Camera privacy toggle (system part, needs sudo once) ----
LIBEXEC=/usr/local/libexec
POLICY=/usr/share/polkit-1/actions/com.henzljw.gqs.camera.policy
camera_installed() {
    for f in gqs-camera gqs-camera-on gqs-camera-off; do
        cmp -s "$HERE/system/$f" "$LIBEXEC/$f" || return 1
    done
    cmp -s "$HERE/system/com.henzljw.gqs.camera.policy" "$POLICY"
}

if [[ "$CAMERA" == "ask" ]] && ! camera_installed && [[ -t 0 ]] && ls /sys/class/video4linux/* >/dev/null 2>&1; then
    echo
    read -r -p "Set up the Camera toggle? It blocks the webcam for privacy. Setup needs your password once. [Y/n] " reply
    if [[ -z "$reply" || "$reply" =~ ^[Yy] ]]; then CAMERA="yes"; else CAMERA="no"; fi
fi

# An older camera setup is updated automatically.
if [[ "$CAMERA" == "ask" && -e "$LIBEXEC/gqs-camera" ]] && ! camera_installed; then CAMERA="yes"; fi

if [[ "$CAMERA" == "yes" ]]; then
    if camera_installed; then
        echo "✓ Camera toggle already set up"
    else
        for f in gqs-camera gqs-camera-on gqs-camera-off; do
            sudo install -D -o root -g root -m 755 "$HERE/system/$f" "$LIBEXEC/$f"
        done
        sudo install -D -o root -g root -m 644 "$HERE/system/com.henzljw.gqs.camera.policy" "$POLICY"
        echo "✓ Camera toggle set up"
    fi
fi

# ---- Lenovo Legion 4-zone RGB keyboard (udev rule, needs sudo once) ----
RULE=/etc/udev/rules.d/70-gqs-legion-rgb.rules
RGB_STATE="$(python3 "$DEST/helpers/gqs-legion-rgb" detect 2>/dev/null || echo none)"
rule_installed() { cmp -s "$HERE/system/70-gqs-legion-rgb.rules" "$RULE"; }

if [[ "$KEYBOARD" == "ask" && "$RGB_STATE" != "none" ]] && ! rule_installed; then
    if [[ -t 0 ]]; then
        echo
        read -r -p "Your Legion RGB keyboard was found. Allow Quick Settings to change its lighting? Needs your password once. [Y/n] " reply
        if [[ -z "$reply" || "$reply" =~ ^[Yy] ]]; then KEYBOARD="yes"; else KEYBOARD="no"; fi
    fi
fi

if [[ "$KEYBOARD" == "yes" ]]; then
    if rule_installed; then
        echo "✓ Keyboard lighting already set up"
    else
        sudo install -D -o root -g root -m 644 "$HERE/system/70-gqs-legion-rgb.rules" "$RULE"
        sudo udevadm control --reload-rules
        sudo udevadm trigger --subsystem-match=hidraw --action=change
        echo "✓ Keyboard lighting set up"
    fi
fi

# ---- Bluetooth at boot (system setting, needs sudo once) ----
# BlueZ's AutoEnable=true switches every adapter on at boot, before anyone logs in.
BTCONF=/etc/bluetooth/main.conf
bt_autoenable_off() { grep -Eq '^[[:space:]]*AutoEnable[[:space:]]*=[[:space:]]*false' "$BTCONF" 2>/dev/null; }

if [[ -f "$BTCONF" ]] && ! bt_autoenable_off; then
    if [[ "$BTBOOT" == "ask" && -t 0 ]]; then
        echo
        read -r -p "Stop Linux switching Bluetooth on at every boot? (Quick Settings' 'Bluetooth at login' then has nothing to undo.) Needs your password once. [y/N] " reply
        if [[ "$reply" =~ ^[Yy] ]]; then BTBOOT="yes"; else BTBOOT="no"; fi
    fi
    if [[ "$BTBOOT" == "yes" ]]; then
        [[ -e "$BTCONF.gqs.bak" ]] || sudo cp -p "$BTCONF" "$BTCONF.gqs.bak"
        sudo python3 - "$BTCONF" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path).read()
if re.search(r'^[#\s]*AutoEnable\s*=.*$', text, re.M):
    text = re.sub(r'^[#\s]*AutoEnable\s*=.*$', 'AutoEnable=false', text, count=1, flags=re.M)
elif re.search(r'^\[Policy\]\s*$', text, re.M):
    text = re.sub(r'^\[Policy\]\s*$', '[Policy]\nAutoEnable=false', text, count=1, flags=re.M)
else:
    text = text.rstrip('\n') + '\n\n[Policy]\nAutoEnable=false\n'
open(path, 'w').write(text)
PY
        echo "✓ Bluetooth no longer switches on by itself at boot (takes effect next boot)"
    fi
elif [[ -f "$BTCONF" ]]; then
    echo "✓ Bluetooth already stays off at boot"
fi

echo
echo "Done. If the panel doesn't update, restart Cinnamon: Ctrl+Alt+Esc (or Alt+F2, type r, Enter)."
