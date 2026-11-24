/*
 * LMQS (Linux Mint Quick Settings): GNOME-style Quick Settings for Cinnamon
 * A faithful recreation of GNOME Shell's Quick Settings menu.
 *
 * Author: Henry henz  -  https://henzljw.vercel.app/
 */

const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Main = imports.ui.main;
const Settings = imports.ui.settings;
const Util = imports.misc.util;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Pango = imports.gi.Pango;
const Cairo = imports.cairo;

let Cvc = null;
try { Cvc = imports.gi.Cvc; } catch (e) { Cvc = null; }

const CENTER = Clutter.ActorAlign.CENTER;
const DIM_OPACITY = 90;
const MAX_PAGES = 4;        // tile pages
const COMPACT_TILES = 6;    // round buttons shown when notifications are expanded
const DEFAULT_ACCENT = [53, 132, 228];

const CAMERA_ON = '/usr/local/libexec/gqs-camera-on';
const CAMERA_OFF = '/usr/local/libexec/gqs-camera-off';

// Apps that should only ever have one window per page; clicking again focuses it.
const SETTINGS_APPS = ['cinnamon-settings', 'xlet-settings', 'blueman-manager', 'nm-connection-editor', 'python3'];
const CAMERA_BLOCK_FILE = '/etc/modprobe.d/gqs-camera-off.conf';

const CSD_POWER_NAME = 'org.cinnamon.SettingsDaemon.Power';
const CSD_POWER_PATH = '/org/cinnamon/SettingsDaemon/Power';

let ICON_DIR = null;

function _(s) { return s; }

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

// Names starting with "/" are files shipped in the applet's icons folder.
function themedIcon(names) {
    if (typeof names === 'string' && names.startsWith('gicon:')) {
        try { return Gio.Icon.new_for_string(names.slice(6)); } catch (e) { return new Gio.ThemedIcon({ names: ['application-x-executable-symbolic'] }); }
    }
    if (!Array.isArray(names)) names = [names];
    names = names.filter(n => !!n);
    let files = names.filter(n => n.startsWith('/'));
    let themed = names.filter(n => !n.startsWith('/'));
    for (let f of files) {
        if (GLib.file_test(f, GLib.FileTest.EXISTS))
            return new Gio.FileIcon({ file: Gio.File.new_for_path(f) });
    }
    return new Gio.ThemedIcon({ names: themed.length ? themed : ['image-missing'] });
}

// Only reload an icon when its names actually change (reloading forces a relayout + redraw).
function setGicon(iconActor, names) {
    if (!iconActor || !names) return;
    let key = (Array.isArray(names) ? names : [names]).join('|');
    if (iconActor._gqsIconKey === key) return;
    iconActor._gqsIconKey = key;
    iconActor.gicon = themedIcon(names);
}

// Panel text must keep its full width: an ellipsizing label can be squeezed to nothing when
// another label next to it needs room (that hid the battery text behind the network speed).
function noShrink(label) {
    try { label.clutter_text.ellipsize = 0; label.clutter_text.line_wrap = false; } catch (e) { }
    label.x_expand = false;
    return label;
}

function wrapLabel(label) {
    try {
        let t = label.clutter_text;
        t.ellipsize = Pango.EllipsizeMode.NONE;
        t.line_wrap = true;
        t.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    } catch (e) { }
    return label;
}

// Same for labels: setting identical text still re-lays out the label.
function setText(label, text) {
    text = text || '';
    if (label.text !== text) label.text = text;
}

function localIcon(name) {
    return ICON_DIR ? `${ICON_DIR}/${name}.svg` : name;
}

function hasProgram(p) {
    return GLib.find_program_in_path(p) !== null;
}

function firstProgram(list) {
    for (let argv of list)
        if (hasProgram(argv[0])) return argv;
    return null;
}

function launch(argv) {
    if (!argv) return;
    try { Util.spawn(argv); } catch (e) { global.logError('[gqs] ' + e); }
}

function run(argv, cb) {
    try {
        let proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        proc.communicate_utf8_async(null, null, (p, res) => {
            let out = '';
            try { out = p.communicate_utf8_finish(res)[1] || ''; } catch (e) { }
            let status = -1;
            try { status = p.get_if_exited() ? p.get_exit_status() : -1; } catch (e) { }
            if (cb) cb(p.get_successful(), out, status);
        });
    } catch (e) {
        if (cb) cb(false, '', -1);
    }
}

function bytesToString(data) {
    try { if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(data); } catch (e) { }
    try { return imports.byteArray.toString(data); } catch (e) { }
    return String(data);
}

function readFile(path) {
    try {
        let [ok, data] = GLib.file_get_contents(path);
        if (ok) return bytesToString(data).trim();
    } catch (e) { }
    return null;
}

function lookupSettings(id, key) {
    let src = Gio.SettingsSchemaSource.get_default();
    if (!src) return null;
    let schema = src.lookup(id, true);
    if (!schema) return null;
    if (key && !schema.has_key(key)) return null;
    return new Gio.Settings({ settings_schema: schema });
}

// Old Cinnamon St still uses StBin x-fill/y-fill; newer St ignores the expando.
function fill(actor) {
    try { actor.x_fill = true; actor.y_fill = true; } catch (e) { }
    return actor;
}

// Cinnamon's StBin/StButton define their own x-align/y-align (St.Align) properties,
// which shadow Clutter's. Call Clutter's setters directly so alignment works everywhere.
function align(actor, x, y) {
    try {
        if (x !== null && x !== undefined) Clutter.Actor.prototype.set_x_align.call(actor, x);
        if (y !== null && y !== undefined) Clutter.Actor.prototype.set_y_align.call(actor, y);
    } catch (e) { }
    return actor;
}

function ellipsize(label) {
    try { label.clutter_text.ellipsize = Pango.EllipsizeMode.END; } catch (e) { }
    return label;
}

function setScrollChild(scroll, child) {
    if (typeof scroll.add_actor === 'function') scroll.add_actor(child);
    else scroll.set_child(child);
    scroll._gqsChild = child;
    // Re-check whether a scrollbar is needed whenever the content changes. Its allocated height
    // can stay the same while what it *wants* grows (e.g. the edit-mode tray appearing in a
    // card that's already at its maximum height), so listen for relayouts, not just size.
    let recheck = () => { if (scroll._gqsQueueCheck) scroll._gqsQueueCheck(); };
    child.connect('notify::height', recheck);
    try { child.connect('queue-relayout', recheck); } catch (e) { }
}

function setVPolicy(scroll, vpolicy) {
    if (scroll._gqsVPolicy === vpolicy) return;
    scroll._gqsVPolicy = vpolicy;
    try { scroll.set_policy(St.PolicyType.NEVER, vpolicy); return; } catch (e) { }
    try {
        scroll.hscrollbar_policy = St.PolicyType.NEVER;
        scroll.vscrollbar_policy = vpolicy;
    } catch (e) { }
}

/* St reserves the scrollbar's width whenever the vertical policy is "automatic", even when
   nothing scrolls, which left an empty strip on the right of the card. So: no scrollbar
   (and no reserved space) while the content fits; a scrollbar only once it really overflows. */
function setScrollPolicy(scroll) {
    setVPolicy(scroll, St.PolicyType.NEVER);
    let check = () => {
        scroll._gqsCheck = 0;
        let child = scroll._gqsChild;
        if (!child || !scroll.mapped) return GLib.SOURCE_REMOVE;
        let w = child.width || -1;
        let [, natH] = child.get_preferred_height(w);
        let boxH = scroll.height;
        setVPolicy(scroll, natH > boxH + 1 ? St.PolicyType.AUTOMATIC : St.PolicyType.NEVER);
        return GLib.SOURCE_REMOVE;
    };
    scroll._gqsQueueCheck = () => {
        if (!scroll._gqsCheck) scroll._gqsCheck = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, check);
    };
    scroll.connect('notify::height', () => scroll._gqsQueueCheck());
    scroll.connect('notify::mapped', () => scroll._gqsQueueCheck());
    scroll.connect('destroy', () => { if (scroll._gqsCheck) { GLib.source_remove(scroll._gqsCheck); scroll._gqsCheck = 0; } });
}

// Split a line of "nmcli -t" output on unescaped ':' and unescape "\:" / "\\".
function splitTerse(line) {
    let fields = [], cur = '';
    for (let i = 0; i < line.length; i++) {
        let c = line[i];
        if (c === '\\' && i + 1 < line.length) { cur += line[++i]; continue; }
        if (c === ':') { fields.push(cur); cur = ''; continue; }
        cur += c;
    }
    fields.push(cur);
    return fields;
}

function terseLines(out) {
    return out.split('\n').filter(l => l).map(l => splitTerse(l));
}

// Parse "xrandr --query": active outputs, their current mode, current rate and the rates
// that mode supports (interlaced modes skipped).
function parseXrandr(out) {
    let displays = [], cur = null;
    for (let line of out.split('\n')) {
        let m = line.match(/^(\S+) connected( primary)?\s*(\d+x\d+\+\d+\+\d+)?/);
        if (m) {
            cur = { name: m[1], primary: !!m[2], active: !!m[3], modes: new Map(), current: null, rate: null, currentMode: null };
            displays.push(cur);
            continue;
        }
        if (/^\S/.test(line)) { cur = null; continue; }
        if (!cur) continue;
        // "1920x1080", or a mode we added such as "1920x1080_60.00-gqs"; skip interlaced ("1920x1080i")
        let mm = line.match(/^\s+((\d+x\d+)(\S*))\s+(.*)$/);
        if (!mm || mm[3] === 'i') continue;
        let modeName = mm[1], res = mm[2];
        let rates = cur.modes.get(res) || [];
        for (let tok of mm[4].trim().split(/\s+/)) {
            let r = tok.match(/^(\d+(?:\.\d+)?)([*+]*)$/);
            if (!r) continue;
            if (!rates.some(x => x.str === r[1])) rates.push({ str: r[1], hz: parseFloat(r[1]), mode: modeName, custom: modeName.endsWith('-gqs') });
            if (r[2].includes('*')) { cur.current = res; cur.rate = r[1]; cur.currentMode = modeName; }
        }
        cur.modes.set(res, rates);
    }
    return displays.filter(d => d.active && d.current).map(d => {
        d.rates = (d.modes.get(d.current) || []).slice().sort((a, b) => b.hz - a.hz);
        d.internal = /^(eDP|LVDS|DSI)/i.test(d.name);
        return d;
    });
}

// Parse "xrandr --verbose": exact timings of every connected output's modes.
function parseXrandrVerbose(out) {
    let outputs = [], cur = null, mode = null;
    for (let line of out.split('\n')) {
        let o = line.match(/^(\S+) (connected|disconnected)/);
        if (o) { cur = { name: o[1], connected: o[2] === 'connected', modes: [] }; outputs.push(cur); mode = null; continue; }
        if (!cur) continue;
        let m = line.match(/^\s{2}(\S+) \((0x[0-9a-f]+)\)\s+([\d.]+)MHz(.*)$/i);
        if (m) {
            mode = { name: m[1], mhz: parseFloat(m[3]), flags: m[4].trim().split(/\s+/).filter(f => /^[+-](HSync|VSync|CSync)$|^Interlace$|^DoubleScan$/.test(f)), current: m[4].includes('*current'), h: null, v: null, hz: 0 };
            cur.modes.push(mode);
            continue;
        }
        if (!mode) continue;
        let h = line.match(/^\s+h: width\s+(\d+) start\s+(\d+) end\s+(\d+) total\s+(\d+)/);
        if (h) { mode.h = h.slice(1, 5).map(Number); continue; }
        let v = line.match(/^\s+v: height\s+(\d+) start\s+(\d+) end\s+(\d+) total\s+(\d+).*clock\s+([\d.]+)Hz/);
        if (v) { mode.v = v.slice(1, 5).map(Number); mode.hz = parseFloat(v[5]); }
    }
    return outputs;
}

// Same timings as the panel's native mode, with the pixel clock scaled down to the target
// rate (how laptop panels with a FreeSync range normally run at 60 Hz).
function customModeline(mode, targetHz) {
    if (!mode || !mode.h || !mode.v || !mode.hz) return null;
    let clock = mode.mhz * targetHz / mode.hz;
    let name = `${mode.h[0]}x${mode.v[0]}_${targetHz.toFixed(2)}-gqs`;
    return { name, args: [name, clock.toFixed(3), ...mode.h.map(String), ...mode.v.map(String), ...mode.flags] };
}

function rateLabel(hz) {
    return Math.abs(hz - Math.round(hz)) < 0.05 ? `${Math.round(hz)} Hz` : `${hz.toFixed(2)} Hz`;
}

function wifiSignalIcon(strength) {
    if (strength > 80) return 'network-wireless-signal-excellent-symbolic';
    if (strength > 55) return 'network-wireless-signal-good-symbolic';
    if (strength > 30) return 'network-wireless-signal-ok-symbolic';
    if (strength > 5) return 'network-wireless-signal-weak-symbolic';
    return 'network-wireless-signal-none-symbolic';
}

function parseColor(str) {
    if (!str) return DEFAULT_ACCENT.slice();
    let m = String(str).match(/rgba?\(([^)]+)\)/);
    if (m) {
        let p = m[1].split(',').map(x => parseFloat(x));
        if (p.length >= 3 && p.slice(0, 3).every(v => !isNaN(v))) return p.slice(0, 3).map(v => Math.round(v));
    }
    m = String(str).match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
    if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
    return DEFAULT_ACCENT.slice();
}

function mixColor(c, target, f) {
    return c.map((v, i) => Math.round(v + (target[i] - v) * f));
}

// WCAG relative luminance (0 = black, 1 = white)
function luminance(c) {
    let ch = c.map(v => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

// True when white text would be hard to read on this color (contrast below 3:1,
// the WCAG minimum for bold UI text). GNOME's own blue stays white (about 3.9:1).
function needsDarkText(c) {
    return 1.05 / (luminance(c) + 0.05) < 3;
}

function cssColor(c) {
    return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/* ---------- D-Bus interfaces ---------- */

function brightnessXml(iface) {
    return `<node><interface name="${iface}">
        <method name="GetPercentage"><arg type="u" name="percentage" direction="out"/></method>
        <method name="SetPercentage"><arg type="u" name="percentage" direction="in"/><arg type="u" name="new_percentage" direction="out"/></method>
        <signal name="Changed"/>
        <signal name="BrightnessChanged"><arg type="u" name="brightness"/></signal>
    </interface></node>`;
}

const ScreenProxy = Gio.DBusProxy.makeProxyWrapper(brightnessXml('org.cinnamon.SettingsDaemon.Power.Screen'));
const KeyboardProxy = Gio.DBusProxy.makeProxyWrapper(brightnessXml('org.cinnamon.SettingsDaemon.Power.Keyboard'));

const UPowerDeviceProxy = Gio.DBusProxy.makeProxyWrapper(`<node>
  <interface name="org.freedesktop.UPower.Device">
    <property name="Type" type="u" access="read"/>
    <property name="State" type="u" access="read"/>
    <property name="Percentage" type="d" access="read"/>
    <property name="IsPresent" type="b" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="TimeToEmpty" type="x" access="read"/>
    <property name="TimeToFull" type="x" access="read"/>
  </interface></node>`);

function powerProfilesXml(iface) {
    return `<node><interface name="${iface}">
        <property name="ActiveProfile" type="s" access="readwrite"/>
        <property name="Profiles" type="aa{sv}" access="read"/>
    </interface></node>`;
}

const SensorProxy = Gio.DBusProxy.makeProxyWrapper(`<node>
  <interface name="net.hadess.SensorProxy">
    <property name="HasAccelerometer" type="b" access="read"/>
  </interface></node>`);

const MprisProxy = Gio.DBusProxy.makeProxyWrapper(`<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
  </interface></node>`);

const MprisPlayerProxy = Gio.DBusProxy.makeProxyWrapper(`<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="SetPosition"><arg type="o" name="TrackId" direction="in"/><arg type="x" name="Position" direction="in"/></method>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
  </interface></node>`);

const PROFILE_INFO = {
    'performance': { label: _('Performance'), icon: ['power-profile-performance-symbolic', 'power-profile-performance'] },
    'balanced': { label: _('Balanced'), icon: ['power-profile-balanced-symbolic', 'power-profile-balanced'] },
    'power-saver': { label: _('Power Saver'), icon: ['power-profile-power-saver-symbolic', 'power-profile-power-saver'] },
};

/* Was this scroll from a touchpad (two-finger) or a mouse wheel? */
function scrollFromTouchpad(event) {
    try {
        let src = event.get_scroll_source && event.get_scroll_source();
        if (src === Clutter.ScrollSource.FINGER || src === Clutter.ScrollSource.CONTINUOUS) return true;
        if (src === Clutter.ScrollSource.WHEEL) return false;
    } catch (e) { }
    try {
        let dev = event.get_source_device() || event.get_device();
        if (dev && dev.get_device_type() === Clutter.InputDeviceType.TOUCHPAD_DEVICE) return true;
        if (dev && /touch ?pad|trackpad|synaptics|elan|alps/i.test(dev.get_device_name() || '')) return true;
    } catch (e) { }
    // Last resort: wheels move in whole steps, touchpads in small fractions.
    if (event.get_scroll_direction() === Clutter.ScrollDirection.SMOOTH) {
        let [dx, dy] = event.get_scroll_delta();
        return Math.abs(dy) % 1 > 0.001 || Math.abs(dx) % 1 > 0.001;
    }
    return false;
}

// Is this kind of scroll allowed by a "both / wheel / touchpad / off" setting?
function scrollAllowed(mode, event) {
    if (mode === 'off') return false;
    if (mode === 'wheel' || mode === 'touchpad') return (mode === 'touchpad') === scrollFromTouchpad(event);
    return true;
}

/* Throttles D-Bus "set percentage" calls while a slider is being dragged */
class Throttled {
    constructor(sendFn) {
        this._send = sendFn;
        this._pending = null;
        this._busy = false;
    }
    set(value) {
        this._pending = value;
        if (!this._busy) this._flush();
    }
    _flush() {
        if (this._pending === null) { this._busy = false; return; }
        let v = this._pending;
        this._pending = null;
        this._busy = true;
        try { this._send(v, () => this._flush()); } catch (e) { this._busy = false; }
    }
}

/* ------------------------------------------------------------------ */
/* Slider (drawn with Cairo, GNOME look)                               */
/* ------------------------------------------------------------------ */

class QSSlider {
    constructor(onChange) {
        this._value = 0;      // the real value
        this._shown = 0;      // where the handle is drawn (glides to _value)
        this._userUntil = 0;  // while the user is scrolling/typing, ignore echoes from the system
        this._anim = 0;
        this._dragging = false;
        this._onChange = onChange;
        this._handleRadius = 10;
        this._trackHeight = 4;
        this.accent = DEFAULT_ACCENT.slice();
        this.light = false;

        this.actor = new St.DrawingArea({
            style_class: 'gqs-slider', reactive: true, can_focus: true,
            x_expand: true, y_align: CENTER,
        });
        this.actor.connect('repaint', a => this._repaint(a));
        this.actor.connect('button-press-event', (a, e) => this._startDrag(e));
        this.actor.connect('scroll-event', (a, e) => this._onScroll(e));
        this.actor.connect('key-press-event', (a, e) => this._onKey(e));
        this.actor.connect('destroy', () => this._stopGlide());
    }

    get value() { return this._value; }

    setValue(v) {
        // Ignore the system reporting back older values while the user is still changing it
        // (that's what made the handle jump back and forth).
        if (this._dragging || GLib.get_monotonic_time() < this._userUntil) return;
        v = Math.max(0, Math.min(1, v));
        if (Math.abs(v - this._value) < 0.001) return;
        this._value = v;
        this._glide();
    }

    // Move the drawn handle smoothly toward the value: ~120 ms ease-out, one small repaint
    // per frame and no relayout.
    _glide(instant) {
        if (instant || !this.actor.mapped) {
            this._stopGlide();
            this._shown = this._value;
            this.actor.queue_repaint();
            return;
        }
        if (this._anim) return;
        this._anim = GLib.timeout_add(GLib.PRIORITY_HIGH_IDLE, 16, () => {
            let d = this._value - this._shown;
            if (Math.abs(d) < 0.002) { this._shown = this._value; this._anim = 0; this.actor.queue_repaint(); return GLib.SOURCE_REMOVE; }
            this._shown += d * 0.35;
            this.actor.queue_repaint();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopGlide() {
        if (this._anim) { GLib.source_remove(this._anim); this._anim = 0; }
    }

    setLook(accent, light) {
        this.accent = accent;
        this.light = light;
        this.actor.queue_repaint();
    }


    _changed(v, smooth) {
        v = Math.max(0, Math.min(1, v));
        this._userUntil = GLib.get_monotonic_time() + 600000;
        if (Math.abs(v - this._value) < 0.0005) return;
        this._value = v;
        this._glide(!smooth);   // dragging follows the pointer exactly; scroll/keys glide
        if (this._onChange) this._onChange(this._value);
    }

    _repaint(area) {
        let cr = area.get_context();
        let [w, h] = area.get_surface_size();
        let r = this._handleRadius;
        let x0 = r, x1 = w - r, cy = h / 2;
        let hx = x0 + (x1 - x0) * this._shown;
        let [ar, ag, ab] = this.accent.map(v => v / 255);

        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(this._trackHeight);

        if (this.light) cr.setSourceRGBA(0, 0, 0, 0.15);
        else cr.setSourceRGBA(1, 1, 1, 0.18);
        cr.moveTo(x0, cy); cr.lineTo(x1, cy); cr.stroke();

        if (this._shown > 0.001) {
            cr.setSourceRGBA(ar, ag, ab, 1);
            cr.moveTo(x0, cy); cr.lineTo(hx, cy); cr.stroke();
        }

        cr.setSourceRGBA(0, 0, 0, this.light ? 0.18 : 0.25);
        cr.arc(hx, cy + 1, r, 0, 2 * Math.PI); cr.fill();
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.arc(hx, cy, r, 0, 2 * Math.PI); cr.fill();
        if (this.light) {
            cr.setSourceRGBA(0, 0, 0, 0.12);
            cr.setLineWidth(1);
            cr.arc(hx, cy, r - 0.5, 0, 2 * Math.PI); cr.stroke();
        }

        if (this.actor.has_key_focus && this.actor.has_key_focus()) {
            cr.setSourceRGBA(ar, ag, ab, 0.6);
            cr.setLineWidth(2);
            cr.arc(hx, cy, r + 1, 0, 2 * Math.PI); cr.stroke();
        }
        cr.$dispose();
    }

    _startDrag(event) {
        if (this._dragging) return Clutter.EVENT_STOP;
        this._dragging = true;
        this._grab = null;
        try {
            let device = event.get_device();
            device.grab(this.actor);
            this._grab = device;
        } catch (e) { this._grab = null; }

        this._releaseId = this.actor.connect('button-release-event', () => this._endDrag());
        this._motionId = this.actor.connect('motion-event', (a, e) => {
            this._moveTo(e);
            return Clutter.EVENT_STOP;
        });
        this._moveTo(event);
        return Clutter.EVENT_STOP;
    }

    _endDrag() {
        if (this._releaseId) this.actor.disconnect(this._releaseId);
        if (this._motionId) this.actor.disconnect(this._motionId);
        this._releaseId = this._motionId = 0;
        if (this._grab) { try { this._grab.ungrab(); } catch (e) { } }
        this._grab = null;
        this._dragging = false;
        this._userUntil = GLib.get_monotonic_time() + 600000;
        return Clutter.EVENT_STOP;
    }

    _moveTo(event) {
        let [x, y] = event.get_coords();
        let [ok, rx] = this.actor.transform_stage_point(x, y);
        if (!ok) return;
        let r = this._handleRadius;
        let w = this.actor.get_width();
        if (w <= 2 * r) return;
        this._changed((rx - r) / (w - 2 * r));
    }

    _onScroll(event) {
        // Not allowed for this slider (setting)? Let the menu scroll instead.
        if (this.scrollFilter && !this.scrollFilter(event)) return Clutter.EVENT_PROPAGATE;
        // A wheel notch arrives twice (smooth + emulated step): use one.
        try { if (event.is_pointer_emulated && event.is_pointer_emulated()) return Clutter.EVENT_STOP; } catch (e) { }
        let dir = event.get_scroll_direction();
        let delta = 0;
        if (dir === Clutter.ScrollDirection.UP) delta = 0.05;
        else if (dir === Clutter.ScrollDirection.DOWN) delta = -0.05;
        else if (dir === Clutter.ScrollDirection.SMOOTH) delta = -event.get_scroll_delta()[1] * 0.05;
        if (delta !== 0) this._changed(this._value + delta, true);
        return Clutter.EVENT_STOP;
    }

    _onKey(event) {
        let key = event.get_key_symbol();
        if (key === Clutter.KEY_Right || key === Clutter.KEY_Up) { this._changed(this._value + 0.05, true); return Clutter.EVENT_STOP; }
        if (key === Clutter.KEY_Left || key === Clutter.KEY_Down) { this._changed(this._value - 0.05, true); return Clutter.EVENT_STOP; }
        return Clutter.EVENT_PROPAGATE;
    }
}

/* ------------------------------------------------------------------ */
/* Submenu (the panel that expands below a toggle or slider)           */
/* ------------------------------------------------------------------ */

class QSMenu {
    constructor(applet, title, iconNames) {
        this._applet = applet;
        this.owner = null;
        this.onOpen = null;
        this._headerChecked = false;

        this.actor = new St.BoxLayout({ vertical: true, style_class: 'gqs-submenu', x_expand: true, visible: false });

        let header = new St.BoxLayout({ style_class: 'gqs-submenu-header' });
        this._headerIcon = new St.Icon({ icon_size: 16, x_align: CENTER, y_align: CENTER, x_expand: true, y_expand: true });
        this._headerBin = align(fill(new St.Bin({ style_class: 'gqs-submenu-header-icon', child: this._headerIcon })), CENTER, CENTER);
        let titles = new St.BoxLayout({ vertical: true, y_align: CENTER, x_expand: true });
        this._title = ellipsize(new St.Label({ style_class: 'gqs-submenu-title', text: title }));
        this._subtitle = ellipsize(new St.Label({ style_class: 'gqs-submenu-subtitle', text: '', visible: false }));
        titles.add_child(this._title);
        titles.add_child(this._subtitle);
        header.add_child(this._headerBin);
        header.add_child(titles);
        this.actor.add_child(header);

        this._scroll = new St.ScrollView({ style_class: 'gqs-submenu-scroll', x_expand: true });
        setScrollPolicy(this._scroll);
        this._items = new St.BoxLayout({ vertical: true, style_class: 'gqs-submenu-items', x_expand: true });
        setScrollChild(this._scroll, this._items);
        this.actor.add_child(this._scroll);

        this._footer = new St.BoxLayout({ vertical: true, style_class: 'gqs-submenu-footer', x_expand: true });
        this.actor.add_child(this._footer);

        this.setIcon(iconNames);
    }

    get isOpen() { return this.actor.visible; }

    setIcon(names) { if (names) setGicon(this._headerIcon, names); }

    setHeaderChecked(checked) {
        this._headerChecked = checked;
        this.repaint();
    }

    repaint() {
        if (this._headerChecked) this._headerBin.add_style_class_name('checked');
        else this._headerBin.remove_style_class_name('checked');
        this._applet.paintAccent(this._headerBin, this._headerChecked);
    }

    setSubtitle(text) {
        this._subtitle.text = text || '';
        this._subtitle.visible = !!text;
    }

    clear() {
        this._items.destroy_all_children();
    }

    addActor(actor) {
        this._items.add_child(actor);
    }

    addLabel(text) {
        let l = ellipsize(new St.Label({ style_class: 'gqs-submenu-status', text: text }));
        this._items.add_child(l);
        return l;
    }

    _makeItem(params) {
        let box = new St.BoxLayout({ style_class: 'gqs-submenu-item-box', x_expand: true });
        if (params.icon) {
            box.add_child(new St.Icon({ gicon: themedIcon(params.icon), icon_size: 16, style_class: 'gqs-submenu-item-icon', y_align: CENTER }));
        }
        let labels = new St.BoxLayout({ vertical: true, x_expand: true, y_align: CENTER });
        labels.add_child(ellipsize(new St.Label({ text: params.label, style_class: 'gqs-submenu-item-label' })));
        if (params.sublabel)
            labels.add_child(ellipsize(new St.Label({ text: params.sublabel, style_class: 'gqs-submenu-item-sublabel' })));
        box.add_child(labels);
        if (params.trailingIcon) {
            box.add_child(new St.Icon({ gicon: themedIcon(params.trailingIcon), icon_size: 16, style_class: 'gqs-submenu-item-trailing', y_align: CENTER }));
        }
        if (params.checked) {
            box.add_child(new St.Icon({ icon_name: 'object-select-symbolic', icon_size: 16, style_class: 'gqs-submenu-item-check', y_align: CENTER }));
        }
        let btn = fill(new St.Button({ style_class: 'gqs-submenu-item', child: box, x_expand: true, can_focus: true }));
        if (params.checked) btn.add_style_class_name('active');
        if (params.onActivate) btn.connect('clicked', () => params.onActivate());
        else btn.reactive = false;
        return btn;
    }

    addItem(params) {
        let item = this._makeItem(params);
        this._items.add_child(item);
        return item;
    }

    setFooter(items) {
        this._footer.destroy_all_children();
        if (!items || !items.length) return;
        this._footer.add_child(new St.Widget({ style_class: 'gqs-separator', x_expand: true }));
        for (let it of items) this._footer.add_child(this._makeItem(it));
    }
}

/* ------------------------------------------------------------------ */
/* Pill toggle                                                         */
/* ------------------------------------------------------------------ */

class QSToggle {
    constructor(applet, params) {
        this._applet = applet;
        this.id = params.id || params.title;
        // Every tile is always offered; when its hardware/connection is missing it shows as unavailable.
        this.shown = true;
        this.available = params.shown !== undefined ? !!params.shown : true;
        this._unavailText = params.unavailableText || _('Unavailable');
        this._onUnavailable = params.onUnavailable || null;
        this._sub = '';
        this.checked = false;

        this._onClicked = params.onClicked || null;
        this.actor = new St.BoxLayout({ style_class: 'gqs-toggle', x_expand: true });
        this.actor._gqsToggle = this;

        let content = new St.BoxLayout({ style_class: 'gqs-toggle-content', x_expand: true, y_align: CENTER });
        this._icon = new St.Icon({ style_class: 'gqs-toggle-icon', icon_size: 16, y_align: CENTER });
        let labels = new St.BoxLayout({ vertical: true, x_expand: true, y_align: CENTER, style_class: 'gqs-toggle-labels' });
        // A name that doesn't fit is split onto two lines at a space (see _splitTitle);
        // the status stays one line.
        this._titleText = params.title;
        this._title = ellipsize(new St.Label({ style_class: 'gqs-toggle-title', text: params.title }));
        this._subtitle = ellipsize(new St.Label({ style_class: 'gqs-toggle-subtitle', text: '', visible: false }));
        labels.add_child(this._title);
        labels.add_child(this._subtitle);
        content.add_child(this._icon);
        content.add_child(labels);
        // Re-split the name whenever the space for it changes (columns, tile style, …).
        labels.connect('notify::width', () => this._queueSplit());
        this._content = content;
        this._labels = labels;
        this._tileStyle = 'long';

        this._main = fill(new St.Button({
            style_class: 'gqs-toggle-main', child: content,
            x_expand: true, y_expand: true, can_focus: true,
        }));
        this._main.connect('clicked', () => {
            if (applet.guardClick()) return;
            this.activate();
        });
        this._main.connect('notify::hover', () => this.repaint());
        // Right-click opens the tile's menu (the only way in round/small styles, which have no arrow).
        this._main.connect('button-release-event', (a, e) => {
            if (e.get_button() !== 3 || !this.menu || applet._editing) return Clutter.EVENT_PROPAGATE;
            applet.toggleSubmenu(this.menu);
            return Clutter.EVENT_STOP;
        });
        this.actor.add_child(this._main);

        this.menu = null;
        this._arrow = null;
        if (params.menu) {
            this.actor.add_style_class_name('has-menu');
            this._arrowIcon = new St.Icon({ icon_name: 'go-next-symbolic', icon_size: 16, x_align: CENTER, y_align: CENTER, x_expand: true });
            this._arrow = fill(new St.Button({ style_class: 'gqs-toggle-arrow', child: this._arrowIcon, can_focus: true, y_expand: true }));
            this._arrow.connect('clicked', () => applet.toggleSubmenu(this.menu));
            this._arrow.connect('notify::hover', () => this.repaint());
            this.actor.add_child(this._arrow);

            this.menu = new QSMenu(applet, params.menuTitle || params.title, params.icon);
            this.menu.owner = this;
            this.menu.onOpen = params.onMenuOpen || null;
        }
        this.setIcon(params.icon);
        this._paintAvailable();
    }

    setIcon(names) {
        if (!names) return;
        this.iconNames = names;
        setGicon(this._icon, names);
        if (this.menu) this.menu.setIcon(names);
        this._applet.queueCompactSync();
    }

    get title() { return this._titleText || this._title.text; }

    // Same as clicking the tile (used by the round buttons in the compact row).
    activate() {
        if (!this.available) { if (this._onUnavailable) this._onUnavailable(this); return; }
        if (this._onClicked) this._onClicked(this);
    }

    setTitle(text) {
        this._titleText = text || '';
        setText(this._title, this._titleText);
        this._queueSplit();
    }

    setSubtitle(text) {
        this._sub = text || '';
        let shown = this.available ? this._sub : this._unavailText;
        setText(this._subtitle, shown);
        this._subtitle.visible = !!shown && (!this._tileStyle || this._tileStyle === 'long') && this._showLabels !== false;
    }

    // Hardware/connection present? Unavailable tiles stay on the grid, dimmed and switched off.
    setAvailable(avail, reason) {
        avail = !!avail;
        if (reason) this._unavailText = reason;
        if (this.available === avail) { this.setSubtitle(this._sub); return; }
        this.available = avail;
        this._paintAvailable();
        this.setSubtitle(this._sub);
        this.setChecked(this._rawChecked);   // unavailable shows as off; real state returns when it's back
        this._applet.queueCompactSync();
    }

    _paintAvailable() {
        if (this.available) this.actor.remove_style_class_name('unavailable');
        else this.actor.add_style_class_name('unavailable');
        this.setSubtitle(this._sub);
    }

    setChecked(checked) {
        this._rawChecked = !!checked;
        this.checked = !!checked && this.available;
        if (this.checked) this.actor.add_style_class_name('checked');
        else this.actor.remove_style_class_name('checked');
        if (this.menu) this.menu.setHeaderChecked(this.checked);
        this.repaint();
        this._applet.queueCompactSync();
    }

    repaint() {
        this._applet.paintAccent(this._main, this.checked);
        // The tab under a round button stays plain; elsewhere the arrow shares the tile's colour.
        if (this._arrow) this._applet.paintAccent(this._arrow, this.checked && this._tileStyle !== 'round');
        if (this.menu) this.menu.repaint();
    }

    // Kept for the device code: "not shown" now means "unavailable", never removed from the grid.
    setShown(shown) {
        this.setAvailable(shown);
    }

    setMenuOpen(open) {
        if (this._arrowIcon) this._applet.rotateArrow(this._arrowIcon, open);
    }

    _queueSplit() {
        if (this._splitQueued) return;
        this._splitQueued = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._splitQueued = 0;
            this._splitTitle();
            return GLib.SOURCE_REMOVE;
        });
    }

    /* Names that don't fit on one line go onto two lines, broken at a space, with a real line
       break: the tile then knows it's two lines tall and centres both next to the icon.
       (Automatic wrapping isn't measured properly inside a row of icon + text.) */
    _splitTitle() {
        let text = this._titleText || '';
        let room = this._labels.width;
        let out = text;
        if (room > 0 && text.includes(' ')) {
            let measure = str => {
                try {
                    let layout = this._title.clutter_text.get_layout().copy();
                    layout.set_width(-1);
                    layout.set_ellipsize(Pango.EllipsizeMode.NONE);
                    layout.set_text(str, -1);
                    return layout.get_pixel_size()[0];
                } catch (e) { return 0; }
            };
            if (measure(text) > room) {
                // Fill the first line with as many words as fit; the rest go on the second line.
                let words = text.split(' ');
                let first = words[0];
                let i = 1;
                for (; i < words.length; i++) {
                    let tryLine = first + ' ' + words[i];
                    if (measure(tryLine) > room) break;
                    first = tryLine;
                }
                if (i < words.length) out = first + '\n' + words.slice(i).join(' ');
            }
        }
        if (this._title.text !== out) this._title.text = out;
    }

    /* Tile style: 'long' (GNOME: icon + name + status, arrow for the menu),
       'round' (icon-only round buttons, like the compact row; name in a tooltip),
       'small' (icon above a short name). Round and small open their menu with right-click. */
    setTileStyle(style, showLabels = true) {
        if (this._tileStyle === style && this._showLabels === showLabels) return;
        this._tileStyle = style;
        this._showLabels = showLabels;
        let long = style === 'long';
        let labels = style !== 'round' && showLabels;
        this._labels.visible = labels;
        this._subtitle.opacity = long ? 255 : 0;
        this._subtitle.visible = long && !!this._subtitle.text;
        this._content.vertical = style === 'small';
        // Small tiles: the name takes the tile's full width and wraps onto the next line,
        // centred line by line (centring the label itself would let it grow past the tile).
        let fillWidth = long || style === 'small';
        this._content.x_align = fillWidth && labels ? Clutter.ActorAlign.FILL : CENTER;
        this._labels.x_align = Clutter.ActorAlign.FILL;
        this._labels.x_expand = true;
        this._icon.y_align = CENTER;
        this._icon.x_align = long && labels ? Clutter.ActorAlign.START : CENTER;
        // Small tiles: every line of the name centred under the icon.
        try {
            this._title.clutter_text.line_alignment = long ? Pango.Alignment.LEFT : Pango.Alignment.CENTER;
            this._title.clutter_text.x_align = long ? Clutter.ActorAlign.START : CENTER;
        } catch (e) { }
        if (long) this._title.remove_style_class_name('gqs-centered');
        else this._title.add_style_class_name('gqs-centered');
        this._title.x_align = Clutter.ActorAlign.FILL;
        this._icon.icon_size = style === 'round' ? 20 : (style === 'small' ? 20 : 16);
        // Long and small tiles keep their arrow on the right; round buttons have none
        // (right-click opens their menu) and stay full circles.
        let round = style === 'round';
        if (this._arrow) this._arrow.visible = !round;
        this.actor.vertical = round;
        if (this.menu) {
            if (round) this.actor.remove_style_class_name('has-menu');
            else this.actor.add_style_class_name('has-menu');
        }
        // Round buttons stay round: a fixed square centred in their cell (arrow tab below it).
        this._main.x_expand = !round;
        this._main.y_expand = !round;
        this.actor.x_align = round ? CENTER : Clutter.ActorAlign.FILL;
        this.actor.y_align = round ? Clutter.ActorAlign.START : Clutter.ActorAlign.FILL;
        if (this._arrow) {
            this._arrow.x_expand = false;
            this._arrow.y_expand = !round;
            this._arrow.x_align = round ? CENTER : Clutter.ActorAlign.FILL;
        }
        this.repaint();
        // No name on the tile: show it when hovering instead.
        if (!labels && !this._tooltip) {
            try { this._tooltip = new imports.ui.tooltips.Tooltip(this._main, this.title); } catch (e) { }
        }
        if (this._tooltip) {
            try { this._tooltip.set_text(this.title); } catch (e) { }
            this._tooltip.preventShow = labels;
        }
    }
}

/* ------------------------------------------------------------------ */
/* The applet                                                          */
/* ------------------------------------------------------------------ */

// Shown on a fresh install (like GNOME); every other tile starts in the hidden tiles.
const DEFAULT_SHOWN_TILES = ['Wi-Fi', 'Bluetooth', 'Power Mode', 'Night Light', 'Dark Style', 'Do Not Disturb'];

const SETTING_KEYS = [
    'toggle-layout', 'slider-volume', 'output-picker', 'slider-brightness', 'mic-slider', 'input-picker',
    'show-battery-pill', 'show-screenshot', 'show-settings', 'show-lock', 'show-power', 'show-customize', 'show-media-card',
    'panel-network', 'panel-volume', 'panel-battery', 'panel-battery-style', 'panel-battery-percent-mode', 'panel-battery-time', 'panel-bluetooth',
    'panel-nightlight', 'panel-airplane', 'panel-dnd', 'panel-caffeine', 'panel-mic', 'panel-camera', 'panel-scroll-volume',
    'card-style', 'accent-color', 'columns', 'animation-speed', 'refresh-rate-remember', 'refresh-rate-memory', 'refresh-rate-verified', 'kbd-rgb-state', 'show-notifications', 'notifications-expanded', 'notifications-position', 'media-expanded', 'show-configure', 'rows-per-page', 'keep-page-height', 'bt-at-login', 'bt-last-powered', 'style-system-wide', 'panel-net-speed', 'panel-net-speed-show',
    'panel-scroll-touchpad', 'scroll-volume-slider', 'scroll-mic-slider', 'scroll-brightness-slider',
    'custom-tiles', 'custom-tiles-state', 'notif-compact', 'kbd-at-login', 'kbd-last-level', 'button-shape', 'tile-style', 'tile-labels',
];

const SETTING_DEFAULTS = {
    'slider-volume': true, 'output-picker': true, 'slider-brightness': true, 'mic-slider': 'recording', 'input-picker': true,
    'show-battery-pill': true, 'show-screenshot': true, 'show-settings': true, 'show-lock': true, 'show-power': true, 'show-customize': true,
    'show-media-card': true, 'panel-network': true, 'panel-volume': true, 'panel-battery': true,
    'panel-battery-style': 'system', 'panel-battery-percent-mode': 'off', 'panel-battery-time': 'off', 'panel-bluetooth': true, 'panel-nightlight': true, 'panel-airplane': true,
    'panel-dnd': true, 'panel-caffeine': true, 'panel-mic': true, 'panel-camera': true, 'panel-scroll-volume': true,
    'card-style': 'dark', 'accent-color': 'rgb(53,132,228)', 'columns': 2, 'animation-speed': 'normal', 'refresh-rate-remember': true, 'refresh-rate-memory': {}, 'refresh-rate-verified': {}, 'kbd-rgb-state': {}, 'show-notifications': true, 'notifications-expanded': false, 'notifications-position': 'bottom', 'media-expanded': false, 'show-configure': true, 'rows-per-page': 4, 'keep-page-height': true, 'bt-at-login': 'remember', 'bt-last-powered': null, 'style-system-wide': false, 'panel-net-speed': false, 'panel-net-speed-show': 'both', 'panel-scroll-touchpad': true, 'scroll-volume-slider': 'both', 'scroll-mic-slider': 'both', 'scroll-brightness-slider': 'both', 'custom-tiles': [], 'custom-tiles-state': {}, 'notif-compact': true, 'kbd-at-login': 'remember', 'kbd-last-level': null, 'button-shape': 'pill', 'tile-style': 'long', 'tile-labels': true,
};

class GnomeQuickSettingsApplet extends Applet.Applet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this.metadata = metadata;
        this._signals = [];
        this._sources = {};
        this._openMenu = null;
        this._toggles = [];
        this._toggleById = {};
        this._sliders = [];
        this._panelState = {};
        this._avail = {};
        this._accent = { base: DEFAULT_ACCENT, hover: mixColor(DEFAULT_ACCENT, [255, 255, 255], 0.12) };

        try { this.set_applet_tooltip(_('LMQS')); } catch (e) { }

        this._initSettings(instanceId);
        this._buildPanel(orientation);

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        // Make every theme-styled wrapper around our content transparent;
        // the GNOME-style card itself is painted by .gqs-main.
        this.menu.actor.add_style_class_name('gqs-chrome');
        this.menu.box.add_style_class_name('gqs-chrome');
        try {
            let a = this.menu.box.get_parent();
            while (a && a !== this.menu.actor) { a.add_style_class_name('gqs-chrome'); a = a.get_parent(); }
        } catch (e) { }

        this._buildMenu();
        this._customToggles = [];
        this._syncCustomTiles();
        this._wrapContent();
        this._migrateLayout();
        this._watchSettingsFile();

        this.menu.connect('open-state-changed', (m, open) => {
            if (open) {
                this.actor.add_style_class_name('gqs-open');
                this.closeSubmenu(true);
                this._fitToScreen();
                if (this._previewReopen) this._previewReopen = false;
                else this._animateMenuIn();
                // Refresh after the animation so it doesn't fight it for frames.
                this._queue('opensync', this._afterAnim(220), () => { if (this.menu.isOpen) this._onMenuOpened(); });
            }
            else {
                this.actor.remove_style_class_name('gqs-open');
                this.closeSubmenu(true);
                this._resetMenuAnim();
                if (this._previewing && !this._endingPreview && !this._previewPaused) { this._keepPreviewOpen(); return; }
                if (this._editing && !this._editDialog) this._requestExitEdit('menu-closed');
            }
        });

        this._initBackends();
        this._applySettings();
    }

    /* ---------- settings ---------- */

    _initSettings(instanceId) {
        this._cfgValues = {};
        try {
            this.settings = new Settings.AppletSettings(this, this.metadata.uuid, instanceId);
            for (let key of SETTING_KEYS) {
                let prop = '_cfg_' + key.replace(/-/g, '_');
                this.settings.bind(key, prop, () => {
                    (this._changedKeys = this._changedKeys || new Set()).add(key);
                    this._queue('settings', 80, () => {
                        let keys = [...(this._changedKeys || [])];
                        this._changedKeys = null;
                        if (!keys.length) return;   // already applied by the settings-file sync
                        if (this._syncingFromFile) { this._applySettings(); return; }
                        this._applySettingsAnimated(keys);
                    });
                });
            }
        } catch (e) {
            global.logError('[gqs] settings: ' + e);
            this.settings = null;
        }
    }

    /* Changes from Quick Settings' own settings window arrive as edits to Cinnamon's settings
       file. Cinnamon doesn't notice those, so watch the file, apply new values right away and
       update Cinnamon's in-memory copy (otherwise its next save would write the old values back). */
    _watchSettingsFile() {
        let file = null;
        try { file = this.settings && this.settings.file; } catch (e) { file = null; }
        if (!file) return;
        try {
            this._settingsMonitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._connect(this._settingsMonitor, 'changed', (m, f, other, event) => {
                if (event === Gio.FileMonitorEvent.DELETED) return;
                this._queue('settings-file', 250, () => this._syncFromSettingsFile());
            });
        } catch (e) { global.logError('[gqs] watch settings file: ' + e); }
    }

    _syncFromSettingsFile() {
        let path = null;
        try { path = this.settings.file.get_path(); } catch (e) { return; }
        let data;
        try { data = JSON.parse(readFile(path) || '{}'); } catch (e) { return; }   // mid-write; next event retries
        let changed = [];
        for (let key of SETTING_KEYS) {
            let entry = data[key];
            if (!entry || typeof entry !== 'object' || !('value' in entry)) continue;
            let prop = '_cfg_' + key.replace(/-/g, '_');
            if (JSON.stringify(this[prop]) === JSON.stringify(entry.value)) continue;
            this[prop] = entry.value;
            changed.push(key);
            this._syncingFromFile = true;
            try { this.settings.setValue(key, entry.value); } catch (e) { }
            this._syncingFromFile = false;
        }
        if (!changed.length) return;
        global.log(`[gqs] settings changed: ${changed.join(', ')}`);
        this._changedKeys = null;   // already handled here
        if (this._previewing && this._previewPaused && !this._pausedByMinimize) { this._resumePreview(); this._applySettings(); return; }
        if (this._previewing && this._previewPaused) { this._applySettings(); return; }
        this._applySettingsAnimated(changed);
    }

    /* A change made in the settings window animates in the open (preview) card.
       Kept cheap so it stays smooth: only the card's contents fade (the card background
       just takes its new size), the contents are drawn once into an offscreen buffer and
       that buffer is faded (instead of redrawing every tile each frame), and the heavy
       re-layout happens while they're invisible, with a frame to finish before fading in. */
    _applySettingsAnimated(keys) {
        if ((keys || []).some(k => k === 'card-style' || k === 'style-system-wide')) this._pushStyleToSystem();
        const QUIET = ['refresh-rate-memory', 'refresh-rate-verified', 'kbd-rgb-state', 'kbd-last-level', 'notifications-expanded',
            'media-expanded', 'bt-last-powered'];
        keys = (keys || []).filter(k => !QUIET.includes(k));
        if (!keys.length || !this.menu.isOpen || !this._animFactor() || this._editing || !this._shell) { this._applySettings(); return; }
        if (this._cfgAnim) { this._cfgAnimAgain = true; return; }
        this._cfgAnim = true;
        const LOOK = ['accent-color', 'card-style', 'animation-speed', 'button-shape'];
        let layout = keys.some(k => !LOOK.includes(k));
        let a = this._shell;
        // Draw live during the fade (no cached snapshot): a snapshot taken before the new layout
        // settled could show tiles on top of each other until the fade ended.
        let redirect = () => { };
        let fadeIn = () => {
            redirect(true);
            a.opacity = 0;
            a.translation_y = layout ? 6 : 0;
            this._ease(a, { opacity: 255, translation_y: 0 }, layout ? 160 : 120, () => {
                redirect(false);
                this._cfgAnim = false;
                if (this._cfgAnimAgain) { this._cfgAnimAgain = false; this._applySettingsAnimated(['columns']); }
            }, Clutter.AnimationMode.EASE_OUT_QUAD);
        };
        redirect(true);
        this._ease(a, { opacity: 0 }, layout ? 90 : 70, () => {
            redirect(false);
            this._cfgAnimAgain = false;   // this apply picks up everything changed so far
            this._applySettings();
            // Let the new layout settle (tile sizes, scrolling, hidden tiles) before fading back in.
            this._queue('cfg-anim-in', 140, fadeIn);
        }, Clutter.AnimationMode.EASE_IN_QUAD);
    }

    // Saved toggle lists from older versions don't know about newer toggles.
    // Add the missing rows so they can be hidden and reordered in Configure.
    _migrateLayout() {
        if (!this.settings) return;
        try {
            let list = this.settings.getValue('toggle-layout');
            if (!Array.isArray(list) || !list.length) return;
            let known = new Set(list.map(r => r && String(r.item || '').trim()));
            // Tiles new to a saved layout start in the hidden tiles; add them with the pencil button.
            let missing = this._toggles.filter(t => !known.has(t.id) && !t.id.startsWith('custom:'))
                .map(t => ({ item: t.id, show: DEFAULT_SHOWN_TILES.includes(t.id) }));
            if (missing.length) this.settings.setValue('toggle-layout', list.concat(missing));
        } catch (e) { global.logError('[gqs] layout migration: ' + e); }
    }

    cfg(key) {
        let v = this['_cfg_' + key.replace(/-/g, '_')];
        return (v === undefined || v === null) ? SETTING_DEFAULTS[key] : v;
    }

    _applySettings() {
        this._syncCustomTiles();
        this._applyCardStyle();
        this._applyShape();
        this._applyTileStyle();
        if (this._animFactor()) this._main.remove_style_class_name('gqs-no-anim');
        else this._main.add_style_class_name('gqs-no-anim');

        let cols = Math.max(1, Math.min(5, parseInt(this.cfg('columns')) || 2));
        this._columns = cols;
        // Card width per column count; 1 and 2 columns keep GNOME's width.
        const WIDTHS = { 1: 376, 2: 376, 3: 552, 4: 708, 5: 868 };
        this._contentWidth = WIDTHS[cols];
        // St treats "width" as a minimum, so pin min and max too: the column count decides the
        // width in both designs, and long text gets "…" instead of stretching the menu.
        let w = WIDTHS[cols];
        this._content.set_style(`width: ${w}px; min-width: ${w}px; max-width: ${w}px;`);
        this._placeNotifications();
        if (cols >= 4) this._main.add_style_class_name('gqs-compact');
        else this._main.remove_style_class_name('gqs-compact');

        // top row
        this._batteryPill.visible = !!this._avail.battery && this.cfg('show-battery-pill');
        if (this._shotButton) this._shotButton.visible = this.cfg('show-screenshot');
        this._settingsButton.visible = this.cfg('show-settings');
        this._customizeButton.visible = this.cfg('show-customize');
        this._configButton.visible = this.cfg('show-configure');
        this._fitTopRow();
        this._addTooltips();
        this._lockButton.visible = this.cfg('show-lock');
        this._powerButton.visible = this.cfg('show-power');

        for (let t of this._toggles) t.repaint();
        this._powerMenu.repaint();
        this._volumeMenu.repaint();
        this._micMenu.repaint();
        this._paintPowerButton();

        this._updateRows();
        this._refreshPanel();
        this._relayout();
        // Shape, rows per page or columns change the card's height: re-decide whether it needs
        // to scroll once the new layout has settled, so nothing gets squeezed on top of each other.
        this._trayRowH = 0; this._trayFullH = 0;
        for (let ms of [0, 200, 500]) this._queue('rescroll-' + ms, ms + 1, () => {
            for (let sv of [this._qsScroll, this._notif && this._notif.scroll]) if (sv && sv._gqsQueueCheck) sv._gqsQueueCheck();
        });
    }

    // Button shape: one class on the card switches the corner rounding of every button.
    _applyShape() {
        let shape = this.cfg('button-shape');
        if (shape === 'circle') shape = 'pill';   // earlier name for the GNOME look
        const SHAPES = ['pill', 'square', 'squircle', 'teardrop', 'rhombus', 'window'];
        if (!SHAPES.includes(shape)) shape = 'pill';
        for (let x of ['circle'].concat(SHAPES)) {
            if (x === shape) this._main.add_style_class_name('gqs-shape-' + x);
            else this._main.remove_style_class_name('gqs-shape-' + x);
        }
        this._shape = shape;
    }

    // Light/dark card and the accent colours that go with it.
    _applyCardStyle() {
        let style = this.cfg('card-style');
        let light = style === 'light' || (style === 'system' && !this._isDark());
        this._light = light;
        if (light) this._main.add_style_class_name('gqs-light');
        else this._main.remove_style_class_name('gqs-light');

        let accent = parseColor(this.cfg('accent-color'));
        let darkText = needsDarkText(accent);
        this._accent = {
            base: accent,
            // light accents get darker on hover, dark accents get lighter
            hover: darkText ? mixColor(accent, [0, 0, 0], 0.1) : mixColor(accent, [255, 255, 255], 0.12),
        };
        if (darkText) this._main.add_style_class_name('gqs-accent-light');
        else this._main.remove_style_class_name('gqs-accent-light');

        for (let sl of this._sliders) sl.setLook(this._accent.base, light);
        if (this._toggles) for (let t of this._toggles) t.repaint();
        if (this._powerMenu) { this._powerMenu.repaint(); this._volumeMenu.repaint(); this._micMenu.repaint(); }
        if (this._dots) this.paintAccentDots();
        this.queueCompactSync();
    }

    paintAccent(actor, on) {
        if (!actor) return;
        let style = null;
        if (on) style = `background-color: ${cssColor(actor.hover ? this._accent.hover : this._accent.base)};`;
        if (actor._gqsStyle === style) return;   // restyling is costly; skip if unchanged
        actor._gqsStyle = style;
        actor.set_style(style);
    }

    _paintPowerButton() {
        let on = this._openMenu === this._powerMenu;
        if (on) this._powerButton.add_style_class_name('checked');
        else this._powerButton.remove_style_class_name('checked');
        this.paintAccent(this._powerButton, on);
    }

    /* ---------- bookkeeping ---------- */

    _connect(obj, signal, fn) {
        let id = obj.connect(signal, fn);
        this._signals.push([obj, id]);
        return id;
    }

    _queue(key, ms, fn) {
        if (this._sources[key]) return;
        this._sources[key] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            delete this._sources[key];
            try { fn(); } catch (e) { global.logError('[gqs] ' + e); }
            return GLib.SOURCE_REMOVE;
        });
    }

    _launch(argv) {
        this.menu.close();
        if (SETTINGS_APPS.includes(argv[0])) this._launchSingle(argv);
        else launch(argv);
    }

    /* ---------- one window per settings page ---------- */

    _allWindows() {
        try { return global.get_window_actors().map(a => a.get_meta_window()).filter(w => !!w); }
        catch (e) { return []; }
    }

    _focusWindow(win) {
        try { Main.activateWindow(win); return; } catch (e) { }
        try {
            let ws = win.get_workspace();
            if (ws) ws.activate_with_focus(win, global.get_current_time());
            else win.activate(global.get_current_time());
        } catch (e) { global.logError('[gqs] focus: ' + e); }
    }

    // A settings window we can reuse: the one our own launch opened (by process id), or for
    // apps that only ever have one main window, any window of that app.
    _findSettingsWindow(argv, entry) {
        let wins = this._allWindows();
        if (entry && entry.pid) {
            let w = wins.find(w => { try { return w.get_pid() === entry.pid; } catch (e) { return false; } });
            if (w) return w;
        }
        let app = argv[0];
        if (app === 'python3' && argv[1] && argv[1].endsWith('/gqs-settings')) app = 'gqs-settings';
        let byClass = w => {
            let cls = '';
            try { cls = ((w.get_wm_class() || '') + ' ' + (w.get_wm_class_instance() || '')).toLowerCase(); } catch (e) { }
            return cls.includes(app);
        };
        if (app === 'xlet-settings') {
            let name = (this.metadata.name || '').toLowerCase();
            return wins.find(w => byClass(w) && (w.get_title() || '').toLowerCase().includes(name)) || null;
        }
        if (app === 'blueman-manager' || app === 'nm-connection-editor' || app === 'gqs-settings') return wins.find(byClass) || null;
        return null;
    }

    _launchSingle(argv) {
        let key = argv.join(' ');
        this._launched = this._launched || {};
        let entry = this._launched[key];

        let isSettings = this._isSettingsArgv(argv);
        let win = this._findSettingsWindow(argv, entry);
        if (win) { this._focusWindow(win); if (isSettings) this._startPreview(); return; }
        // Still starting up (window not shown yet): don't open a second copy.
        if (entry && entry.running) return;

        try {
            let proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
            let pid = parseInt(proc.get_identifier()) || 0;
            let e = { pid, running: true };
            this._launched[key] = e;
            let started = GLib.get_monotonic_time();
            if (isSettings) this._startPreview();
            proc.wait_async(null, () => {
                e.running = false;
                // A second copy hands over to the open window and exits at once, so don't end the
                // preview on exit alone: check whether a settings window is still there.
                if (isSettings) this._queue('preview-check', 400, () => this._checkPreview(true));
                if (argv[1] && argv[1].endsWith('/gqs-settings') && GLib.get_monotonic_time() - started < 3e6 && !proc.get_successful()) {
                    global.logError('[gqs] own settings window could not start; using Cinnamon\'s');
                    this._ownSettingsFailed = true;
                    this._openClassicConfigure();
                }
                if (this._launched[key] === e) delete this._launched[key];
            });
        } catch (err) {
            global.logError('[gqs] launch: ' + err);
            launch(argv);
        }
    }

    _isSettingsArgv(argv) {
        return (argv[1] && argv[1].endsWith('/gqs-settings')) ||
            (argv[0] === 'xlet-settings' && argv.includes(this.metadata.uuid)) ||
            (argv[0] === 'cinnamon-settings' && argv.includes(this.metadata.uuid));
    }

    /* Live preview: while the settings window is open, Quick Settings stays open ("pinned").
       Taking the menu out of the menu manager removes the grab, so clicking in the settings
       window doesn't close it; it's put back when the settings window closes. */
    _startPreview() {
        this._previewPaused = false;
        this._pausedByMinimize = false;
        if (!this._focusWatch) {
            try { this._focusWatch = this._connect(global.display, 'notify::focus-window', () => this._onFocusWindow()); }
            catch (e) { this._focusWatch = 0; }
        }
        this._previewSeenWindow = false;
        this._previewSince = GLib.get_monotonic_time();
        this._previewMisses = 0;
        if (!this._previewWatch) {
            // Follow the settings window itself: the preview ends only once it's really gone.
            this._previewWatch = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
                this._checkPreview(false);
                return this._previewWatch ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
            });
        }
        if (this._previewing) { this._keepPreviewOpen(); return; }
        this._previewing = true;
        // Let the normal close finish (it releases Cinnamon's input grab), then re-open pinned.
        this._queue('preview', 200, () => {
            if (!this._previewing) return;
            try { this.menuManager.removeMenu(this.menu); } catch (e) { }
            this._main.add_style_class_name('gqs-preview');
            if (!this.menu.isOpen) this.menu.open(false);
            // Without the grab, clicks would fall through to windows below: make it part of the
            // shell's input region so the preview stays clickable.
            if (!this._previewTracked) {
                try { Main.layoutManager.trackChrome(this.menu.actor, { affectsInputRegion: true }); this._previewTracked = true; }
                catch (e) { this._previewTracked = false; }
            }
        });
    }

    // Hidden with the panel button? Show it again when the settings window gets focus.
    _onFocusWindow() {
        if (!this._previewing || !this._previewPaused) return;
        let w = null;
        try { w = global.display.focus_window; } catch (e) { }
        if (w && this._isSettingsWindow(w)) this._resumePreview();
    }

    // The settings window usually still has focus after the panel click, so focus changes alone
    // would miss "clicking back into it": watch for a mouse press inside it while hidden.
    _watchSettingsClicks() {
        if (this._clickWatch) return;
        let wasDown = true;   // ignore the press that hid it
        this._clickWatch = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            if (!this._previewing || !this._previewPaused) { this._clickWatch = 0; return GLib.SOURCE_REMOVE; }
            let x, y, mods;
            try { [x, y, mods] = global.get_pointer(); } catch (e) { return GLib.SOURCE_CONTINUE; }
            let down = !!(mods & (Clutter.ModifierType.BUTTON1_MASK | Clutter.ModifierType.BUTTON2_MASK | Clutter.ModifierType.BUTTON3_MASK));
            if (down && !wasDown) {
                let hit = this._allWindows().some(w => {
                    if (!this._isSettingsWindow(w)) return false;
                    try {
                        if (w.minimized) return false;
                        let r = w.get_frame_rect();
                        return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
                    } catch (e) { return false; }
                });
                if (hit) { this._clickWatch = 0; this._resumePreview(); return GLib.SOURCE_REMOVE; }
            }
            wasDown = down;
            return GLib.SOURCE_CONTINUE;
        });
    }

    _pausePreview() {
        this._previewPaused = true;
        if (!this.menu.isOpen) return;
        if (this._animFactor()) this._animateMenuOut(() => this.menu.close(false));
        else this.menu.close(false);
    }

    /* Minimizing the settings window hides the preview; restoring it brings it back. */
    _hookSettingsWindows() {
        this._hookedWins = this._hookedWins || new Map();
        for (let w of this._allWindows()) {
            if (this._hookedWins.has(w) || !this._isSettingsWindow(w)) continue;
            try {
                let ids = [
                    w.connect('notify::minimized', () => this._onSettingsMinimized()),
                    // Settings window closed: follow it straight away, while its own close animation plays.
                    w.connect('unmanaged', () => { this._unhookWindow(w); this._queue('preview-check', 30, () => this._checkPreview(true)); }),
                ];
                this._hookedWins.set(w, ids);
            } catch (e) { }
        }
    }

    _unhookWindow(w) {
        let ids = this._hookedWins && this._hookedWins.get(w);
        if (!ids) return;
        for (let id of ids) { try { w.disconnect(id); } catch (e) { } }
        this._hookedWins.delete(w);
    }

    _unhookSettingsWindows() {
        if (!this._hookedWins) return;
        for (let w of [...this._hookedWins.keys()]) this._unhookWindow(w);
    }

    // All settings windows minimized?
    _settingsAllMinimized() {
        let wins = this._allWindows().filter(w => this._isSettingsWindow(w));
        return wins.length > 0 && wins.every(w => { try { return w.minimized; } catch (e) { return false; } });
    }

    _minimizeSettingsWindows() {
        for (let w of this._allWindows()) {
            if (!this._isSettingsWindow(w)) continue;
            try { if (!w.minimized) w.minimize(); } catch (e) { }
        }
    }

    // Un-minimize the settings window(s) back to how they were (maximized stays maximized).
    _restoreSettingsWindows() {
        let wins = this._allWindows().filter(w => this._isSettingsWindow(w));
        for (let w of wins) {
            try { if (w.minimized) w.unminimize(); } catch (e) { }
        }
        // Give it focus too, so it's on top and ready to use.
        if (wins.length) this._focusWindow(wins[0]);
    }

    _onSettingsMinimized() {
        if (!this._previewing) return;
        if (this._settingsAllMinimized()) {
            this._pausedByMinimize = true;
            this._pausePreview();
        } else if (this._pausedByMinimize) {
            this._pausedByMinimize = false;
            this._resumePreview();
        }
    }

    _resumePreview() {
        if (!this._previewing) return;
        this._pausedByMinimize = false;
        if (this._clickWatch) { GLib.source_remove(this._clickWatch); this._clickWatch = 0; }
        this._previewPaused = false;
        if (!this.menu.isOpen) this.menu.open(false);   // opens with the normal animation
    }

    // Something closed the menu while the settings window is open: put it straight back.
    _keepPreviewOpen() {
        let now = GLib.get_monotonic_time();
        this._reopens = (this._reopens || []).filter(t => now - t < 3e6);
        this._reopens.push(now);
        if (this._reopens.length > 8) {   // something keeps closing it: give up instead of flickering
            global.logError('[gqs] preview keeps being closed; ending it');
            this._endPreview();
            return;
        }
        this._queue('preview-reopen', 120, () => {
            if (!this._previewing || this.menu.isOpen) return;
            this._previewReopen = true;
            this.menu.open(false);
        });
    }

    // Is a Quick Settings settings window (ours or Cinnamon's) open?
    _settingsWindowOpen() {
        return this._allWindows().some(w => this._isSettingsWindow(w));
    }

    _isSettingsWindow(w) {
        let name = (this.metadata.name || '').toLowerCase();
        let cls = '', title = '';
        try { cls = ((w.get_wm_class() || '') + ' ' + (w.get_wm_class_instance() || '')).toLowerCase(); } catch (e) { }
        try { title = (w.get_title() || '').toLowerCase(); } catch (e) { }
        if (cls.includes('gqs-settings')) return true;
        if (title.includes('quick settings') && (cls.includes('python') || cls.includes('gqs'))) return true;
        return !!(cls.includes('xlet-settings') && name && title.includes(name));
    }

    _checkPreview(processExited) {
        if (!this._previewing) { this._stopPreviewWatch(); return; }
        if (this._settingsWindowOpen()) {
            this._previewSeenWindow = true;
            this._previewMisses = 0;
            this._hookSettingsWindows();
            // Catch a minimize/restore the signal didn't report.
            let minimized = this._settingsAllMinimized();
            if (minimized && !this._previewPaused) { this._pausedByMinimize = true; this._pausePreview(); }
            else if (!minimized && this._pausedByMinimize) this._onSettingsMinimized();
            else if (!this.menu.isOpen && !this._previewPaused) this._keepPreviewOpen();
            return;
        }
        // Give a slow-starting window time to appear before deciding it's not coming.
        let age = (GLib.get_monotonic_time() - this._previewSince) / 1e6;
        if (!this._previewSeenWindow && age < 10 && !processExited) return;
        if (!this._previewSeenWindow && processExited && age < 10) {
            // Process gone and no window ever showed: nothing to preview against.
            if (age > 1.5) { this._endPreview(); }
            else this._queue('preview-check', 1500, () => this._checkPreview(true));
            return;
        }
        // The settings window was there and its process/window just went away: close now.
        if (this._previewSeenWindow && processExited) { this._endPreview(); return; }
        if (++this._previewMisses >= 2) this._endPreview();
    }

    _stopPreviewWatch() {
        if (this._previewWatch) { GLib.source_remove(this._previewWatch); this._previewWatch = 0; }
        if (this._clickWatch) { GLib.source_remove(this._clickWatch); this._clickWatch = 0; }
    }

    _endPreview() {
        this._stopPreviewWatch();
        if (!this._previewing) return;
        this._previewing = false;
        this._previewPaused = false;
        this._pausedByMinimize = false;
        this._unhookSettingsWindows();
        this._endingPreview = true;
        this._main.remove_style_class_name('gqs-preview');
        let finish = () => {
            if (this._previewTracked) {
                try { Main.layoutManager.untrackChrome(this.menu.actor); } catch (e) { }
                this._previewTracked = false;
            }
            if (this.menu.isOpen) this.menu.close(false);
            this._endingPreview = false;
            try { this.menuManager.addMenu(this.menu); } catch (e) { }
        };
        // Close the same way Quick Settings normally closes: a short fade and slide back toward
        // the panel, slightly softer and longer so it reads as following the settings window.
        if (this.menu.isOpen && this._animFactor() && this.menu.actor.mapped) {
            this.closeSubmenu(true);
            let [dx, dy] = this._menuSlide();
            // Shrink toward the panel the menu came from.
            let o = this._orientation;
            this._main.set_pivot_point(o === St.Side.LEFT ? 0 : o === St.Side.RIGHT ? 1 : 0.5,
                o === St.Side.BOTTOM ? 1 : o === St.Side.TOP ? 0 : 0.5);
            this._ease(this._main, { opacity: 0, translation_x: dx * 0.75, translation_y: dy * 0.75, scale_x: 0.97, scale_y: 0.97 },
                190, finish, Clutter.AnimationMode.EASE_OUT_QUAD);
        } else {
            finish();
        }
    }

    /* ---------- panel ---------- */

    _buildPanel(orientation) {
        this._panelBox = new St.BoxLayout({ style_class: 'gqs-panel-box', y_align: CENTER });
        this.actor.add_child(this._panelBox);
        // GNOME-style rounded "pill" highlight on hover / while open (see stylesheet).
        this.actor.add_style_class_name('gqs-panel-button');
        try { this.actor.track_hover = true; } catch (e) { }
        this._pIcons = {};
        for (let k of ['airplane', 'dnd', 'caffeine', 'camera', 'mic', 'network', 'bluetooth', 'nightlight', 'volume', 'battery']) {
            let i = new St.Icon({ style_class: 'applet-icon system-status-icon gqs-panel-icon', visible: false, y_align: CENTER });
            this._pIcons[k] = i;
            this._panelState[k] = { names: null, visible: false };
            if (k === 'network') {
                // Network icon + optional download/upload speed next to it.
                this._panelBox.add_child(i);
                this._netSpeedLabel = new St.Label({ style_class: 'applet-label gqs-panel-label gqs-net-speed', y_align: CENTER, visible: false, text: '' });
                noShrink(this._netSpeedLabel);
                this._panelBox.add_child(this._netSpeedLabel);
                continue;
            }
            if (k !== 'battery') { this._panelBox.add_child(i); continue; }

            // Battery: theme icon or a drawn icon, plus the percentage, packed tightly together.
            this._batBox = new St.BoxLayout({ style_class: 'gqs-panel-battery', y_align: CENTER, visible: false });
            this._batDraw = new St.DrawingArea({ style_class: 'gqs-battery-draw', y_align: CENTER, visible: false });
            this._batDraw.connect('repaint', a => this._drawBattery(a));
            this._batDraw.connect('style-changed', a => a.queue_repaint());
            this._batteryPercent = noShrink(new St.Label({ style_class: 'applet-label gqs-panel-label', y_align: CENTER, visible: false, text: '' }));
            this._batBox.add_child(i);
            this._batBox.add_child(this._batDraw);
            this._batBox.add_child(this._batteryPercent);
            // Time remaining ("3 h 25 min"), optional.
            this._batteryTime = noShrink(new St.Label({ style_class: 'applet-label gqs-panel-label gqs-battery-time', y_align: CENTER, visible: false, text: '' }));
            this._batBox.add_child(this._batteryTime);
            this._panelBox.add_child(this._batBox);
        }
        this._batState = { pct: 0, charging: false };

        this._updatePanelIconSize();
        this.on_orientation_changed(orientation);
        // Scroll over the panel icons = volume. Caught on the way in ("captured"), so it works
        // over any icon or label and nothing in the panel button can swallow it first.
        this.actor.reactive = true;
        this.actor.connect('captured-event', (a, e) => {
            if (e.type() !== Clutter.EventType.SCROLL) return Clutter.EVENT_PROPAGATE;
            return this._onPanelScroll(e);
        });
    }

    _updatePanelIconSize() {
        let size = 16;
        try { size = this.getPanelIconSize(St.IconType.SYMBOLIC); } catch (e) { }
        for (let k in this._pIcons) this._pIcons[k].icon_size = size;
        this._panelIconSize = size;
        if (this._batDraw) this._refreshPanelIcon('battery');
    }

    _setPanelIcon(key, names, visible) {
        let st = this._panelState[key];
        if (names) st.names = names;
        st.visible = !!visible;
        this._refreshPanelIcon(key);
    }

    _refreshPanelIcon(key) {
        let st = this._panelState[key];
        let icon = this._pIcons[key];
        if (st.names) setGicon(icon, st.names);
        let allowed = this.cfg('panel-' + key);
        if (allowed === undefined) allowed = true;
        icon.visible = !!(st.visible && allowed && st.names);
        if (key === 'battery') this._refreshBatteryPanel(!!(st.visible && allowed && st.names));
    }

    // Battery in the panel: icon style (system / horizontal / vertical / circle) and
    // percentage (off / beside the icon / inside the icon).
    _refreshBatteryPanel(shown) {
        let style = this.cfg('panel-battery-style');
        let mode = this.cfg('panel-battery-percent-mode');
        // "Inside the icon" isn't offered with the System icon: switch it to "Beside".
        if (mode === 'inside' && !['horizontal', 'vertical', 'circle'].includes(style)) {
            mode = 'outside';
            this._cfg_panel_battery_percent_mode = 'outside';
            if (this.settings) this._queue('fix-bat-mode', 0, () => {
                this._syncingFromFile = true;
                try { this.settings.setValue('panel-battery-percent-mode', 'outside'); } catch (e) { }
                this._syncingFromFile = false;
                this._changedKeys = null;
            });
        }
        let drawn = ['horizontal', 'vertical', 'circle'].includes(style);
        this._batStyle = drawn ? style : 'system';
        this._batInside = drawn && mode === 'inside';
        // The System icon only supports Hidden or Beside: "Inside" shows it beside instead.
        let besides = mode === 'outside' || (mode === 'inside' && !drawn);

        this._batBox.visible = shown;
        this._pIcons.battery.visible = shown && !drawn;
        this._batDraw.visible = shown && drawn;
        this._batteryPercent.visible = shown && besides && !!this._batteryPercent.text;
        let vertical = this._orientation === St.Side.LEFT || this._orientation === St.Side.RIGHT;
        let tm = this._batTimeMode();
        this._batteryTime.visible = shown && !vertical && (tm === 'panel' || tm === 'both') && !!this._batteryTime.text;

        if (drawn) {
            this._batDraw._gqsOpts = { style, inside: this._batInside };
            let [w, h] = this._batterySize(style, this._batInside, this._panelIconSize || 16);
            this._batDraw.set_size(w, h);
            this._batDraw.queue_repaint();
        }
        this._refreshBatteryPill();
    }

    _batterySize(style, inside, S) {
        let size = {
            horizontal: inside ? [S * 1.9, S * 0.95] : [S * 1.55, S * 0.8],
            vertical: inside ? [S * 0.95, S * 1.2] : [S * 0.62, S],
            circle: inside ? [S * 1.2, S * 1.2] : [S, S],
        }[style];
        return [Math.round(size[0]), Math.round(size[1])];
    }

    // The battery pill in the menu follows the same Battery icon / percentage settings.
    _refreshBatteryPill() {
        if (!this._pillDraw) return;
        let style = this.cfg('panel-battery-style');
        let mode = this.cfg('panel-battery-percent-mode');
        let drawn = ['horizontal', 'vertical', 'circle'].includes(style);
        let inside = drawn && mode === 'inside';
        let besides = mode === 'outside' || (mode === 'inside' && !drawn);

        this._batIcon.visible = !drawn;
        this._pillDraw.visible = drawn;
        this._batLabel.visible = besides && !!this._batLabel.text;
        let tm = this._batTimeMode();
        let timeIn = (tm === 'menu' || tm === 'both') && !!(this._batteryTime && this._batteryTime.text);
        this._batTimeLabel.text = timeIn ? this._batteryTime.text : '';
        this._batTimeLabel.visible = timeIn;
        if (timeIn && this._batLabel.visible) this._batTimeLabel.add_style_class_name('second-line');
        else this._batTimeLabel.remove_style_class_name('second-line');
        if (drawn) {
            this._pillDraw._gqsOpts = { style, inside };
            let [w, h] = this._batterySize(style, inside, 16);
            this._pillDraw.set_size(w, h);
            this._pillDraw.queue_repaint();
        }
        // Icon only (percentage hidden or drawn inside): make the pill a neat circle-ish button.
        if (besides || timeIn) this._batteryPill.remove_style_class_name('icon-only');
        else this._batteryPill.add_style_class_name('icon-only');
    }

    _drawBattery(area) {
        let cr = area.get_context();
        let [w, h] = area.get_surface_size();
        let fg = [1, 1, 1, 1];
        try {
            let c = area.get_theme_node().get_foreground_color();
            fg = [c.red / 255, c.green / 255, c.blue / 255, c.alpha / 255];
        } catch (e) { }
        let st = this._batState;
        let pct = Math.max(0, Math.min(100, st.pct));
        let level = pct / 100;
        // charging = green, low = red, otherwise the panel's text color
        let fill = st.charging ? [0.2, 0.82, 0.48] : (pct <= 15 ? [0.88, 0.11, 0.14] : fg.slice(0, 3));
        let text = String(Math.round(pct));
        let opts = area._gqsOpts || { style: this._batStyle, inside: this._batInside };
        let inside = opts.inside;

        let roundRect = (x, y, rw, rh, r) => {
            r = Math.max(0, Math.min(r, rw / 2, rh / 2));
            cr.newSubPath();
            cr.arc(x + rw - r, y + r, r, -Math.PI / 2, 0);
            cr.arc(x + rw - r, y + rh - r, r, 0, Math.PI / 2);
            cr.arc(x + r, y + rh - r, r, Math.PI / 2, Math.PI);
            cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
            cr.closePath();
        };

        // Centered text that fits a box; if a clip path is set by the caller,
        // the part over the fill is knocked out so it stays readable.
        let drawText = (cx, cy, boxW, boxH, fillPath) => {
            try {
                cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
                let size = boxH;
                cr.setFontSize(size);
                let ext = cr.textExtents(text);
                let scale = Math.min(1, (boxW * 0.92) / Math.max(1, ext.width), (boxH * 0.8) / Math.max(1, ext.height));
                cr.setFontSize(size * scale);
                ext = cr.textExtents(text);
                let tx = cx - (ext.width / 2 + ext.xBearing);
                let ty = cy - (ext.height / 2 + ext.yBearing);
                cr.setSourceRGBA(fg[0], fg[1], fg[2], fg[3]);
                cr.moveTo(tx, ty);
                cr.showText(text);
                if (fillPath) {
                    cr.save();
                    fillPath();
                    cr.clip();
                    cr.setOperator(Cairo.Operator.CLEAR);
                    cr.moveTo(tx, ty);
                    cr.showText(text);
                    cr.restore();
                }
            } catch (e) { }
        };

        let lw = Math.max(1, Math.round(Math.min(w, h) / 12));

        if (opts.style === 'circle') {
            let cx = w / 2, cy = h / 2;
            let ring = Math.max(2, Math.min(w, h) * (inside ? 0.11 : 0.16));
            let R = Math.min(w, h) / 2 - ring / 2 - 0.5;
            cr.setLineWidth(ring);
            cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.3);
            cr.arc(cx, cy, R, 0, 2 * Math.PI);
            cr.stroke();
            if (level > 0) {
                cr.setLineCap(Cairo.LineCap.ROUND);
                cr.setSourceRGBA(fill[0], fill[1], fill[2], 1);
                cr.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + level * 2 * Math.PI);
                cr.stroke();
            }
            if (inside) {
                let inner = (R - ring / 2) * 2;
                drawText(cx, cy, inner * 0.92, inner * 0.62, null);
            } else if (st.charging) {
                this._drawBolt(cr, cx, cy, R * 0.9, fg);
            }
        } else {
            let horizontal = opts.style === 'horizontal';
            let nub = Math.max(2, Math.round((horizontal ? w : h) * 0.08));
            let bx = lw / 2, by = lw / 2;
            let bw = (horizontal ? w - nub : w) - lw;
            let bh = (horizontal ? h : h - nub) - lw;
            if (!horizontal) by += nub;

            // nub
            cr.setSourceRGBA(fg[0], fg[1], fg[2], fg[3]);
            if (horizontal) roundRect(w - nub - 0.5, h * 0.3, nub, h * 0.4, nub / 2);
            else roundRect(w * 0.3, 0, w * 0.4, nub + 0.5, nub / 2);
            cr.fill();

            // body outline
            cr.setLineWidth(lw);
            cr.setSourceRGBA(fg[0], fg[1], fg[2], fg[3] * 0.9);
            roundRect(bx, by, bw, bh, Math.min(bw, bh) * 0.28);
            cr.stroke();

            // fill level
            let pad = lw + Math.max(1, Math.round(lw * 0.6));
            let ix = bx + pad - lw / 2, iy = by + pad - lw / 2;
            let iw = bw - 2 * pad + lw, ih = bh - 2 * pad + lw;
            let fillPath;
            if (horizontal) {
                let fw = Math.max(level > 0 ? 1 : 0, iw * level);
                fillPath = () => roundRect(ix, iy, fw, ih, Math.min(fw, ih) * 0.2);
            } else {
                let fh = Math.max(level > 0 ? 1 : 0, ih * level);
                fillPath = () => roundRect(ix, iy + ih - fh, iw, fh, Math.min(iw, fh) * 0.2);
            }
            if (level > 0) {
                cr.setSourceRGBA(fill[0], fill[1], fill[2], 1);
                fillPath();
                cr.fill();
            }

            if (inside) {
                drawText(ix + iw / 2, iy + ih / 2, iw, ih, level > 0 ? fillPath : null);
            } else if (st.charging) {
                // bolt knocked out of the fill so it shows on any background
                cr.save();
                cr.setOperator(Cairo.Operator.CLEAR);
                this._drawBolt(cr, ix + iw / 2, iy + ih / 2, Math.min(iw, ih) * 0.95, null);
                cr.restore();
                cr.save();
                cr.rectangle(0, 0, w, h);
                fillPath();
                cr.setFillRule(Cairo.FillRule.EVEN_ODD);
                cr.clip();
                this._drawBolt(cr, ix + iw / 2, iy + ih / 2, Math.min(iw, ih) * 0.95, fg);
                cr.restore();
            }
        }
        cr.$dispose();
    }

    // Lightning bolt of the given height, centered on (cx, cy).
    _drawBolt(cr, cx, cy, size, color) {
        let pts = [[0.58, 0], [0.12, 0.56], [0.44, 0.56], [0.34, 1], [0.88, 0.4], [0.56, 0.4]];
        let s = size, ox = cx - s * 0.5, oy = cy - s * 0.5;
        if (color) cr.setSourceRGBA(color[0], color[1], color[2], color[3]);
        cr.newPath();
        pts.forEach(([x, y], i) => i ? cr.lineTo(ox + x * s, oy + y * s) : cr.moveTo(ox + x * s, oy + y * s));
        cr.closePath();
        cr.fill();
    }

    _refreshPanel() {
        for (let k in this._pIcons) this._refreshPanelIcon(k);
        this._updateNetSpeed();
    }

    /* ---------- network speed in the panel ---------- */

    // Starts/stops the 1-second sampler depending on the setting.
    _updateNetSpeed() {
        if (!this._netSpeedLabel) return;
        let vertical = this._orientation === St.Side.LEFT || this._orientation === St.Side.RIGHT;
        let on = !!this.cfg('panel-net-speed') && !vertical;
        if (!on) {
            if (this._netSpeedTimer) { GLib.source_remove(this._netSpeedTimer); this._netSpeedTimer = 0; }
            this._netSpeedLabel.visible = false;
            this._netSpeedPrev = null;
            return;
        }
        if (!this._netSpeedTimer) {
            this._sampleNetSpeed();
            this._netSpeedTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 1, () => {
                this._sampleNetSpeed();
                return GLib.SOURCE_CONTINUE;
            });
        } else {
            this._renderNetSpeed();
        }
    }

    // Total bytes received/sent on real interfaces (Wi-Fi, Ethernet, USB tethering...).
    // Loopback and virtual ones (Docker, VMs, VPN tunnels on top of Wi-Fi) are left out
    // so nothing is counted twice.
    _readNetBytes() {
        let text = readFile('/proc/net/dev');
        if (!text) return null;
        let rx = 0, tx = 0;
        for (let line of text.split('\n').slice(2)) {
            let m = line.match(/^\s*([^:\s]+):\s*(.*)$/);
            if (!m) continue;
            let name = m[1];
            if (/^(lo|docker|veth|br-|virbr|vnet|tun|tap|wg|zt|tailscale|vboxnet|vmnet|lxc|lxd|ipsec|ppp\d*$)/.test(name)) continue;
            let f = m[2].trim().split(/\s+/).map(Number);
            if (f.length < 9) continue;
            rx += f[0]; tx += f[8];
        }
        return { rx, tx, t: GLib.get_monotonic_time() };
    }

    _sampleNetSpeed() {
        let now = this._readNetBytes();
        if (!now) { this._netSpeed = null; this._renderNetSpeed(); return; }
        let prev = this._netSpeedPrev;
        this._netSpeedPrev = now;
        if (!prev) { this._netSpeed = { down: 0, up: 0 }; this._renderNetSpeed(); return; }
        let dt = (now.t - prev.t) / 1e6;
        if (dt <= 0) return;
        this._netSpeed = {
            down: Math.max(0, (now.rx - prev.rx) / dt),
            up: Math.max(0, (now.tx - prev.tx) / dt),
        };
        this._renderNetSpeed();
    }

    // Compact and steady: always 3 digits wide (padded with digit-wide spaces) so the text
    // doesn't change width every second, e.g. "1.2 MB/s", " 34 KB/s", "512  B/s".
    _formatSpeed(bps) {
        const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
        const FIG = '\u2007';   // figure space: as wide as a digit
        let i = 0, v = bps;
        while (v >= 1000 && i < units.length - 1) { v /= 1024; i++; }
        let num = i === 0 ? String(Math.round(v)) : (v < 10 ? v.toFixed(1) : String(Math.round(v)));
        let unit = units[i].length < 4 ? FIG + units[i] : units[i];
        return `${num.padStart(3, FIG)} ${unit}`;
    }

    _renderNetSpeed() {
        let l = this._netSpeedLabel;
        if (!l) return;
        let sp = this._netSpeed;
        let connected = !!(this._net && (this._net.state === 'connected' || (this._net.wired || []).some(d => d.state === 'connected')))
            || !this._net;   // no NetworkManager info: show whatever is measured
        if (!sp || !connected || this._airplaneOn) { l.visible = false; return; }
        let show = this.cfg('panel-net-speed-show');
        let parts = [];
        if (show !== 'up') parts.push('↓ ' + this._formatSpeed(sp.down));
        if (show !== 'down') parts.push('↑ ' + this._formatSpeed(sp.up));
        setText(l, parts.join('  '));
        l.visible = true;

    }

    on_panel_height_changed() { this._updatePanelIconSize(); }

    on_panel_icon_size_changed() { this._updatePanelIconSize(); }

    on_orientation_changed(orientation) {
        this._orientation = orientation;
        let vertical = (orientation === St.Side.LEFT || orientation === St.Side.RIGHT);
        this._panelBox.vertical = vertical;
        if (vertical) this.actor.add_style_class_name('gqs-vertical');
        else this.actor.remove_style_class_name('gqs-vertical');
        if (this._batteryTime && this._panelState && this._panelState.battery) {
            try { this._refreshPanelIcon('battery'); } catch (e) { }
        }
        if (this._netSpeedLabel && this._panelState) { try { this._updateNetSpeed(); } catch (e) { } }
    }

    on_applet_clicked(event) {
        // While the settings window is open the panel button hides/shows the preview; switching
        // back to the settings window brings it back too (see _onFocusWindow).
        if (this._previewing) {
            if (this.menu.isOpen && !this._previewPaused) {
                // Closing Quick Settings minimizes the settings window with it; the panel button
                // (or restoring the window) brings both back.
                this._pausedByMinimize = true;
                this._pausePreview();
                this._minimizeSettingsWindows();
            } else {
                // Settings window minimized along with it? Bring both back together.
                if (this._settingsAllMinimized()) this._restoreSettingsWindows();
                this._resumePreview();
            }
            return;
        }
        if (!this._animFactor()) { this.menu.toggle(); return; }
        // Our own fade/slide replaces Cinnamon's menu animation so they don't stack.
        if (this.menu.isOpen) this._animateMenuOut(() => this.menu.close(false));
        else this.menu.open(false);
    }

    /* ---------- animations ---------- */

    _animFactor() {
        let f = { off: 0, fast: 0.6, normal: 1, slow: 1.6 }[this.cfg('animation-speed')];
        return f === undefined ? 1 : f;
    }

    // Ease actor properties with Clutter's implicit animations; onDone runs when finished.
    _ease(actor, props, ms, onDone, mode) {
        let d = Math.round(ms * this._animFactor());
        if (actor._gqsAnimDone) { GLib.source_remove(actor._gqsAnimDone); actor._gqsAnimDone = 0; }
        if (!d) {
            for (let k in props) actor[k] = props[k];
            if (onDone) onDone();
            return;
        }
        actor.save_easing_state();
        actor.set_easing_duration(d);
        actor.set_easing_mode(mode || Clutter.AnimationMode.EASE_OUT_CUBIC);
        for (let k in props) actor[k] = props[k];
        actor.restore_easing_state();
        if (onDone) {
            actor._gqsAnimDone = GLib.timeout_add(GLib.PRIORITY_DEFAULT, d + 20, () => {
                actor._gqsAnimDone = 0;
                try { onDone(); } catch (e) { global.logError('[gqs] anim: ' + e); }
                return GLib.SOURCE_REMOVE;
            });
            this._animActors = this._animActors || new Set();
            this._animActors.add(actor);
        }
    }

    // Slide distance: away from the panel the menu opens from.
    _menuSlide() {
        let o = this._orientation;
        if (o === St.Side.BOTTOM) return [0, 12];
        if (o === St.Side.LEFT) return [-12, 0];
        if (o === St.Side.RIGHT) return [12, 0];
        return [0, -12];
    }

    _afterAnim(ms) {
        return Math.round(ms * this._animFactor()) + 30;
    }

    _animateMenuIn() {
        if (!this._animFactor()) return;
        let [dx, dy] = this._menuSlide();
        this._main.opacity = 0;
        this._main.translation_x = dx;
        this._main.translation_y = dy;
        this._ease(this._main, { opacity: 255, translation_x: 0, translation_y: 0 }, 200);
    }

    _animateMenuOut(done) {
        let [dx, dy] = this._menuSlide();
        this._ease(this._main, { opacity: 0, translation_x: dx / 2, translation_y: dy / 2 },
            120, done, Clutter.AnimationMode.EASE_IN_QUAD);
    }

    _resetMenuAnim() {
        if (this._main._gqsAnimDone) { GLib.source_remove(this._main._gqsAnimDone); this._main._gqsAnimDone = 0; }
        this._main.remove_all_transitions();
        this._main.opacity = 255;
        this._main.translation_x = this._main.translation_y = 0;
        this._main.scale_x = this._main.scale_y = 1;
        if (this._shell) {
            if (this._shell._gqsAnimDone) { GLib.source_remove(this._shell._gqsAnimDone); this._shell._gqsAnimDone = 0; }
            if (this._sources['cfg-anim-in']) { GLib.source_remove(this._sources['cfg-anim-in']); delete this._sources['cfg-anim-in']; }
            this._shell.remove_all_transitions();
            this._shell.opacity = 255;
            this._shell.translation_y = 0;
            try { this._shell.offscreen_redirect = Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY; } catch (e) { }
        }
        if (this._cfgAnim) { this._cfgAnim = false; this._cfgAnimAgain = false; }
    }

    rotateArrow(icon, open) {
        icon.icon_name = 'go-next-symbolic';
        icon.set_pivot_point(0.5, 0.5);
        this._ease(icon, { rotation_angle_z: open ? 90 : 0 }, 200);
    }

    // Submenus open with a fade + short slide. Only opacity and position animate (no
    // per-frame relayout), which keeps it smooth on Cinnamon.
    _expand(actor) {
        actor._gqsCollapsing = false;
        if (actor._gqsAnimDone) { GLib.source_remove(actor._gqsAnimDone); actor._gqsAnimDone = 0; }
        actor.remove_all_transitions();
        actor.show();
        if (!this._animFactor()) { actor.opacity = 255; actor.translation_y = 0; return; }
        actor.opacity = 0;
        actor.translation_y = -8;
        this._ease(actor, { opacity: 255, translation_y: 0 }, 200);
    }

    _collapse(actor, instant) {
        if (!actor.visible) return;
        let finish = () => {
            actor._gqsCollapsing = false;
            actor.hide();
            actor.opacity = 255;
            actor.translation_y = 0;
        };
        if (instant || !this._animFactor()) {
            if (actor._gqsAnimDone) { GLib.source_remove(actor._gqsAnimDone); actor._gqsAnimDone = 0; }
            actor.remove_all_transitions();
            finish();
            return;
        }
        actor._gqsCollapsing = true;
        this._ease(actor, { opacity: 0, translation_y: -6 }, 120, finish, Clutter.AnimationMode.EASE_IN_QUAD);
    }

    _onPanelScroll(event) {
        let touchpad = scrollFromTouchpad(event);
        if (touchpad ? !this.cfg('panel-scroll-touchpad') : !this.cfg('panel-scroll-volume')) return Clutter.EVENT_PROPAGATE;
        if (!this._sink && this._mixer) this._sink = this._mixer.get_default_sink();
        if (!this._sink) return Clutter.EVENT_PROPAGATE;
        // A mouse wheel can send both a "smooth" and an emulated step event: use one of them.
        try { if (event.is_pointer_emulated && event.is_pointer_emulated()) return Clutter.EVENT_STOP; } catch (e) { }
        let dir = event.get_scroll_direction();
        let delta = 0;
        if (dir === Clutter.ScrollDirection.UP) delta = 0.05;
        else if (dir === Clutter.ScrollDirection.DOWN) delta = -0.05;
        else if (dir === Clutter.ScrollDirection.SMOOTH) {
            let [, dy] = event.get_scroll_delta();
            // Touchpads send many tiny deltas: add them up into 5% steps.
            this._panelScrollAcc = (this._panelScrollAcc || 0) - dy;
            if (Math.abs(this._panelScrollAcc) < 1) return Clutter.EVENT_STOP;
            let steps = Math.trunc(this._panelScrollAcc);
            this._panelScrollAcc -= steps;
            delta = Math.max(-3, Math.min(3, steps)) * 0.05;
        }
        if (!delta) return Clutter.EVENT_STOP;
        // Start from what we last set, not the (slower) reported value, so fast scrolling adds up.
        let now = GLib.get_monotonic_time();
        let base = (this._panelVol !== undefined && now - (this._panelVolAt || 0) < 800000) ? this._panelVol : this._volumeLevel();
        let v = Math.max(0, Math.min(1, base + delta));
        this._panelVol = v;
        this._panelVolAt = now;
        this._setVolume(v);
        this._showVolumeOsd(v);
        return Clutter.EVENT_STOP;
    }

    // Cinnamon's on-screen volume popup, like the volume keys show.
    _showVolumeOsd(v) {
        let name = v <= 0 ? 'audio-volume-muted-symbolic' : v < 0.34 ? 'audio-volume-low-symbolic'
            : v < 0.67 ? 'audio-volume-medium-symbolic' : 'audio-volume-high-symbolic';
        try { Main.osdWindowManager.show(-1, Gio.Icon.new_for_string(name), null, Math.round(v * 100)); } catch (e) { }
    }

    /* ---------- menu ---------- */

    _buildMenu() {
        // reactive: Clutter only delivers (captured) events to reactive containers, and edit mode
        // needs to see presses on tiles before the tiles do.
        this._main = new St.BoxLayout({ vertical: true, style_class: 'gqs-main', reactive: true });
        this.menu.box.add_child(this._main);

        /* Top row: battery pill + system buttons */
        this._topRow = new St.BoxLayout({ style_class: 'gqs-top-row', x_expand: true });

        let pillBox = new St.BoxLayout({ style_class: 'gqs-pill-box', x_expand: true, y_expand: true });
        this._batIcon = new St.Icon({ icon_size: 16, y_align: CENTER });
        this._pillDraw = new St.DrawingArea({ style_class: 'gqs-pill-battery-draw', y_align: CENTER, visible: false });
        this._pillDraw.connect('repaint', a => this._drawBattery(a));
        this._pillDraw.connect('style-changed', a => a.queue_repaint());
        this._batLabel = new St.Label({ y_align: CENTER, style_class: 'gqs-pill-label', text: '' });
        // Optional time remaining, as a smaller second line under the percentage.
        this._batTimeLabel = new St.Label({ y_align: CENTER, style_class: 'gqs-pill-time', text: '', visible: false });
        let pillText = new St.BoxLayout({ vertical: true, y_align: CENTER, style_class: 'gqs-pill-text' });
        pillText.add_child(this._batLabel);
        pillText.add_child(this._batTimeLabel);
        pillBox.add_child(this._batIcon);
        pillBox.add_child(this._pillDraw);
        pillBox.add_child(pillText);
        this._batteryPill = align(fill(new St.Button({ style_class: 'gqs-pill', child: pillBox, can_focus: true, visible: false })), null, CENTER);
        this._batteryPill.connect('clicked', () => {
            if (this.guardClick()) return;
            this._launch(['cinnamon-settings', 'power']);
        });
        this._topRow.add_child(this._batteryPill);
        this._topRow.add_child(new St.Widget({ x_expand: true }));

        let shotCmd = firstProgram([
            ['gnome-screenshot', '-i'], ['xfce4-screenshooter'], ['flameshot', 'gui'], ['spectacle'],
        ]);
        this._shotCmd = shotCmd;
        this._shotButton = null;
        if (shotCmd) {
            this._shotButton = this._iconButton(
                ['screenshot-ui-area-symbolic', 'applets-screenshooter-symbolic', 'camera-photo-symbolic'],
                () => {
                    this.menu.close();
                    this._queue('shot', 400, () => launch(shotCmd));
                });
            this._topRow.add_child(this._shotButton);
        }
        this._customizeButton = this._iconButton(['document-edit-symbolic', 'edit-symbolic', 'preferences-other-symbolic'],
            () => { if (this._editing) this._requestExitEdit('pencil'); else this._setEditing(true); });
        try { this._customizeButton.set_accessible_name(_('Customize Quick Settings')); } catch (e) { }
        this._topRow.add_child(this._customizeButton);
        this._configButton = this._iconButton(['preferences-other-symbolic', 'document-properties-symbolic', 'emblem-system-symbolic'],
            () => this._openConfigure());
        try { this._configButton.set_accessible_name(_('Quick Settings settings')); } catch (e) { }
        this._topRow.add_child(this._configButton);
        this._settingsButton = this._iconButton(['emblem-system-symbolic', 'preferences-system-symbolic'],
            () => this._launch(['cinnamon-settings']));
        this._topRow.add_child(this._settingsButton);
        this._lockButton = this._iconButton(['system-lock-screen-symbolic', 'changes-prevent-symbolic'],
            () => this._launch(['cinnamon-screensaver-command', '--lock']));
        this._topRow.add_child(this._lockButton);
        this._powerButton = this._iconButton(['system-shutdown-symbolic'], () => this.toggleSubmenu(this._powerMenu), true);
        this._powerButton.connect('notify::hover', () => this._paintPowerButton());
        this._topRow.add_child(this._powerButton);
        this._main.add_child(this._topRow);

        /* Power submenu */
        this._powerMenu = new QSMenu(this, _('Power Off'), ['system-shutdown-symbolic']);
        this._powerMenu.setHeaderChecked(true);
        this._powerMenu.addItem({ label: _('Suspend'), icon: ['media-playback-pause-symbolic'], onActivate: () => this._launch(['systemctl', 'suspend']) });
        this._powerMenu.addItem({ label: _('Restart…'), icon: ['system-reboot-symbolic', 'view-refresh-symbolic'], onActivate: () => this._launch(['cinnamon-session-quit', '--reboot']) });
        this._powerMenu.addItem({ label: _('Power Off…'), icon: ['system-shutdown-symbolic'], onActivate: () => this._launch(['cinnamon-session-quit', '--power-off']) });
        this._powerMenu.setFooter([
            { label: _('Log Out…'), icon: ['system-log-out-symbolic', 'application-exit-symbolic'], onActivate: () => this._launch(['cinnamon-session-quit', '--logout']) },
        ]);
        this._main.add_child(this._powerMenu.actor);

        /* Volume slider + output picker */
        this._volume = this._sliderRow(['audio-volume-medium-symbolic'],
            () => { if (this._sink) this._sink.change_is_muted(!this._sink.is_muted); },
            v => this._setVolume(v), true);
        this._main.add_child(this._volume.row);
        this._volumeMenu = new QSMenu(this, _('Sound Output'), ['audio-speakers-symbolic', 'audio-volume-high-symbolic']);
        this._volumeMenu.setHeaderChecked(true);
        this._volumeMenu.owner = this._volume.owner;
        this._volumeMenu.onOpen = () => this._buildDeviceMenu(false);
        this._volume.arrow.connect('clicked', () => this.toggleSubmenu(this._volumeMenu));
        this._main.add_child(this._volumeMenu.actor);

        /* Microphone slider + input picker */
        this._mic = this._sliderRow(['audio-input-microphone-symbolic'],
            () => { if (this._source) this._source.change_is_muted(!this._source.is_muted); },
            v => this._setMicVolume(v), true);
        this._mic.row.hide();
        this._main.add_child(this._mic.row);
        this._micMenu = new QSMenu(this, _('Sound Input'), ['audio-input-microphone-symbolic']);
        this._micMenu.setHeaderChecked(true);
        this._micMenu.owner = this._mic.owner;
        this._micMenu.onOpen = () => this._buildDeviceMenu(true);
        this._mic.arrow.connect('clicked', () => this.toggleSubmenu(this._micMenu));
        this._main.add_child(this._micMenu.actor);

        /* Brightness */
        this._brightness = this._sliderRow(['display-brightness-symbolic'], null,
            v => this._brightThrottle && this._brightThrottle.set(Math.max(1, Math.round(v * 100))));
        this._brightness.row.hide();
        this._main.add_child(this._brightness.row);

        // Which scrolling (mouse wheel / touchpad) each slider reacts to — each has its own setting.
        this._volume.slider.scrollFilter = e => scrollAllowed(this.cfg('scroll-volume-slider'), e);
        this._mic.slider.scrollFilter = e => scrollAllowed(this.cfg('scroll-mic-slider'), e);
        this._brightness.slider.scrollFilter = e => scrollAllowed(this.cfg('scroll-brightness-slider'), e);

        /* Toggle grid */
        // Edit bar (shown while rearranging tiles)
        this._editBar = new St.BoxLayout({ vertical: true, style_class: 'gqs-edit-bar', x_expand: true, visible: false });
        let editTop = new St.BoxLayout({ x_expand: true, style_class: 'gqs-edit-top' });
        let editText = new St.BoxLayout({ vertical: true, x_expand: true, y_align: CENTER });
        editText.add_child(new St.Label({ text: _('Edit Quick Settings'), style_class: 'gqs-edit-title' }));
        this._editHint = ellipsize(new St.Label({ text: _('Tap a tile to move it, or drag it.'), style_class: 'gqs-edit-hint' }));
        editText.add_child(this._editHint);
        editTop.add_child(editText);
        let cancelBtn = align(new St.Button({ style_class: 'gqs-edit-button', label: _('Cancel'), can_focus: true }), null, CENTER);
        cancelBtn.connect('clicked', () => this._requestExitEdit('cancel'));
        let doneBtn = align(new St.Button({ style_class: 'gqs-edit-button gqs-edit-done', label: _('Done'), can_focus: true }), null, CENTER);
        doneBtn.connect('clicked', () => this._finishEditing(true));
        this._editDone = doneBtn;
        editTop.add_child(cancelBtn);
        editTop.add_child(doneBtn);
        this._editBar.add_child(editTop);

        // Toolbar for the selected tile (an alternative to dragging).
        this._editTools = new St.BoxLayout({ style_class: 'gqs-edit-tools', x_expand: true, visible: false });
        this._editSelLabel = ellipsize(new St.Label({ text: '', style_class: 'gqs-edit-sel', x_expand: true, y_align: CENTER }));
        this._editTools.add_child(this._editSelLabel);
        let tool = (names, tip, cb) => {
            let b = this._iconButton(names, cb, true);
            b.add_style_class_name('gqs-edit-tool');
            try { b.set_accessible_name(tip); } catch (e) { }
            try { new (imports.ui.tooltips.Tooltip)(b, tip); } catch (e) { }
            this._editTools.add_child(b);
            return b;
        };
        this._toolPrevPage = tool(['go-first-symbolic', 'media-skip-backward-symbolic'], _('Move to previous page'), () => this._editMove('prev-page'));
        this._toolBack = tool(['go-previous-symbolic'], _('Move back'), () => this._editMove('back'));
        this._toolForward = tool(['go-next-symbolic'], _('Move forward'), () => this._editMove('forward'));
        this._toolNextPage = tool(['go-last-symbolic', 'media-skip-forward-symbolic'], _('Move to next page'), () => this._editMove('next-page'));
        this._toolHide = tool(['view-conceal-symbolic', 'list-remove-symbolic'], _('Hide'), () => this._editMove('toggle-hide'));
        this._editBar.add_child(this._editTools);
        this._main.add_child(this._editBar);

        // Tiles: the grid for the current page, page dots, the hidden tray (edit mode)
        // and the compact row of round buttons (when notifications are expanded).
        this._tilesBox = new St.BoxLayout({ vertical: true, style_class: 'gqs-tiles', x_expand: true, reactive: true });
        this._grid = new St.BoxLayout({ vertical: true, style_class: 'gqs-grid', x_expand: true });
        this._dots = new St.BoxLayout({ style_class: 'gqs-page-dots', x_align: CENTER, visible: false });
        this._trayBox = new St.BoxLayout({ vertical: true, style_class: 'gqs-tray', x_expand: true, visible: false });
        this._trayLabel = new St.Label({ text: _('Hidden tiles — drag here to hide'), style_class: 'gqs-tray-label' });
        this._trayGrid = new St.BoxLayout({ vertical: true, style_class: 'gqs-grid gqs-tray-grid', x_expand: true });
        this._trayEmpty = new St.Label({ text: _('Nothing hidden'), style_class: 'gqs-tray-empty' });
        // Header: label on the left, "‹ 1/2 ›" on the right when there's more than one page.
        // Up to 4 rows of hidden tiles per page; the rest go on the next page.
        let trayHead = new St.BoxLayout({ style_class: 'gqs-tray-head', x_expand: true });
        this._trayLabel.x_expand = true;
        this._trayLabel.y_align = CENTER;
        trayHead.add_child(this._trayLabel);
        this._trayNav = new St.BoxLayout({ style_class: 'gqs-tray-nav', y_align: CENTER, visible: false });
        let navBtn = (icon, step) => {
            let b = new St.Button({ style_class: 'gqs-tray-nav-btn', can_focus: true,
                child: new St.Icon({ icon_name: icon, icon_size: 14 }) });
            b.connect('clicked', () => this._trayFlip(step));
            return b;
        };
        this._trayPrev = navBtn('go-previous-symbolic', -1);
        this._trayNext = navBtn('go-next-symbolic', 1);
        this._trayPageLabel = new St.Label({ style_class: 'gqs-tray-page', y_align: CENTER, text: '' });
        this._trayNav.add_child(this._trayPrev);
        this._trayNav.add_child(this._trayPageLabel);
        this._trayNav.add_child(this._trayNext);
        trayHead.add_child(this._trayNav);
        this._trayBox.add_child(trayHead);
        this._trayBox.add_child(this._trayGrid);
        this._trayBox.add_child(this._trayEmpty);
        this._trayPage = 1;
        // Scrolling over the tray flips its pages (not the main tile pages).
        this._trayBox.reactive = true;
        this._trayBox.connect('scroll-event', (a, e) => {
            let dir = e.get_scroll_direction();
            if (dir === Clutter.ScrollDirection.SMOOTH) {
                let [, dy] = e.get_scroll_delta();
                this._trayScrollAcc = (this._trayScrollAcc || 0) + dy;
                if (Math.abs(this._trayScrollAcc) < 1) return Clutter.EVENT_STOP;
                dir = this._trayScrollAcc > 0 ? Clutter.ScrollDirection.DOWN : Clutter.ScrollDirection.UP;
                this._trayScrollAcc = 0;
            }
            if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT) this._trayFlip(1);
            else if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT) this._trayFlip(-1);
            return Clutter.EVENT_STOP;
        });
        this._compactRow = new St.BoxLayout({ style_class: 'gqs-compact-row', x_expand: true, visible: false });
        try { this._compactRow.layout_manager.homogeneous = true; } catch (e) { }
        this._tilesBox.add_child(this._grid);
        this._tilesBox.add_child(this._dots);
        this._tilesBox.add_child(this._trayBox);
        this._tilesBox.add_child(this._compactRow);
        this._main.add_child(this._tilesBox);
        this._page = 1;
        this._tilesBox.connect('scroll-event', (a, e) => this._onTilesScroll(e));
        this._main.connect('captured-event', (a, e) => this._onEditEvent(e));

        this._wifiToggle = this._addToggle({
            id: 'Wi-Fi', title: _('Wi-Fi'), icon: ['network-wireless-signal-excellent-symbolic'], menu: true, shown: true,
            onClicked: () => this._toggleWifi(),
            onMenuOpen: () => this._buildWifiMenu(null),
        });
        this._wiredToggle = this._addToggle({
            id: 'Wired', title: _('Wired'), icon: ['network-wired-symbolic'], shown: false,
            unavailableText: _('No Ethernet port'), onUnavailable: () => this._launch(['cinnamon-settings', 'network']),
            onClicked: () => this._toggleWired(),
        });
        this._btToggle = this._addToggle({
            id: 'Bluetooth', title: _('Bluetooth'), icon: ['bluetooth-active-symbolic'], menu: true, shown: false,
            unavailableText: _('No adapter'),
            onClicked: () => this._setBtPowered(!this._btPowered),
            onMenuOpen: () => { this._btRefresh(); this._buildBtMenu(); },
        });
        this._vpnToggle = this._addToggle({
            id: 'VPN', title: _('VPN'), icon: ['network-vpn-symbolic'], menu: true, shown: false,
            unavailableText: _('Not set up'), onUnavailable: () => this._launch(hasProgram('nm-connection-editor') ? ['nm-connection-editor'] : ['cinnamon-settings', 'network']),
            onClicked: () => this._toggleVpn(),
            onMenuOpen: () => this._buildVpnMenu(),
        });
        this._powerModeToggle = this._addToggle({
            id: 'Power Mode', title: _('Power Mode'), icon: PROFILE_INFO['balanced'].icon, menu: true, shown: false,
            unavailableText: _('Not supported'),
            onClicked: () => this._togglePowerMode(),
            onMenuOpen: () => this._buildPowerModeMenu(),
        });
        this._nightToggle = this._addToggle({
            id: 'Night Light', title: _('Night Light'), icon: ['night-light-symbolic', 'weather-clear-night-symbolic'], shown: false,
            unavailableText: _('Not supported'),
            onClicked: () => {
                if (this._colorSettings) this._colorSettings.set_boolean('night-light-enabled', !this._colorSettings.get_boolean('night-light-enabled'));
            },
        });
        this._darkToggle = this._addToggle({
            id: 'Dark Style', title: _('Dark Style'), icon: ['dark-mode-symbolic', 'weather-clear-night-symbolic'],
            onClicked: () => {
                let dark = !this._darkToggle.checked;
                this._setDarkStyle(dark);
                this._styleSetAt = 0;
                this._pullStyleFromSystem(dark);
                this._styleSetAt = GLib.get_monotonic_time();   // don't let the theme's echo undo it
            },
        });
        this._dndToggle = this._addToggle({
            id: 'Do Not Disturb', title: _('Do Not Disturb'), icon: ['notifications-disabled-symbolic', 'notification-disabled-symbolic'], shown: false,
            unavailableText: _('Not supported'),
            onClicked: () => {
                if (this._notifSettings) this._notifSettings.set_boolean('display-notifications', !this._notifSettings.get_boolean('display-notifications'));
            },
        });
        this._caffeineToggle = this._addToggle({
            id: 'Caffeine', title: _('Caffeine'), icon: [localIcon('gqs-caffeine-symbolic'), 'preferences-desktop-screensaver-symbolic'],
            onClicked: () => this._setCaffeine(!this._inhibitCookie),
        });
        this._kbdToggle = this._addToggle({
            id: 'Keyboard', title: _('Keyboard'), icon: ['keyboard-brightness-symbolic', 'input-keyboard-symbolic'], menu: true,
            menuTitle: _('Keyboard Brightness'), shown: true,
            onClicked: () => this._toggleKeyboard(),
            onMenuOpen: () => { this._getKeyboard(); this._buildKbdMenu(); },
        });
        this._refreshToggle = this._addToggle({
            id: 'Refresh Rate', title: _('Refresh Rate'), icon: ['video-display-symbolic', 'preferences-desktop-display-symbolic'],
            menu: true, menuTitle: _('Refresh Rate'), shown: true,
            onClicked: () => this._toggleRefreshRate(),
            onMenuOpen: () => { this._buildRefreshMenu(); this._syncRefresh(); },
        });
        this._micToggle = this._addToggle({
            id: 'Microphone', title: _('Microphone'), icon: ['audio-input-microphone-symbolic'], shown: false,
            unavailableText: _('No microphone'), onUnavailable: () => this._launch(['cinnamon-settings', 'sound']),
            onClicked: () => { if (this._source) this._source.change_is_muted(!this._source.is_muted); },
        });
        this._cameraToggle = this._addToggle({
            id: 'Camera', title: _('Camera'), icon: ['camera-web-symbolic', 'camera-photo-symbolic'], shown: true,
            onClicked: () => this._toggleCamera(),
        });
        this._rotateToggle = this._addToggle({
            id: 'Auto Rotate', title: _('Auto Rotate'), icon: ['rotation-allowed-symbolic', 'object-rotate-right-symbolic'], shown: false,
            unavailableText: _('No rotation sensor'), onUnavailable: () => this._launch(['cinnamon-settings', 'display']),
            onClicked: () => {
                if (this._touchscreenSettings) this._touchscreenSettings.set_boolean('orientation-lock', !this._touchscreenSettings.get_boolean('orientation-lock'));
            },
        });
        this._hotspotToggle = this._addToggle({
            id: 'Hotspot', title: _('Hotspot'), icon: ['network-wireless-hotspot-symbolic', 'network-wireless-symbolic'], menu: true, shown: false,
            unavailableText: _('No Wi-Fi adapter'),
            onClicked: () => this._toggleHotspot(),
            onMenuOpen: () => this._buildHotspotMenu(),
        });
        this._touchpadToggle = this._addToggle({
            id: 'Touchpad', title: _('Touchpad'), icon: ['input-touchpad-symbolic', 'touchpad-disabled-symbolic'], shown: false,
            unavailableText: _('No touchpad'),
            onClicked: () => this._toggleTouchpad(),
        });
        // App tiles: open the app (or bring its window to the front). Unavailable if not installed.
        this._updateTile = this._addAppTile('Update Manager', _('Update Manager'),
            ['mintupdate.desktop', 'update-manager.desktop', 'org.gnome.Software.desktop'],
            ['mintupdate-up-to-date', 'software-update-available-symbolic', 'system-software-update']);
        this._nvidiaTile = this._addAppTile('NVIDIA Settings', _('NVIDIA Settings'),
            ['nvidia-settings.desktop'], ['nvidia-settings', 'video-display-symbolic']);
        this._discordTile = this._addAppTile('Discord', _('Discord'),
            ['discord.desktop', 'com.discordapp.Discord.desktop', 'discord-ptb.desktop', 'discord-canary.desktop', 'vesktop.desktop', 'dev.vencord.Vesktop.desktop'],
            ['discord', 'com.discordapp.Discord', 'internet-chat-symbolic']);
        // More app tiles (native, Flatpak and Snap names are all tried).
        const APPS = [
            ['Files', _('Files'), ['nemo.desktop', 'org.gnome.Nautilus.desktop', 'thunar.desktop', 'org.kde.dolphin.desktop'], ['system-file-manager', 'folder-symbolic']],
            ['Firefox', _('Firefox'), ['firefox.desktop', 'org.mozilla.firefox.desktop', 'firefox_firefox.desktop', 'firefox-esr.desktop'], ['firefox', 'web-browser-symbolic']],
            ['Google Chrome', _('Google Chrome'), ['google-chrome.desktop', 'com.google.Chrome.desktop', 'google-chrome-beta.desktop'], ['google-chrome', 'web-browser-symbolic']],
            ['Brave', _('Brave'), ['brave-browser.desktop', 'com.brave.Browser.desktop', 'brave_brave.desktop'], ['brave-browser', 'web-browser-symbolic']],
            ['Spotify', _('Spotify'), ['spotify.desktop', 'com.spotify.Client.desktop', 'spotify_spotify.desktop'], ['spotify-client', 'spotify', 'audio-x-generic-symbolic']],
            ['Steam', _('Steam'), ['steam.desktop', 'com.valvesoftware.Steam.desktop', 'steam_steam.desktop'], ['steam', 'applications-games-symbolic']],
            ['LocalSend', _('LocalSend'), ['org.localsend.localsend_app.desktop', 'localsend_app.desktop', 'localsend.desktop', 'localsend_localsend.desktop'], ['localsend', 'send-to-symbolic']],
            ['Bitwarden', _('Bitwarden'), ['bitwarden.desktop', 'com.bitwarden.desktop.desktop', 'bitwarden_bitwarden.desktop'], ['bitwarden', 'dialog-password-symbolic']],
            ['Android Studio', _('Android Studio'), ['android-studio.desktop', 'jetbrains-studio.desktop', 'com.google.AndroidStudio.desktop', 'android-studio_android-studio.desktop'], ['android-studio', 'applications-development-symbolic']],
            ['Calculator', _('Calculator'), ['org.gnome.Calculator.desktop', 'gnome-calculator.desktop', 'galculator.desktop', 'mate-calc.desktop', 'qalculate-gtk.desktop', 'org.kde.kcalc.desktop'], ['accessories-calculator', 'accessories-calculator-symbolic']],
            ['Driver Manager', _('Driver Manager'), ['mintdrivers.desktop', 'software-properties-drivers.desktop'], ['mintdrivers', 'jockey', 'cpu-symbolic', 'application-x-firmware-symbolic']],
            ['Ulauncher', _('Ulauncher'), ['ulauncher.desktop', 'io.ulauncher.Ulauncher.desktop'], ['ulauncher', 'system-search-symbolic']],
            ['ProtonVPN', _('Proton VPN'), ['proton.vpn.app.gtk.desktop', 'protonvpn-app.desktop', 'protonvpn.desktop', 'com.protonvpn.www.desktop'], ['proton-vpn-logo', 'protonvpn', 'network-vpn-symbolic']],
            ['Emote', _('Emote'), ['emote.desktop', 'com.tomjwatson.Emote.desktop', 'emote_emote.desktop'], ['emote', 'face-smile-symbolic']],
            ['LibreOffice', _('LibreOffice'), ['libreoffice-startcenter.desktop', 'org.libreoffice.LibreOffice.desktop', 'libreoffice_libreoffice.desktop'], ['libreoffice-startcenter', 'libreoffice-main', 'x-office-document-symbolic']],
        ];
        this._moreAppTiles = APPS.map(([id, title, ids, icon]) => this._addAppTile(id, title, ids, icon));
        // Ulauncher runs in the background: tapping shows its search box (like its hotkey).
        let ul = this._moreAppTiles.find(t => t.id === 'Ulauncher');
        if (ul) ul._onClicked = () => {
            if (this._previewing) this._pausePreview(); else this.menu.close();
            if (hasProgram('ulauncher-toggle')) this._queue('ulauncher', 250, () => launch(['ulauncher-toggle']));
            else this._openApp(this._findApp(ul._appIds));
        };

        // Startup Applications: Cinnamon's list of apps that start when you log in.
        this._startupTile = this._addToggle({
            id: 'Startup Applications', title: _('Startup Applications'),
            icon: ['system-run-symbolic', 'cinnamon-settings-startup', 'preferences-system-session'],
            onClicked: () => {
                if (this._previewing) this._pausePreview(); else this.menu.close();
                launch(['cinnamon-settings', 'startup']);
            },
        });

        // Show desktop: minimize every window on this workspace; tap again to bring them back.
        this._desktopTile = this._addToggle({
            id: 'Show Desktop', title: _('Show Desktop'), icon: ['user-desktop-symbolic', 'desktop', 'user-desktop'],
            onClicked: () => this._toggleShowDesktop(),
        });

        // Trash: open it; the arrow can empty it. Shows how many items it holds.
        this._trashTile = this._addToggle({
            id: 'Trash', title: _('Trash'), icon: ['user-trash-symbolic', 'user-trash'], menu: true,
            onClicked: () => this._openUri('trash:///'),
            onMenuOpen: () => this._buildTrashMenu(),
        });

        // Accessibility: Cinnamon's Accessibility settings (zoom, screen reader, high contrast…).
        this._a11yTile = this._addToggle({
            id: 'Accessibility', title: _('Accessibility'),
            icon: ['preferences-desktop-accessibility-symbolic', 'org.gnome.Settings-accessibility-symbolic', 'preferences-desktop-accessibility'],
            onClicked: () => {
                if (this._previewing) this._pausePreview(); else this.menu.close();
                launch(['cinnamon-settings', 'universal-access']);
            },
        });

        // Terminal tile: opens your default terminal.
        this._terminalCmd = this._findTerminal();
        this._terminalToggle = this._addToggle({
            id: 'Terminal', title: _('Terminal'),
            icon: ['utilities-terminal-symbolic', 'utilities-terminal'],
            shown: !!this._terminalCmd, unavailableText: _('No terminal app'),
            onClicked: () => {
                if (this._previewing) this._pausePreview(); else this.menu.close();
                launch(this._findTerminal() || this._terminalCmd);
            },
        });
        // Screenshot tile: tap = the screenshot tool; arrow = whole screen / window / area.
        this._shotToggle = this._addToggle({
            id: 'Screenshot', title: _('Screenshot'),
            icon: ['screenshot-ui-area-symbolic', 'applets-screenshooter-symbolic', 'camera-photo-symbolic'],
            menu: !!(this._shotCmd && this._shotCmd[0] === 'gnome-screenshot'), shown: !!this._shotCmd,
            unavailableText: _('No screenshot app'),
            onClicked: () => this._takeScreenshot(this._shotCmd),
            onMenuOpen: () => this._buildShotMenu(),
        });
        this._airplaneToggle = this._addToggle({
            id: 'Airplane Mode', title: _('Airplane Mode'), icon: ['airplane-mode-symbolic', 'airplane-mode'], shown: false,
            unavailableText: _('Not supported'),
            onClicked: () => this._toggleAirplane(),
        });

        /* keyboard brightness slider lives inside its submenu */
        this._kbdSlider = this._sliderRow(['keyboard-brightness-symbolic', 'input-keyboard-symbolic'], null,
            v => { this._kbdUserTouched = true; if (this._kbdThrottle) this._kbdThrottle.set(Math.round(v * (this._kbdMax || 100))); });
        this._kbdToggle.menu.addActor(this._kbdSlider.row);
        this._kbdToggle.menu.setFooter([
            { label: _('Keyboard Settings'), onActivate: () => this._launch(['cinnamon-settings', 'keyboard']) },
        ]);

        /* Media card */
        this._buildMediaCard();
        this._main.add_child(this._media.actor);

        /* Notifications (bottom) */
        this._buildNotifications();
        this._main.add_child(this._notif.actor);
    }

    /* A tile that opens an installed app. appIds: desktop file IDs to try, in order. */
    _addAppTile(id, title, appIds, fallbackIcon) {
        let info = this._findApp(appIds);
        let icon = info && info.get_icon() ? 'gicon:' + info.get_icon().to_string() : fallbackIcon;
        let tile = this._addToggle({
            id, title, icon, shown: !!info, unavailableText: _('Not installed'),
            onClicked: () => this._openApp(this._findApp(appIds)),
        });
        tile._appIds = appIds;
        return tile;
    }

    _findApp(ids) {
        for (let id of ids) {
            try { let a = Gio.DesktopAppInfo.new(id); if (a) return a; } catch (e) { }
        }
        return null;
    }

    _openApp(info) {
        if (!info) return;
        if (this._previewing) this._pausePreview(); else this.menu.close();
        try {
            let app = imports.gi.Cinnamon.AppSystem.get_default().lookup_app(info.get_id());
            if (app) { app.activate(); return; }   // focuses it if it's already open
        } catch (e) { }
        try { info.launch([], global.create_app_launch_context(0, -1)); }
        catch (e) { try { info.launch([], null); } catch (e2) { global.logError('[gqs] open app: ' + e2); } }
    }

    // Re-check installs, and fill in the subtitles (updates waiting, NVIDIA GPU mode).
    _refreshAppTiles() {
        for (let t of [this._updateTile, this._nvidiaTile, this._discordTile].concat(this._moreAppTiles || [])) {
            if (t) t.setAvailable(!!this._findApp(t._appIds));
        }
        this._syncTrash();
        this._syncShowDesktop();
        // NVIDIA: which GPU mode PRIME is set to (instant, no password).
        if (this._nvidiaTile && this._nvidiaTile.available && hasProgram('prime-select')) {
            run(['prime-select', 'query'], (ok, out) => {
                let mode = (out || '').trim();
                let label = { nvidia: _('NVIDIA (performance)'), intel: _('Integrated (power saving)'),
                    'on-demand': _('On-Demand') }[mode] || '';
                this._nvidiaTile.setSubtitle(label);
            });
        }
        // Updates: count what's waiting, at most every 30 minutes (it reads the package lists).
        let now = GLib.get_monotonic_time();
        if (this._updateTile && this._updateTile.available && hasProgram('mintupdate-cli')
            && (!this._updatesAt || now - this._updatesAt > 30 * 60e6)) {
            this._updatesAt = now;
            run(['mintupdate-cli', 'list'], (ok, out) => {
                if (!ok) return;
                let n = (out || '').split('\n').filter(l => l.trim()).length;
                this._updateTile.setSubtitle(n ? (n === 1 ? _('1 update') : `${n} ${_('updates')}`) : _('Up to date'));
                this._updateTile.setChecked(n > 0);
            });
        }
    }

    _openUri(uri) {
        if (this._previewing) this._pausePreview(); else this.menu.close();
        try { Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1)); }
        catch (e) { launch(['xdg-open', uri]); }
    }

    /* ----- Show desktop ----- */
    _desktopWindows() {
        let ws = null;
        try { ws = global.workspace_manager ? global.workspace_manager.get_active_workspace() : global.screen.get_active_workspace(); } catch (e) { }
        return this._allWindows().filter(w => {
            try {
                if (w.skip_taskbar || w.get_window_type() !== 0 /* Meta.WindowType.NORMAL */) return false;
                return !ws || w.located_on_workspace(ws);
            } catch (e) { return false; }
        });
    }

    _toggleShowDesktop() {
        this.menu.close();
        let open = this._desktopWindows().filter(w => !w.minimized);
        if (open.length) {
            this._desktopHidden = open;            // remember them to bring back
            for (let w of open) try { w.minimize(); } catch (e) { }
        } else if (this._desktopHidden && this._desktopHidden.length) {
            for (let w of this._desktopHidden) try { w.unminimize(); } catch (e) { }
            let last = this._desktopHidden[this._desktopHidden.length - 1];
            this._desktopHidden = null;
            if (last) this._focusWindow(last);
        }
        this._queue('desktop-sync', 300, () => this._syncShowDesktop());
    }

    _syncShowDesktop() {
        if (!this._desktopTile) return;
        let showing = !!(this._desktopHidden && this._desktopHidden.length) && !this._desktopWindows().some(w => !w.minimized);
        if (!showing && this._desktopHidden && this._desktopWindows().some(w => !w.minimized)) this._desktopHidden = null;
        this._desktopTile.setChecked(showing);
        this._desktopTile.setSubtitle(showing ? _('Tap to restore') : '');
    }

    /* ----- Trash ----- */
    _syncTrash(cb) {
        if (!this._trashTile) return;
        let f = Gio.File.new_for_uri('trash:///');
        f.query_info_async('trash::item-count', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null, (o, r) => {
            let n = 0;
            try { n = o.query_info_finish(r).get_attribute_uint32('trash::item-count'); } catch (e) { n = 0; }
            this._trashCount = n;
            this._trashTile.setSubtitle(n ? (n === 1 ? _('1 item') : `${n} ${_('items')}`) : _('Empty'));
            this._trashTile.setIcon(n ? ['user-trash-full-symbolic', 'user-trash-full', 'user-trash-symbolic'] : ['user-trash-symbolic', 'user-trash']);
            if (cb) cb(n);
        });
    }

    _buildTrashMenu() {
        let menu = this._trashTile.menu;
        menu.clear();
        menu.addItem({ label: _('Open Trash'), icon: ['folder-open-symbolic'], onActivate: () => this._openUri('trash:///') });
        menu.addItem({
            label: _('Empty Trash…'), icon: ['user-trash-full-symbolic', 'edit-delete-symbolic'],
            onActivate: () => this._confirmEmptyTrash(),
        });
        this._syncTrash();
    }

    _confirmEmptyTrash() {
        let n = this._trashCount || 0;
        if (!n) { this._syncTrash(); return; }
        this._showDialog(_('Empty the Trash?'),
            _('%d items will be deleted for good. This can\'t be undone.').replace('%d', String(n)),
            [
                { label: _('Cancel'), key: Clutter.KEY_Escape, action: () => { } },
                { label: _('Empty Trash'), default: true, action: () => {
                    run(['gio', 'trash', '--empty'], () => this._queue('trash-sync', 300, () => this._syncTrash()));
                } },
            ], null, () => { });
    }

    // The terminal chosen in System Settings › Preferred Applications, else a common one.
    _findTerminal() {
        let s = lookupSettings('org.cinnamon.desktop.default-applications.terminal', 'exec');
        let exec = '';
        try { exec = s ? s.get_string('exec') : ''; } catch (e) { }
        if (exec && hasProgram(exec.split(/\s+/)[0])) return GLib.shell_parse_argv(exec)[1];
        return firstProgram([['x-terminal-emulator'], ['gnome-terminal'], ['xfce4-terminal'], ['tilix'], ['konsole'], ['xterm']]);
    }

    _takeScreenshot(argv) {
        if (!argv) return;
        this.closeSubmenu(true);
        // Close Quick Settings first so it isn't in the picture.
        if (this._previewing) this._pausePreview(); else this.menu.close();
        this._queue('shot', 400, () => launch(argv));
    }

    _buildShotMenu() {
        let menu = this._shotToggle.menu;
        if (!menu) return;
        menu.clear();
        menu.addItem({ label: _('Whole Screen'), icon: ['video-display-symbolic'], onActivate: () => this._takeScreenshot(['gnome-screenshot']) });
        menu.addItem({ label: _('Window'), icon: ['window-new-symbolic', 'focus-windows-symbolic'], onActivate: () => this._takeScreenshot(['gnome-screenshot', '-w']) });
        menu.addItem({ label: _('Area'), icon: ['screenshot-ui-area-symbolic', 'edit-select-all-symbolic'], onActivate: () => this._takeScreenshot(['gnome-screenshot', '-a']) });
        menu.setFooter([{ label: _('Screenshot Options…'), onActivate: () => this._takeScreenshot(['gnome-screenshot', '-i']) }]);
    }

    /* ===== Custom tiles (made in the settings window) =====
       kind "app": open an installed app (or bring its window to the front)
       kind "open": open a folder in Files or a website in the browser
       kind "command": on/off tile running your own commands, optional status command */

    _syncCustomTiles() {
        if (!this._customToggles) return;
        let list = this.cfg('custom-tiles');
        if (!Array.isArray(list)) list = [];
        list = list.filter(t => t && t.id && t.kind);
        let key = JSON.stringify(list);
        if (key === this._customKey) return;
        this._customKey = key;

        // Rebuild: remove the old custom tiles, then add the current ones.
        for (let t of this._customToggles) {
            let i = this._toggles.indexOf(t);
            if (i >= 0) this._toggles.splice(i, 1);
            delete this._toggleById[t.id];
            try { let p = t.actor.get_parent(); if (p) p.remove_child(t.actor); } catch (e) { }
            try { t.actor.destroy(); } catch (e) { }
        }
        this._customToggles = [];
        for (let c of list) {
            let def = c;
            let t = this._addToggle({
                id: 'custom:' + c.id, title: c.name || _('Custom tile'),
                icon: 'gicon:' + (c.icon || (c.kind === 'open' ? 'folder-symbolic' : c.kind === 'command' ? 'system-run-symbolic' : 'application-x-executable-symbolic')),
                shown: true,
                unavailableText: c.kind === 'app' ? _('App not found') : _('Unavailable'),
                onClicked: tile => this._activateCustom(def, tile),
            });
            t._custom = c;
            this._customToggles.push(t);
            if (c.kind === 'app') t.setAvailable(!!this._customAppInfo(c.app));
            if (c.kind === 'command') {
                let st = this.cfg('custom-tiles-state') || {};
                t.setChecked(!!st[c.id]);
            }
        }
        this._refreshCustomStatus();
        this.queueRelayout();
    }

    _customAppInfo(id) {
        if (!id) return null;
        try { return Gio.DesktopAppInfo.new(id); } catch (e) { return null; }
    }

    _activateCustom(c, tile) {
        if (c.kind === 'command') { this._runCustomCommand(c, tile); return; }
        // Opening something: close Quick Settings (or hide the preview) first.
        if (this._previewing) this._pausePreview(); else this.menu.close();
        if (c.kind === 'app') {
            // Cinnamon's app tracker focuses an open window instead of starting a second copy.
            try {
                let Cinnamon = imports.gi.Cinnamon;
                let app = Cinnamon.AppSystem.get_default().lookup_app(c.app);
                if (app) { app.activate(); return; }
            } catch (e) { }
            let info = this._customAppInfo(c.app);
            try { if (info) info.launch([], global.create_app_launch_context(0, -1)); } catch (e) {
                try { info.launch([], null); } catch (e2) { global.logError('[gqs] custom tile: ' + e2); }
            }
            return;
        }
        if (c.kind === 'open') {
            let target = String(c.target || '').trim();
            let uri;
            if (/^[a-z][a-z0-9+.-]*:/i.test(target)) uri = target;                 // https:, file:, mailto: ...
            else if (target.startsWith('~')) uri = Gio.File.new_for_path(GLib.get_home_dir() + target.slice(1)).get_uri();
            else if (target.startsWith('/')) uri = Gio.File.new_for_path(target).get_uri();
            else uri = 'https://' + target;                                          // "example.com"
            try { Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1)); }
            catch (e) { try { launch(['xdg-open', uri]); } catch (e2) { } }
        }
    }

    _runCustomCommand(c, tile) {
        let turnOn = !tile.checked;
        let cmd = turnOn ? c.on : c.off;
        tile.setChecked(turnOn);          // respond right away; the status check corrects it
        this._saveCustomState(c.id, turnOn);
        if (cmd) run(['bash', '-c', cmd], ok => {
            if (!ok) global.logError(`[gqs] custom tile "${c.name}": command failed: ${cmd}`);
            this._queue('custom-status-' + c.id, 1500, () => this._customStatus(c, tile));
        });
    }

    _saveCustomState(id, on) {
        let st = Object.assign({}, this.cfg('custom-tiles-state') || {});
        if (st[id] === on) return;
        st[id] = on;
        this._cfg_custom_tiles_state = st;
        this._syncingFromFile = true;
        try { this.settings.setValue('custom-tiles-state', st); } catch (e) { }
        this._syncingFromFile = false;
        this._changedKeys = null;
    }

    // Status command: on when it succeeds (exit code 0).
    _customStatus(c, tile) {
        if (!c.status || !tile || !this._customToggles.includes(tile)) return;
        run(['bash', '-c', c.status], (ok, out, code) => {
            if (!this._customToggles.includes(tile)) return;
            tile.setChecked(code === 0);
            this._saveCustomState(c.id, code === 0);
        });
    }

    _refreshCustomStatus() {
        for (let t of this._customToggles || []) {
            let c = t._custom;
            if (c.kind === 'command') this._customStatus(c, t);
            else if (c.kind === 'app') t.setAvailable(!!this._customAppInfo(c.app));
        }
    }

    // Battery pill + round buttons must fit on one line: use smaller buttons when they wouldn't.
    _fitTopRow() {
        if (!this._topRow) return;
        let buttons = [this._shotButton, this._customizeButton, this._configButton, this._settingsButton, this._lockButton, this._powerButton]
            .filter(b => b && b.visible).length;
        let pill = this._batteryPill.visible ? (this._batTimeLabel && this._batTimeLabel.visible ? 120 : 96) : 0;
        let tight = pill + buttons * 40 + buttons * 10 > (this._contentWidth || 376);
        if (tight) this._topRow.add_style_class_name('tight');
        else this._topRow.remove_style_class_name('tight');
    }

    _addTooltips() {
        if (this._tooltipsDone) return;
        this._tooltipsDone = true;
        let Tooltips;
        try { Tooltips = imports.ui.tooltips; } catch (e) { return; }
        let tips = [
            [this._shotButton, _('Screenshot')],
            [this._customizeButton, _('Edit tiles')],
            [this._configButton, _('Quick Settings settings')],
            [this._settingsButton, _('System Settings')],
            [this._lockButton, _('Lock')],
            [this._powerButton, _('Power Off / Log Out')],
        ];
        for (let [actor, text] of tips) {
            if (!actor) continue;
            try { new Tooltips.Tooltip(actor, text); } catch (e) { }
        }
    }

    // Opens this applet's Configure window (Layout / Panel / Appearance).
    _openConfigure(page) {
        this.menu.close();
        // Quick Settings' own settings window (GNOME style), if GTK for Python is there.
        let app = this.metadata.path + '/helpers/gqs-settings';
        if (hasProgram('python3') && GLib.file_test(app, GLib.FileTest.EXISTS) && !this._ownSettingsFailed) {
            let argv = ['python3', app, '--uuid', this.metadata.uuid, '--instance', String(this.instance_id),
                '--path', this.metadata.path, '--page', page || 'home'];
            // Tell the window exactly which settings file Cinnamon is using for this applet.
            try { let f = this.settings.file.get_path(); if (f) argv.push('--file', f); } catch (e) { }
            this._launchSingle(argv);
            return;
        }
        this._openClassicConfigure();
    }

    // Cinnamon's standard settings window.
    _openClassicConfigure() {
        if (hasProgram('xlet-settings')) {
            this._launchSingle(['xlet-settings', 'applet', this.metadata.uuid, '-i', String(this.instance_id)]);
            return;
        }
        this._launchSingle(['cinnamon-settings', 'applets', this.metadata.uuid]);
    }

    configureApplet() {
        this._openConfigure();
    }

    _iconButton(names, cb, noGuard) {
        let b = align(fill(new St.Button({
            style_class: 'gqs-icon-button', can_focus: true,
            child: new St.Icon({ gicon: themedIcon(names), icon_size: 16, x_align: CENTER, y_align: CENTER, x_expand: true, y_expand: true }),
        })), null, CENTER);
        b.connect('clicked', () => {
            if (!noGuard && this.guardClick()) return;
            cb();
        });
        return b;
    }

    _sliderRow(iconNames, onIconClick, onChange, withArrow) {
        let row = new St.BoxLayout({ style_class: 'gqs-slider-row', x_expand: true });
        let icon = new St.Icon({ gicon: themedIcon(iconNames), icon_size: 16, x_align: CENTER, y_align: CENTER, x_expand: true, y_expand: true });
        let btn = align(fill(new St.Button({ style_class: 'gqs-slider-icon', child: icon, can_focus: !!onIconClick })), null, CENTER);
        if (onIconClick) btn.connect('clicked', onIconClick);
        else { btn.reactive = false; btn.add_style_class_name('flat'); }
        let slider = new QSSlider(onChange);
        this._sliders.push(slider);
        row.add_child(btn);
        row.add_child(slider.actor);

        let result = { row, icon, slider, arrow: null, owner: null };
        if (withArrow) {
            let arrowIcon = new St.Icon({ icon_name: 'go-next-symbolic', icon_size: 16, x_align: CENTER, y_align: CENTER, x_expand: true, y_expand: true });
            let arrow = align(fill(new St.Button({ style_class: 'gqs-slider-arrow', child: arrowIcon, can_focus: true, visible: false })), null, CENTER);
            row.add_child(arrow);
            result.arrow = arrow;
            result.owner = {
                shown: true,
                setMenuOpen: open => this.rotateArrow(arrowIcon, open),
            };
        }
        return result;
    }

    _addToggle(params) {
        let t = new QSToggle(this, params);
        this._toggles.push(t);
        this._toggleById[t.id] = t;
        return t;
    }

    queueRelayout() {
        this._queue('relayout', 0, () => this._relayout());
    }

    /* ---------- card layout: scrolling content + notification placement ---------- */

    // Card (_main) > shell (row or column) > [scroll view > content] (+ notifications at a side).
    _wrapContent() {
        let kids = this._main.get_children();
        this._content = new St.BoxLayout({ vertical: true, style_class: 'gqs-content', x_expand: true });
        for (let c of kids) { this._main.remove_child(c); this._content.add_child(c); }
        this._qsScroll = new St.ScrollView({ style_class: 'gqs-qs-scroll', x_expand: true, y_expand: true });
        setScrollPolicy(this._qsScroll);
        try { this._qsScroll.overlay_scrollbars = false; } catch (e) { }
        setScrollChild(this._qsScroll, this._content);
        this._shell = new St.BoxLayout({ style_class: 'gqs-shell', x_expand: true });
        this._shell.add_child(this._qsScroll);
        this._main.add_child(this._shell);
        try { this._connect(Main.layoutManager, 'monitors-changed', () => this._fitToScreen()); } catch (e) { }
    }

    _notifSide() {
        let pos = this.cfg('notifications-position');
        return pos === 'left' || pos === 'right';
    }

    _placeNotifications() {
        if (!this._notif || !this._content) return;
        let a = this._notif.actor;
        let parent = a.get_parent();
        if (parent) parent.remove_child(a);
        let pos = this.cfg('notifications-position');
        if (pos === 'left' || pos === 'right') {
            a.add_style_class_name('side');
            if (pos === 'left') this._shell.insert_child_at_index(a, 0);
            else this._shell.add_child(a);
        } else {
            a.remove_style_class_name('side');
            if (pos === 'top') this._content.insert_child_at_index(a, 0);
            else this._content.add_child(a);
        }
        this._renderNotifications();
        this._fitToScreen();
    }

    // Keep the whole card on screen (between the panels); the content scrolls when taller.
    _fitToScreen() {
        if (!this._qsScroll) return;
        let avail = 0;
        try {
            let mi = this.panel && this.panel.monitorIndex !== undefined ? this.panel.monitorIndex : Main.layoutManager.primaryIndex;
            let mon = Main.layoutManager.monitors[mi] || Main.layoutManager.primaryMonitor;
            avail = mon.height;
            let panels = [];
            try { panels = Main.panelManager.getPanelsInMonitor(mi) || []; } catch (e) { panels = this.panel ? [this.panel] : []; }
            for (let p of panels) {
                let side = p.panelPosition !== undefined ? p.panelPosition : null;
                let h = p.actor ? p.actor.height : (p.height || 0);
                // top (0) and bottom (1) panels take height; side panels don't
                if (side === null || side === 0 || side === 1) avail -= h;
            }
        } catch (e) { avail = global.stage.height - 80; }
        // card padding + border + menu margin + breathing room
        let maxH = Math.max(240, Math.floor(avail - 14 * 2 - 2 - 6 * 2 - 16));
        this._maxContentHeight = maxH;
        this._qsScroll.set_style(`max-height: ${maxH}px;`);
        if (this._notif) {
            let listMax = this._notifSide() ? Math.max(160, maxH - 64) : 320;
            this._notif.scroll.set_style(`max-height: ${listMax}px;`);
        }
    }

    /* ---------- tiles: pages, compact row, edit mode ---------- */

    // Every toggle as {item, show, page}, in your order (saved list first, new toggles after).
    _layoutRows() {
        let list = this.cfg('toggle-layout');
        let rows = [], seen = new Set();
        if (Array.isArray(list)) {
            for (let row of list) {
                if (!row) continue;
                let t = this._toggleById[String(row.item || '').trim()];
                if (!t || seen.has(t)) continue;
                seen.add(t);
                rows.push({ item: t.id, show: row.show !== false });
            }
        }
        // Not in the saved list yet: GNOME's default tiles are shown, everything else starts hidden.
        for (let t of this._toggles) if (!seen.has(t)) rows.push({ item: t.id, show: DEFAULT_SHOWN_TILES.includes(t.id) });
        return rows;
    }

    _saveLayoutRows(rows) {
        if (!this.settings) return;
        try { this.settings.setValue('toggle-layout', rows.map(r => ({ item: r.item, show: r.show }))); }
        catch (e) { global.logError('[gqs] save layout: ' + e); }
    }

    // Tiles per page: columns x rows (4 rows by default, like Android).
    _pageCapacity() {
        let rowsPerPage = Math.max(1, Math.min(8, parseInt(this.cfg('rows-per-page')) || 4));
        return this._tileCols() * rowsPerPage;
    }

    _visibleTiles(rows) {
        return rows.filter(r => r.show).map(r => this._toggleById[r.item]).filter(t => t && t.shown);
    }

    // Tiles flow in your order and fill each page; the rest continue on the next page.
    _pages(rows) {
        let tiles = this._visibleTiles(rows), cap = this._pageCapacity(), pages = [];
        for (let i = 0; i < tiles.length; i += cap) pages.push(tiles.slice(i, i + cap));
        return pages.length ? pages : [[]];
    }

    _tilesOn(rows, page) {
        return this._pages(rows)[page - 1] || [];
    }

    _pageCount(rows) {
        return this._pages(rows).length;
    }

    _pageOf(rows, toggle) {
        let idx = this._visibleTiles(rows).indexOf(toggle);
        return idx < 0 ? 1 : Math.floor(idx / this._pageCapacity()) + 1;
    }

    // All visible tiles in order — used for the compact row.
    _orderedToggles() {
        return this._visibleTiles(this._curRows || this._layoutRows());
    }

    _isCompact() {
        return !!(this._notifExpanded && this.cfg('notif-compact') && this.cfg('show-notifications') && this._notifAvailable && !this._editing && !this._notifSide());
    }

    // Remove rows from a container without destroying the tiles (they're reused).
    _clearTiles(container) {
        let old = container.get_children();
        for (let c of old) if (c._gqsRow) c.remove_all_children();
        container.remove_all_children();
        for (let c of old) if (c._gqsRow) c.destroy();
    }

    _fillTiles(container, tiles, cols, withMenus) {
        for (let i = 0; i < tiles.length; i += cols) {
            let row = new St.BoxLayout({ style_class: 'gqs-grid-row', x_expand: true });
            row._gqsRow = true;
            try { row.layout_manager.homogeneous = true; } catch (e) { }
            let group = tiles.slice(i, i + cols);
            for (let t of group) {
                let parent = t.actor.get_parent();
                if (parent) parent.remove_child(t.actor);
                row.add_child(t.actor);
            }
            for (let k = group.length; k < cols; k++) row.add_child(new St.Widget({ x_expand: true }));
            container.add_child(row);
            if (withMenus) for (let t of group) if (t.menu) {
                let mp = t.menu.actor.get_parent();
                if (mp) mp.remove_child(t.menu.actor);
                container.add_child(t.menu.actor);
            }
        }
    }

    _relayout(rowsOverride) {
        let rows = rowsOverride || (this._editing && this._editDraft ? this._editDraft : this._layoutRows());
        this._curRows = rows;
        let cols = this._tileCols();
        let editing = !!this._editing;
        let compact = this._isCompact();

        this._clearTiles(this._grid);
        this._clearTiles(this._trayGrid);
        for (let t of this._toggles) {           // detach anything not placed this time
            let p = t.actor.get_parent();
            if (p) p.remove_child(t.actor);
            if (t.menu) { let mp = t.menu.actor.get_parent(); if (mp) mp.remove_child(t.menu.actor); }
        }

        let pages = this._pageCount(rows);
        this._page = Math.max(1, Math.min(pages, this._page || 1));
        let pageTiles = this._tilesOn(rows, this._page);

        this._grid.visible = !compact;
        this._fillTiles(this._grid, pageTiles, cols, !editing);
        if (pages > 1 && !compact && this.cfg('keep-page-height')) {
            // Keep every page the same height (a short last page gets empty rows).
            let rowsPerPage = Math.ceil(this._pageCapacity() / cols);
            for (let r = Math.ceil(pageTiles.length / cols); r < rowsPerPage; r++) {
                let filler = new St.Widget({ style_class: 'gqs-tile-filler', x_expand: true });
                filler._gqsRow = true;
                this._grid.add_child(filler);
            }
        }
        if (editing && !pageTiles.length && pages === 1) {
            let empty = new St.Label({ text: _('Drop tiles here'), style_class: 'gqs-empty-page', x_expand: true });
            empty._gqsRow = true;
            this._grid.add_child(empty);
        }
        this._buildDots(pages);
        this._dots.visible = !compact && pages > 1;

        let hidden = rows.filter(r => !r.show).map(r => this._toggleById[r.item]).filter(t => t && t.shown);
        this._trayBox.visible = editing;
        // Hidden tiles: 4 rows per page, the rest on the next page.
        let trayCap = cols * 4;
        let trayPages = Math.max(1, Math.ceil(hidden.length / trayCap));
        this._trayPage = Math.max(1, Math.min(this._trayPage || 1, trayPages));
        let trayTiles = hidden.slice((this._trayPage - 1) * trayCap, this._trayPage * trayCap);
        this._fillTiles(this._trayGrid, trayTiles, cols, false);
        // Every tray page keeps the height of a full page: a short page gets invisible spacer rows
        // the height of a real row (tiles themselves keep their normal size). The row height is
        // measured from the tiles once they're laid out.
        let fullPage = trayTiles.length >= trayCap;
        if (this._trayFullCols !== cols) { this._trayFullCols = cols; this._trayRowH = 0; this._trayFullH = 0; }
        if (trayPages > 1 && !fullPage) {
            let used = Math.ceil(trayTiles.length / cols);
            let rowH = this._trayRowH || 52;
            for (let r = used; r < 4; r++) {
                let spacer = new St.Widget({ style_class: 'gqs-tray-spacer', x_expand: true, y_expand: false });
                spacer.set_style(`height: ${rowH}px; min-height: ${rowH}px;`);
                spacer._gqsRow = true;
                this._trayGrid.add_child(spacer);
            }
        }
        this._queue('tray-measure', 80, () => {
            let kids = this._trayGrid.get_children();
            let spacers = kids.filter(c => c.has_style_class_name && c.has_style_class_name('gqs-tray-spacer'));
            let rows = kids.filter(c => c._gqsRow && !spacers.includes(c));
            let h = Math.max(0, ...rows.map(r => r.height || 0));
            if (h > 0) this._trayRowH = Math.ceil(h);
            if (!spacers.length && rows.length >= 4) {
                // A full page: remember its exact height for the shorter pages.
                if (this._trayGrid.height > 0) this._trayFullH = Math.ceil(this._trayGrid.height);
            } else if (spacers.length && this._trayFullH) {
                // A short page: share out whatever is still missing so it matches exactly.
                let missing = this._trayFullH - this._trayGrid.height;
                if (Math.abs(missing) >= 1) {
                    let each = Math.max(0, Math.round((spacers[0].height || this._trayRowH) + missing / spacers.length));
                    for (let sp of spacers) sp.set_style(`height: ${each}px; min-height: ${each}px;`);
                }
            }
        });
        this._trayNav.visible = editing && trayPages > 1;
        setText(this._trayPageLabel, `${this._trayPage}/${trayPages}`);
        this._trayPrev.reactive = this._trayPage > 1;
        this._trayPrev.opacity = this._trayPage > 1 ? 255 : 90;
        this._trayNext.reactive = this._trayPage < trayPages;
        this._trayNext.opacity = this._trayPage < trayPages ? 255 : 90;
        if (this._qsScroll && this._qsScroll._gqsQueueCheck) this._qsScroll._gqsQueueCheck();
        this._trayEmpty.visible = editing && !hidden.length;

        this._compactRow.visible = compact;
        if (compact) this._buildCompact();

        let placed = new Set(pageTiles);
        if (this._openMenu && this._openMenu.owner instanceof QSToggle && (!placed.has(this._openMenu.owner) || compact || editing))
            this.closeSubmenu(true);
        else
            this._applyDim();
    }

    // Hidden tiles tray: go to the previous/next page.
    _trayFlip(step) {
        let rows = this._editDraft || this._curRows || this._layoutRows();
        let hidden = rows.filter(r => !r.show).map(r => this._toggleById[r.item]).filter(t => t && t.shown);
        let pages = Math.max(1, Math.ceil(hidden.length / (this._tileCols() * 4)));
        let next = Math.max(1, Math.min(pages, (this._trayPage || 1) + step));
        if (next === this._trayPage) return;
        this._trayPage = next;
        this._relayout();
        if (this._animFactor()) {
            this._trayGrid.opacity = 0;
            this._trayGrid.translation_x = step > 0 ? 16 : -16;
            this._ease(this._trayGrid, { opacity: 255, translation_x: 0 }, 180);
        }
    }

    _buildDots(pages) {
        this._dots.destroy_all_children();
        if (pages <= 1) return;
        for (let p = 1; p <= pages; p++) {
            let dot = new St.Button({ style_class: 'gqs-page-dot', can_focus: true });
            if (p === this._page) dot.add_style_class_name('active');
            try { dot.set_accessible_name(`${_('Page')} ${p}`); } catch (e) { }
            dot.connect('clicked', () => this._setPage(p));
            this._dots.add_child(dot);
        }
        this.paintAccentDots();
    }

    paintAccentDots() {
        for (let d of this._dots.get_children())
            this.paintAccent(d, d.has_style_class_name && d.has_style_class_name('active'));
    }

    _setPage(p, rowsOverride) {
        let pages = this._pageCount(rowsOverride || this._curRows || this._layoutRows());
        p = Math.max(1, Math.min(pages, p));
        if (p === this._page && !rowsOverride) return;
        let dir = p > this._page ? 1 : -1;
        this._page = p;
        this.closeSubmenu(true);
        this._relayout(rowsOverride || (this._editing ? this._curRows : null));
        if (this._animFactor()) {
            this._grid.translation_x = 24 * dir;
            this._grid.opacity = 120;
            this._ease(this._grid, { translation_x: 0, opacity: 255 }, 180);
        }
    }

    _onTilesScroll(event) {
        if (this._isCompact() || this._drag) return Clutter.EVENT_PROPAGATE;
        let dir = event.get_scroll_direction();
        let step = 0;
        if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT) step = 1;
        else if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT) step = -1;
        else if (dir === Clutter.ScrollDirection.SMOOTH) {
            let [dx, dy] = event.get_scroll_delta();
            let d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
            this._scrollAcc = (this._scrollAcc || 0) + d;
            if (Math.abs(this._scrollAcc) < 1) return Clutter.EVENT_STOP;
            step = this._scrollAcc > 0 ? 1 : -1;
            this._scrollAcc = 0;
        }
        let pages = this._pageCount(this._curRows || this._layoutRows());
        if (step && pages > 1) { this._setPage(this._page + step); return Clutter.EVENT_STOP; }
        return Clutter.EVENT_PROPAGATE;
    }

    /* Compact row: the first 6 tiles as round icon buttons (like Android). */
    _buildCompact() {
        this._compactRow.destroy_all_children();
        this._compactButtons = [];
        let tiles = this._orderedToggles().slice(0, this._compactCount());
        for (let t of tiles) {
            let icon = new St.Icon({ icon_size: 18, x_align: CENTER, y_align: CENTER, x_expand: true, y_expand: true });
            let b = align(fill(new St.Button({ style_class: 'gqs-round-tile', child: icon, can_focus: true })), CENTER, CENTER);
            try { b.set_accessible_name(t.title); } catch (e) { }
            b.connect('clicked', () => { if (this.guardClick()) return; t.activate(); });
            b.connect('notify::hover', () => this.paintAccent(b, t.checked));
            b._gqsToggle = t;
            b._gqsIcon = icon;
            this._compactRow.add_child(b);
            this._compactButtons.push(b);
        }
        for (let k = tiles.length; k < this._compactCount(); k++) this._compactRow.add_child(new St.Widget({ x_expand: true }));
        this._syncCompact();
    }

    // Round buttons are 48px with 8px gaps: 6 at GNOME's width, more when the menu is wider.
    // Tiles per row for the chosen tile style.
    _tileCols() {
        let style = this._tileStyleName || 'long';
        if (style === 'round') {
            // Round buttons are 52px with 8px gaps: fit as many as the card is wide, never more.
            let w = (this._contentWidth || 376);
            return Math.max(4, Math.floor((w + 8) / 60));
        }
        if (style === 'small') return this._columns || 2;   // one small tile per column, as chosen
        return this._columns || 2;
    }

    _applyTileStyle() {
        let style = this.cfg('tile-style');
        if (!['long', 'round', 'small'].includes(style)) style = 'long';
        this._tileStyleName = style;
        for (let x of ['long', 'round', 'small']) {
            if (x === style) this._main.add_style_class_name('gqs-tiles-' + x);
            else this._main.remove_style_class_name('gqs-tiles-' + x);
        }
        let showLabels = this.cfg('tile-labels') !== false;
        if (showLabels) this._main.remove_style_class_name('gqs-tiles-nolabels');
        else this._main.add_style_class_name('gqs-tiles-nolabels');
        for (let t of this._toggles) t.setTileStyle(style, showLabels);
    }

    _compactCount() {
        let w = this._contentWidth || 376;
        return Math.max(COMPACT_TILES, Math.floor((w + 8) / 56));
    }

    queueCompactSync() {
        if (!this._compactButtons || !this._compactButtons.length) return;
        this._queue('compact', 30, () => this._syncCompact());
    }

    _syncCompact() {
        for (let b of this._compactButtons || []) {
            let t = b._gqsToggle;
            if (t.iconNames) setGicon(b._gqsIcon, t.iconNames);
            if (t.checked) b.add_style_class_name('checked'); else b.remove_style_class_name('checked');
            if (t.available) b.remove_style_class_name('unavailable'); else b.add_style_class_name('unavailable');
            this.paintAccent(b, t.checked);
        }
    }

    /* Edit mode: drag tiles to reorder, across pages, or into the hidden tray. */
    _setEditing(on) {
        if (!!this._editing === !!on) return;
        this._cancelDrag();
        this._editing = !!on;
        this.closeSubmenu(true);
        if (on) this._main.add_style_class_name('gqs-editing');
        else this._main.remove_style_class_name('gqs-editing');
        this._editBar.visible = !!on;
        if (on) this._customizeButton.add_style_class_name('checked');
        else this._customizeButton.remove_style_class_name('checked');
        this.paintAccent(this._customizeButton, !!on);
        if (on) {
            this._trayPage = 1;   // the hidden tiles always start on their first page
            let rows = this._layoutRows();
            this._editOriginal = this._rowsKey(rows);
            this._editDraft = rows.map(r => Object.assign({}, r));
        } else {
            this._editDraft = null;
            this._editOriginal = null;
        }
        this._selectTile(null);
        this._updateRows();
        this._relayout();
    }

    /* Unsaved edits: changes stay in a draft until Done (or Save in the prompt). */
    _rowsKey(rows) {
        return JSON.stringify(rows.map(r => [r.item, !!r.show]));
    }

    _editDirty() {
        return !!(this._editing && this._editDraft && this._rowsKey(this._editDraft) !== this._editOriginal);
    }

    _finishEditing(save) {
        if (save && this._editDraft) this._saveLayoutRows(this._editDraft);
        this._setEditing(false);
    }

    // Leaving edit mode: ask first if there are unsaved changes.
    _requestExitEdit(reason) {
        if (!this._editDirty()) { this._finishEditing(false); return; }
        if (this._editDialog) return;
        let keepEditing = () => {
            if (!this.menu.isOpen) this.menu.open(false);
        };
        let buttons = reason === 'cancel'
            ? [
                { label: _('Keep Editing'), action: keepEditing, key: Clutter.KEY_Escape },
                { label: _('Discard Changes'), action: () => this._finishEditing(false), default: true },
            ]
            : [
                { label: _('Keep Editing'), action: keepEditing, key: Clutter.KEY_Escape },
                { label: _('Discard'), action: () => this._finishEditing(false) },
                { label: _('Save'), action: () => this._finishEditing(true), default: true },
            ];
        let title = reason === 'cancel' ? _('Discard your tile changes?') : _('Save your tile changes?');
        let body = reason === 'cancel'
            ? _('The tiles you moved or hid will go back to how they were.')
            : _('You moved or hid tiles but haven\'t pressed Done yet.');
        this._showDialog(title, body, buttons, () => {
            // Closing the dialog any other way keeps your edits for later.
            if (this._editing && !this.menu.isOpen) keepEditing();
        });
    }

    _showDialog(title, body, buttons, onDismiss, onError) {
        let done = false;
        let wrap = fn => () => {
            if (done) return;
            done = true;
            if (this._editDialog) { try { this._editDialog.close(); } catch (e) { } }
            this._editDialog = null;
            if (fn) fn();
        };
        try {
            const ModalDialog = imports.ui.modalDialog;
            let dialog = new ModalDialog.ModalDialog();
            dialog.contentLayout.add_child(wrapLabel(new St.Label({ text: title, style_class: 'gqs-confirm-title' })));
            // Wrap the message onto as many lines as it needs (St labels cut it off with "…" otherwise).
            dialog.contentLayout.add_child(wrapLabel(new St.Label({ text: body, style_class: 'gqs-confirm-body' })));
            dialog.setButtons(buttons.map(b => Object.assign({}, b, { action: b.disabled ? () => { } : wrap(b.action) })));
            // Greyed-out buttons: shown, but they can't be clicked, focused or triggered with Enter.
            let box = dialog.buttonLayout || dialog._buttonLayout;
            this._accentDialogButtons(dialog, buttons);
            if (box) for (let child of box.get_children()) {
                let info = buttons.find(b => b.disabled && b.label === child.label);
                if (!info) continue;
                child.reactive = false;
                child.can_focus = false;
                child.add_style_class_name('gqs-dialog-disabled');
                child.opacity = 115;
            }
            try { dialog.connect('closed', () => { if (!done) wrap(onDismiss)(); }); } catch (e) { }
            this._editDialog = dialog;
            dialog.open();
        } catch (e) {
            // No dialog available: keep the user's work rather than losing it.
            global.logError('[gqs] confirm dialog: ' + e);
            this._editDialog = null;
            if (onError) onError();
            else this._finishEditing(true);
        }
    }

    // The main (default) button of a dialog uses the accent colour, like tiles that are on.
    _accentDialogButtons(dialog, buttons) {
        let box = dialog.buttonLayout || dialog._buttonLayout;
        if (!box) return;
        for (let child of box.get_children()) {
            let info = buttons.find(b => b.default && !b.disabled && b.label === child.label);
            if (!info) continue;
            let fg = needsDarkText(this._accent.base) ? '#202020' : '#ffffff';
            let paint = () => child.set_style(
                `background-color: ${cssColor(child.hover ? this._accent.hover : this._accent.base)}; color: ${fg};`);
            paint();
            child.connect('notify::hover', paint);
        }
    }

    _toggleFromActor(actor) {
        while (actor && actor !== this._main) {
            if (actor._gqsToggle && actor._gqsToggle.actor === actor) return actor._gqsToggle;
            actor = actor.get_parent();
        }
        return null;
    }

    _rectOf(actor) {
        let [x, y] = actor.get_transformed_position();
        let [w, h] = actor.get_transformed_size();
        return { x, y, w, h };
    }

    _inside(actor, x, y) {
        if (!actor || !actor.visible || !actor.get_stage()) return false;
        let r = this._rectOf(actor);
        return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    }

    _onEditEvent(event) {
        if (!this._editing) return Clutter.EVENT_PROPAGATE;
        let type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS) {
            if (event.get_button() !== 1 || this._drag) return Clutter.EVENT_PROPAGATE;
            let t = this._toggleFromActor(event.get_source());
            if (!t) return Clutter.EVENT_PROPAGATE;     // Done, toolbar and page dots keep working
            let [x, y] = event.get_coords();
            this._drag = { t, x0: x, y0: y, active: false, device: null };
            // While the button is held, motion/release are delivered straight to the grabbing
            // actor (not through captured-event), so listen on it directly — like the sliders.
            this._dragMotionId = this._main.connect('motion-event', (a, e) => this._onDragMotion(e));
            this._dragReleaseId = this._main.connect('button-release-event', (a, e) => this._onDragRelease(e));
            try { let dev = event.get_device(); dev.grab(this._main); this._drag.device = dev; } catch (e) { }
            return Clutter.EVENT_STOP;
        }
        // Tiles don't act while editing.
        if ((type === Clutter.EventType.BUTTON_RELEASE) && !this._drag && this._toggleFromActor(event.get_source()))
            return Clutter.EVENT_STOP;
        return Clutter.EVENT_PROPAGATE;
    }

    _onDragMotion(event) {
        if (!this._drag) return Clutter.EVENT_PROPAGATE;
        let [x, y] = event.get_coords();
        if (!this._drag.active && Math.hypot(x - this._drag.x0, y - this._drag.y0) > 6) this._beginDrag(x, y);
        if (this._drag && this._drag.active) this._dragMove(x, y);
        return Clutter.EVENT_STOP;
    }

    _onDragRelease(event) {
        if (!this._drag) return Clutter.EVENT_PROPAGATE;
        let tapped = !this._drag.active ? this._drag.t : null;
        this._endDrag();
        if (tapped) this._selectTile(this._editSel === tapped ? null : tapped);
        return Clutter.EVENT_STOP;
    }

    /* Tap-to-select editing: move the selected tile with the toolbar buttons. */
    _selectTile(t) {
        if (this._editSel) this._editSel.actor.remove_style_class_name('gqs-selected');
        this._editSel = t;
        if (t) t.actor.add_style_class_name('gqs-selected');
        this._syncEditTools();
    }

    _syncEditTools() {
        let t = this._editSel;
        this._editTools.visible = !!t;
        this._editHint.visible = !t;
        if (!t) return;
        let rows = this._curRows || this._layoutRows();
        let row = rows.find(r => r.item === t.id);
        let hidden = row && !row.show;
        setText(this._editSelLabel, hidden ? `${t.title} (${_('hidden')})` : t.title);
        let order = this._visibleTiles(rows);
        let i = order.indexOf(t);
        let page = this._pageOf(rows, t), pages = this._pageCount(rows);
        let set = (b, on) => { b.reactive = on; b.opacity = on ? 255 : 90; };
        set(this._toolBack, !hidden && i > 0);
        set(this._toolForward, !hidden && i >= 0 && i < order.length - 1);
        set(this._toolPrevPage, !hidden && page > 1);
        set(this._toolNextPage, !hidden && (page < pages || (this._tilesOn(rows, page).length >= this._pageCapacity() && i < order.length - 1)));
        setGicon(this._toolHide.get_child(), hidden ? ['view-reveal-symbolic', 'list-add-symbolic'] : ['view-conceal-symbolic', 'list-remove-symbolic']);
        try { this._toolHide.set_accessible_name(hidden ? _('Show') : _('Hide')); } catch (e) { }
    }

    _editMove(action) {
        let t = this._editSel;
        if (!t) return;
        let rows = (this._editDraft || this._curRows || this._layoutRows()).map(r => Object.assign({}, r));
        let me = rows.find(r => r.item === t.id);
        let order = this._visibleTiles(rows);
        let i = order.indexOf(t);
        let cap = this._pageCapacity();
        if (action === 'toggle-hide') {
            me.show = !me.show;
            if (me.show) this._placeRow(rows, me, null, order[order.length - 1] || null);
        } else if (action === 'back' && i > 0) {
            this._placeRow(rows, me, order[i - 1], null);
        } else if (action === 'forward' && i >= 0 && i < order.length - 1) {
            this._placeRow(rows, me, null, order[i + 1]);
        } else if (action === 'prev-page' || action === 'next-page') {
            let others = rows.filter(r => r !== me);
            let pages = this._pages(others);
            let page = this._pageOf(rows, t);
            if (action === 'next-page') {
                let next = pages[page];               // page after mine (0-based index = page)
                if (next && next.length) this._placeRow(rows, me, next[0], null);
                else this._placeRow(rows, me, null, null);
            } else {
                let prev = pages[page - 2] || [];
                let last = prev[prev.length - 1] || null;
                if (last && prev.length >= cap) this._placeRow(rows, me, last, null);
                else this._placeRow(rows, me, null, last);
            }
        } else {
            return;
        }
        this._editDraft = rows;
        if (me.show) this._page = this._pageOf(rows, t);
        this._relayout(rows);
        t.actor.add_style_class_name('gqs-selected');
        this._syncEditTools();
    }

    _disconnectDragSignals() {
        if (this._dragMotionId) { this._main.disconnect(this._dragMotionId); this._dragMotionId = 0; }
        if (this._dragReleaseId) { this._main.disconnect(this._dragReleaseId); this._dragReleaseId = 0; }
    }

    _beginDrag(x, y) {
        let d = this._drag;
        d.active = true;
        let r = this._rectOf(d.t.actor);
        d.dx = x - r.x;
        d.dy = y - r.y;
        d.clone = new Clutter.Clone({ source: d.t.actor, reactive: false });
        d.clone.set_size(r.w, r.h);
        d.clone.set_position(r.x, r.y);
        d.clone.opacity = 235;
        try {
            Main.uiGroup.add_child(d.clone);
            Main.uiGroup.set_child_above_sibling(d.clone, null);
        } catch (e) { global.stage.add_child(d.clone); }
        d.clone.set_pivot_point(0.5, 0.5);
        this._ease(d.clone, { scale_x: 1.06, scale_y: 1.06 }, 120);
        d.t.actor.opacity = 70;
        d.rows = this._curRows.map(r => Object.assign({}, r));
    }

    // Move the dragged tile within the working copy of the layout and re-layout live.
    _dragMove(x, y) {
        let d = this._drag;
        d.clone.set_position(x - d.dx, y - d.dy);
        let rows = d.rows;
        let me = rows.find(r => r.item === d.t.id);

        if (this._inside(this._trayBox, x, y)) {
            if (me.show) {
                me.show = false;
                d.lastKey = null;
                this._relayout(rows);
                d.t.actor.opacity = 70;
            }
            this._clearEdgeTimer();
            return;
        }

        // Hold at the left/right edge to move to the previous/next page.
        let g = this._rectOf(this._tilesBox);
        let inTiles = this._inside(this._tilesBox, x, y);
        if (inTiles && (x < g.x + 26 || x > g.x + g.w - 26)) {
            let dir = x < g.x + 26 ? -1 : 1;
            if (!this._edgeTimer) this._edgeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 550, () => {
                this._edgeTimer = 0;
                if (!this._drag) return GLib.SOURCE_REMOVE;
                let others = rows.filter(r => r !== me);
                let pages = this._pages(others);
                let target = this._page + dir;
                if (target < 1) return GLib.SOURCE_REMOVE;
                if (dir > 0) {
                    // first spot of the next page (or a new page after a full last one)
                    let next = pages[this._page];
                    if (next && next.length) this._placeRow(rows, me, next[0], null);
                    else if ((pages[this._page - 1] || []).length >= this._pageCapacity()) this._placeRow(rows, me, null, null);
                    else return GLib.SOURCE_REMOVE;
                } else {
                    // last spot of the previous page; if it's full, its last tile moves along
                    let prev = pages[target - 1] || [];
                    let last = prev[prev.length - 1] || null;
                    if (last && prev.length >= this._pageCapacity()) this._placeRow(rows, me, last, null);
                    else this._placeRow(rows, me, null, last);
                }
                me.show = true;
                this._page = this._pageOf(rows, d.t);
                d.lastKey = null;
                this._relayout(rows);
                d.t.actor.opacity = 70;
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._clearEdgeTimer();
        }
        if (!inTiles) return;

        // Where in this page's reading order does the pointer fall?
        let tiles = this._tilesOn(rows, this._page).filter(t => t !== d.t);
        let before = null;
        for (let t of tiles) {
            let r = this._rectOf(t.actor);
            let rowMatch = y >= r.y && y <= r.y + r.h;
            if (y < r.y || (rowMatch && x < r.x + r.w / 2)) { before = t; break; }
        }
        let after = before ? null : (tiles[tiles.length - 1] || null);
        let key = `${before ? 'b:' + before.id : 'a:' + (after ? after.id : '')}|${me.show}`;
        if (key === d.lastKey) return;
        d.lastKey = key;
        if (before || after) this._placeRow(rows, me, before, after);
        me.show = true;
        this._relayout(rows);
        d.t.actor.opacity = 70;
    }

    // Move row `me` just before tile `before`, or just after tile `after` (or to the end).
    _placeRow(rows, me, before, after) {
        rows.splice(rows.indexOf(me), 1);
        let at = rows.length;
        if (before) at = rows.findIndex(r => r.item === before.id);
        else if (after) at = rows.findIndex(r => r.item === after.id) + 1;
        if (at < 0) at = rows.length;
        rows.splice(at, 0, me);
    }

    _clearEdgeTimer() {
        if (this._edgeTimer) { GLib.source_remove(this._edgeTimer); this._edgeTimer = 0; }
    }

    _endDrag() {
        let d = this._drag;
        this._drag = null;
        this._clearEdgeTimer();
        this._disconnectDragSignals();
        if (!d) return;
        if (d.device) { try { d.device.ungrab(); } catch (e) { } }
        if (d.clone) d.clone.destroy();
        d.t.actor.opacity = 255;
        if (d.active) {
            this._editDraft = d.rows;
            this._relayout(d.rows);
            if (this._editSel) this._syncEditTools();
        }
    }

    _cancelDrag() {
        this._disconnectDragSignals();
        if (!this._drag) return;
        let d = this._drag;
        this._drag = null;
        this._clearEdgeTimer();
        if (d.device) { try { d.device.ungrab(); } catch (e) { } }
        if (d.clone) d.clone.destroy();
        d.t.actor.opacity = 255;
    }

    _updateRows() {
        let editing = !!this._editing;
        let compact = this._isCompact();
        let volOk = !!this._avail.volume && this.cfg('slider-volume') && !editing && !compact;
        this._volume.row.visible = volOk;
        this._volume.arrow.visible = volOk && this.cfg('output-picker') && (this._outputs ? this._outputs.size > 1 : false);

        let brightOk = !!this._avail.brightness && this.cfg('slider-brightness') && !editing;
        this._brightness.row.visible = brightOk;

        let mode = this.cfg('mic-slider');
        let micOk = !!this._source && (mode === 'always' || (mode === 'recording' && this._recording)) && !editing && !compact;
        this._mic.row.visible = micOk;
        this._mic.arrow.visible = micOk && this.cfg('input-picker') && (this._inputs ? this._inputs.size > 1 : false);

        let mediaOn = this.cfg('show-media-card') && !!this._currentPlayer() && !editing;
        if (this._notif) this._notif.actor.visible = !!(this.cfg('show-notifications') && this._notifAvailable && !editing);
        if (mediaOn && !this._media.actor.visible) {
            this._media.actor.opacity = 0;
            this._media.actor.visible = true;
            this._ease(this._media.actor, { opacity: 255 }, 250);
        } else if (!mediaOn) {
            this._media.actor.visible = false;
        }

        let menuRows = [[this._volumeMenu, this._volume], [this._micMenu, this._mic]];
        for (let [menu, row] of menuRows) {
            if (this._openMenu === menu && !(row.row.visible && row.arrow.visible)) this.closeSubmenu();
        }
    }

    /* ---------- submenus ---------- */

    guardClick() {
        if (this._openMenu) {
            this.closeSubmenu();
            return true;
        }
        return false;
    }

    toggleSubmenu(menu) {
        if (this._openMenu === menu) { this.closeSubmenu(); return; }
        this.closeSubmenu();
        this._openMenu = menu;
        if (menu.onOpen) { try { menu.onOpen(); } catch (e) { global.logError('[gqs] ' + e); } }
        this._expand(menu.actor);
        if (menu.owner) menu.owner.setMenuOpen(true);
        this._paintPowerButton();
        this._applyDim();
    }

    closeSubmenu(instant) {
        if (!this._openMenu) return;
        let menu = this._openMenu;
        this._openMenu = null;
        this._collapse(menu.actor, instant);
        if (menu.owner) menu.owner.setMenuOpen(false);
        this._paintPowerButton();
        this._applyDim();
    }

    _applyDim() {
        let open = this._openMenu;
        let set = (actor) => {
            if (actor._gqsCollapsing) return;
            this._ease(actor, { opacity: (!open || actor === open.actor) ? 255 : DIM_OPACITY }, 200);
        };
        let kids = this._content.get_children();
        if (this._notif && !kids.includes(this._notif.actor)) kids.push(this._notif.actor);
        for (let c of kids) {
            if (c === this._tilesBox) {
                for (let g of this._grid.get_children()) set(g);
                set(this._dots); set(this._trayBox); set(this._compactRow);
            } else set(c);
        }
        if (open === this._powerMenu) {
            this._ease(this._topRow, { opacity: 255 }, 200);
            for (let b of this._topRow.get_children()) this._ease(b, { opacity: (b === this._powerButton) ? 255 : DIM_OPACITY }, 200);
        } else {
            for (let b of this._topRow.get_children()) this._ease(b, { opacity: 255 }, 200);
        }
    }

    _onMenuOpened() {
        this._refreshCustomStatus();
        this._refreshAppTiles();
        this._getBrightness();
        this._getKeyboard();
        this._syncAirplane();
        this._btRefresh();
        this._syncDarkStyle();
        this._syncTouchpad();
        this._syncCamera();
        if (this._notifExpanded || this._notifSide()) this._renderNotifications();
        this._mediaPoll();
        // "nmcli monitor" keeps network state fresh; only re-check if it's been a while.
        if (this._net && hasProgram('nmcli') && GLib.get_monotonic_time() - (this._lastNmSync || 0) > 10e6) this._nmSync();
        this._syncMedia();
    }

    /* ---------- backends ---------- */

    _initBackends() {
        let init = (name, fn) => {
            try { fn.call(this); } catch (e) { global.logError(`[gqs] ${name}: ${e}`); }
        };
        init('volume', this._initVolume);
        // Brightness + keyboard backlight come from cinnamon-settings-daemon, which may start
        // a moment after Cinnamon at login: (re)connect whenever it appears.
        init('csd-power', this._watchSettingsDaemon);
        init('keyboard', this._initKeyboard);
        init('battery', this._initBattery);
        init('network', this._initNetwork);
        init('bluetooth', this._initBluetooth);
        init('power-profiles', () => this._initPowerProfiles([
            ['org.freedesktop.UPower.PowerProfiles', '/org/freedesktop/UPower/PowerProfiles'],
            ['net.hadess.PowerProfiles', '/net/hadess/PowerProfiles'],
        ]));
        init('night-light', this._initNightLight);
        init('dark-style', this._initDarkStyle);
        init('dnd', this._initDnd);
        init('caffeine', this._syncCaffeine);
        init('rotation', this._initRotation);
        init('refresh-rate', this._initRefreshRate);
        init('startup', this._scheduleStartupRefresh);
        init('touchpad', this._initTouchpad);
        init('camera', this._initCamera);
        init('media', this._initMedia);
        init('notifications', this._initNotifications);
        init('airplane', this._syncAirplane);
    }

    /* ===== Volume, microphone and devices (Cvc / PulseAudio / PipeWire) ===== */

    _initVolume() {
        if (!Cvc) { this._avail.volume = false; return; }
        this._sinkSignals = [];
        this._sourceSignals = [];
        this._outputs = new Map();
        this._inputs = new Map();
        this._recording = false;

        this._mixer = new Cvc.MixerControl({ name: 'LMQS' });
        this._connect(this._mixer, 'state-changed', () => {
            if (this._mixer.get_state() === Cvc.MixerControlState.READY) {
                this._onDefaultSink();
                this._onDefaultSource();
                this._updateRecording();
            }
        });
        this._connect(this._mixer, 'default-sink-changed', () => this._onDefaultSink());
        this._connect(this._mixer, 'default-source-changed', () => this._onDefaultSource());
        this._connect(this._mixer, 'output-added', (c, id) => this._deviceAdded(false, id));
        this._connect(this._mixer, 'output-removed', (c, id) => this._deviceRemoved(false, id));
        this._connect(this._mixer, 'input-added', (c, id) => this._deviceAdded(true, id));
        this._connect(this._mixer, 'input-removed', (c, id) => this._deviceRemoved(true, id));
        this._connect(this._mixer, 'active-output-update', () => this._devicesChanged(false));
        this._connect(this._mixer, 'active-input-update', () => this._devicesChanged(true));
        this._connect(this._mixer, 'stream-added', () => this._queue('rec', 200, () => this._updateRecording()));
        this._connect(this._mixer, 'stream-removed', () => this._queue('rec', 200, () => this._updateRecording()));
        this._mixer.open();
    }

    _deviceAdded(isInput, id) {
        let dev = isInput ? this._mixer.lookup_input_id(id) : this._mixer.lookup_output_id(id);
        if (!dev) return;
        (isInput ? this._inputs : this._outputs).set(id, dev);
        this._devicesChanged(isInput);
    }

    _deviceRemoved(isInput, id) {
        (isInput ? this._inputs : this._outputs).delete(id);
        this._devicesChanged(isInput);
    }

    _devicesChanged(isInput) {
        this._updateRows();
        let menu = isInput ? this._micMenu : this._volumeMenu;
        if (this._openMenu === menu) this._buildDeviceMenu(isInput);
    }

    _activeDeviceId(isInput) {
        try {
            let stream = isInput ? this._mixer.get_default_source() : this._mixer.get_default_sink();
            if (!stream) return -1;
            let dev = this._mixer.lookup_device_from_stream(stream);
            return dev ? dev.get_id() : -1;
        } catch (e) { return -1; }
    }

    _buildDeviceMenu(isInput) {
        let menu = isInput ? this._micMenu : this._volumeMenu;
        let devices = isInput ? this._inputs : this._outputs;
        menu.clear();
        menu.setFooter([{ label: _('Sound Settings'), onActivate: () => this._launch(['cinnamon-settings', 'sound']) }]);
        if (!devices || !devices.size) { menu.addLabel(_('No devices found')); return; }
        let active = this._activeDeviceId(isInput);
        for (let [id, dev] of devices) {
            let desc = dev.get_description() || _('Unknown device');
            let origin = '';
            try { origin = dev.get_origin() || ''; } catch (e) { }
            let iconName = null;
            try { iconName = dev.get_icon_name(); } catch (e) { }
            menu.addItem({
                label: desc,
                sublabel: origin && origin !== desc ? origin : null,
                icon: [iconName ? iconName + '-symbolic' : null, isInput ? 'audio-input-microphone-symbolic' : 'audio-speakers-symbolic'],
                checked: id === active,
                onActivate: () => {
                    try {
                        if (isInput) this._mixer.change_input(dev);
                        else this._mixer.change_output(dev);
                    } catch (e) { global.logError('[gqs] sound device: ' + e); }
                    this._queue(isInput ? 'devin' : 'devout', 300, () => this._devicesChanged(isInput));
                },
            });
        }
    }

    _onDefaultSink() {
        if (this._sink) for (let id of this._sinkSignals) { try { this._sink.disconnect(id); } catch (e) { } }
        this._sinkSignals = [];
        this._sink = this._mixer.get_default_sink();
        if (this._sink) {
            this._sinkSignals.push(this._sink.connect('notify::volume', () => this._syncVolume()));
            this._sinkSignals.push(this._sink.connect('notify::is-muted', () => this._syncVolume()));
        }
        this._syncVolume();
        this._devicesChanged(false);
    }

    _volumeLevel() {
        if (!this._sink) return 0;
        return this._sink.is_muted ? 0 : this._sink.volume / this._mixer.get_vol_max_norm();
    }

    _syncVolume() {
        let had = this._avail.volume;
        this._avail.volume = !!this._sink;
        if (had !== this._avail.volume) this._updateRows();   // not on every volume step
        if (!this._sink) { this._setPanelIcon('volume', null, false); return; }
        let v = this._volumeLevel();
        this._volume.slider.setValue(v);
        let name;
        if (v <= 0) name = 'audio-volume-muted-symbolic';
        else if (v < 0.34) name = 'audio-volume-low-symbolic';
        else if (v < 0.67) name = 'audio-volume-medium-symbolic';
        else name = 'audio-volume-high-symbolic';
        setGicon(this._volume.icon, [name]);
        this._setPanelIcon('volume', [name], true);
    }

    _setVolume(v) {
        if (!this._sink) return;
        v = Math.max(0, Math.min(1, v));
        this._sink.volume = Math.round(v * this._mixer.get_vol_max_norm());
        this._sink.push_volume();
        if (v > 0 && this._sink.is_muted) this._sink.change_is_muted(false);
        else if (v === 0 && !this._sink.is_muted) this._sink.change_is_muted(true);
    }

    _onDefaultSource() {
        if (this._source) for (let id of this._sourceSignals) { try { this._source.disconnect(id); } catch (e) { } }
        this._sourceSignals = [];
        this._source = this._mixer.get_default_source();
        if (this._source) {
            this._sourceSignals.push(this._source.connect('notify::volume', () => this._syncMic()));
            this._sourceSignals.push(this._source.connect('notify::is-muted', () => this._syncMic()));
        }
        this._syncMic();
        this._devicesChanged(true);
    }

    _micLevel() {
        if (!this._source) return 0;
        return this._source.is_muted ? 0 : this._source.volume / this._mixer.get_vol_max_norm();
    }

    _syncMic() {
        let src = this._source;
        this._micToggle.setShown(!!src);
        if (this._micHad !== !!src) { this._micHad = !!src; this._updateRows(); }
        if (!src) { this._setPanelIcon('mic', null, false); return; }
        let v = this._micLevel();
        let name;
        if (src.is_muted || v <= 0) name = 'microphone-sensitivity-muted-symbolic';
        else if (v < 0.34) name = 'microphone-sensitivity-low-symbolic';
        else if (v < 0.67) name = 'microphone-sensitivity-medium-symbolic';
        else name = 'microphone-sensitivity-high-symbolic';
        let names = [name, src.is_muted ? 'microphone-disabled-symbolic' : 'audio-input-microphone-symbolic'];
        this._mic.slider.setValue(v);
        setGicon(this._mic.icon, names);
        this._micToggle.setChecked(!src.is_muted);
        this._micToggle.setSubtitle(src.is_muted ? _('Muted') : '');
        this._micToggle.setIcon(names);
        this._setPanelIcon('mic', names, this._recording);
    }

    _setMicVolume(v) {
        if (!this._source) return;
        v = Math.max(0, Math.min(1, v));
        this._source.volume = Math.round(v * this._mixer.get_vol_max_norm());
        this._source.push_volume();
        if (v > 0 && this._source.is_muted) this._source.change_is_muted(false);
    }

    _updateRecording() {
        let recording = false;
        try {
            let ignore = ['org.gnome.VolumeControl', 'org.PulseAudio.pavucontrol', 'org.cinnamon.Cinnamon'];
            for (let out of (this._mixer.get_source_outputs() || [])) {
                let appId = null;
                try { appId = out.get_application_id(); } catch (e) { }
                if (out.is_event_stream || ignore.includes(appId)) continue;
                recording = true;
                break;
            }
        } catch (e) { }
        this._recording = recording;
        this._syncMic();
    }

    /* ===== Screen brightness (cinnamon-settings-daemon) ===== */

    _watchSettingsDaemon() {
        this._csdWatch = Gio.bus_watch_name(Gio.BusType.SESSION, CSD_POWER_NAME, Gio.BusNameWatcherFlags.NONE,
            () => {
                if (this._screenProxy) this._getBrightness(); else this._initBrightness();
                if (this._kbdBackend === 'csd') { if (this._kbdProxy) this._getKeyboard(); else this._kbdCsdInit(); }
            },
            () => {
                this._avail.brightness = false;
                this._updateRows();
                if (this._kbdBackend === 'csd') this._kbdUnsupported();
            });
    }

    // Some services (network, Bluetooth, power profiles, sensors) can still be starting when
    // Cinnamon loads the applet at login. Re-check a couple of times so nothing stays hidden.
    _scheduleStartupRefresh() {
        let refresh = () => {
            if (this._net && hasProgram('nmcli')) this._nmSync();
            this._btRefresh();
            this._syncAirplane();
            this._syncCamera();
            this._syncTouchpad();
            if (this._upower) this._syncBattery(); else this._initBattery();
            this._getBrightness();
            if (!this._kbdBackend || (this._kbdBackend === 'csd' && !this._kbdProxy)) this._initKeyboard();
            else this._getKeyboard();
            if (this._displays !== undefined) this._syncRefresh(true);
            if (!this._ppProxy) this._initPowerProfiles([
                ['org.freedesktop.UPower.PowerProfiles', '/org/freedesktop/UPower/PowerProfiles'],
                ['net.hadess.PowerProfiles', '/net/hadess/PowerProfiles'],
            ]);
        };
        this._queue('startup1', 5000, refresh);
        this._queue('startup2', 15000, refresh);
    }

    _initBrightness() {
        if (this._screenPending) return;
        this._screenPending = true;
        this._brightThrottle = new Throttled((v, done) => {
            if (!this._screenProxy) return done();
            this._screenProxy.SetPercentageRemote(v, () => done());
        });
        new ScreenProxy(Gio.DBus.session, CSD_POWER_NAME, CSD_POWER_PATH, (proxy, error) => {
            this._screenPending = false;
            if (error) { this._avail.brightness = false; this._updateRows(); return; }
            this._screenProxy = proxy;
            this._screenSig = proxy.connectSignal('Changed', () => this._getBrightness());
            this._getBrightness();
        });
    }

    _getBrightness() {
        if (!this._screenProxy) return;
        // Several "Changed" signals while scrolling: ask once per burst.
        if (this._brightAsking) { this._brightAskAgain = true; return; }
        this._brightAsking = true;
        this._screenProxy.GetPercentageRemote((result, error) => {
            this._brightAsking = false;
            if (this._brightAskAgain) { this._brightAskAgain = false; this._queue('bright-get', 50, () => this._getBrightness()); }
            let had = this._avail.brightness;
            this._avail.brightness = !error;
            if (had !== this._avail.brightness) this._updateRows();
            if (!error) this._brightness.slider.setValue(result[0] / 100);
        });
    }

    /* ===== Keyboard backlight ===== */

    // Keyboard backlight, tried in this order (no password needed for any):
    //   1. UPower's KbdBacklight service (most laptops)
    //   2. /sys/class/leds/*kbd_backlight* set through systemd-logind (anything UPower misses)
    //   3. cinnamon-settings-daemon's keyboard interface
    _initKeyboard() {
        this._kbdThrottle = new Throttled((v, done) => this._kbdSet(v, done));
        this._watchResumeForBt();   // shared "woke from suspend" signal
        this._kbdTryUPower(() => this._kbdTrySysfs(() => this._kbdTryLegionRgb(() => {
            this._kbdBackend = 'csd';
            this._kbdMax = 100;
            this._kbdCsdInit();
        })));
        this._kbdUnsupported();
    }

    _kbdTryUPower(fallback) {
        Gio.DBus.system.call('org.freedesktop.UPower', '/org/freedesktop/UPower/KbdBacklight',
            'org.freedesktop.UPower.KbdBacklight', 'GetMaxBrightness', null, null,
            Gio.DBusCallFlags.NONE, 3000, null, (c, r) => {
                let max = 0;
                try { [max] = c.call_finish(r).deepUnpack(); } catch (e) { max = 0; }
                if (!(max > 0)) { fallback(); return; }
                this._kbdBackend = 'upower';
                this._kbdMax = max;
                this._kbdLoginPolicy();
                this._kbdSub = Gio.DBus.system.signal_subscribe('org.freedesktop.UPower',
                    'org.freedesktop.UPower.KbdBacklight', null, '/org/freedesktop/UPower/KbdBacklight', null,
                    Gio.DBusSignalFlags.NONE, (conn, sender, path, iface, signal, params) => {
                        if (signal.startsWith('BrightnessChanged')) {
                            try { this._kbdApply(params.deepUnpack()[0]); } catch (e) { }
                        }
                    });
                this._getKeyboard();
            });
    }

    _kbdTrySysfs(fallback) {
        let led = null, max = 0;
        try {
            let en = Gio.File.new_for_path('/sys/class/leds').enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null)) !== null) {
                let name = info.get_name();
                if (!/kbd_backlight/i.test(name)) continue;
                let m = parseInt(readFile(`/sys/class/leds/${name}/max_brightness`)) || 0;
                if (m > 0 && (!led || /^[a-z0-9_]+::kbd_backlight$/i.test(name))) { led = name; max = m; }
            }
            en.close(null);
        } catch (e) { }
        if (!led) { fallback(); return; }
        this._kbdBackend = 'logind';
        this._kbdLed = led;
        this._kbdMax = max;
        this._getKeyboard();
        this._kbdLoginPolicy();
    }

    _kbdCsdInit() {
        if (this._kbdPending) return;
        this._kbdPending = true;
        new KeyboardProxy(Gio.DBus.session, CSD_POWER_NAME, CSD_POWER_PATH, (proxy, error) => {
            this._kbdPending = false;
            if (error) { this._kbdUnsupported('cinnamon-settings-daemon not available'); return; }
            this._kbdProxy = proxy;
            this._kbdLoginPolicy();
            this._kbdSig1 = proxy.connectSignal('Changed', () => this._getKeyboard());
            this._kbdSig2 = proxy.connectSignal('BrightnessChanged', () => this._getKeyboard());
            this._getKeyboard();
        });
    }

    _getKeyboard() {
        let b = this._kbdBackend;
        if (b === 'upower') {
            Gio.DBus.system.call('org.freedesktop.UPower', '/org/freedesktop/UPower/KbdBacklight',
                'org.freedesktop.UPower.KbdBacklight', 'GetBrightness', null, null,
                Gio.DBusCallFlags.NONE, 3000, null, (c, r) => {
                    try { this._kbdApply(c.call_finish(r).deepUnpack()[0]); } catch (e) { }
                });
        } else if (b === 'logind') {
            let v = parseInt(readFile(`/sys/class/leds/${this._kbdLed}/brightness`));
            if (!isNaN(v)) this._kbdApply(v);
        } else if (b === 'rgb') {
            this._kbdApply(this._rgbState().brightness);
        } else if (b === 'csd' && this._kbdProxy) {
            this._kbdProxy.GetPercentageRemote((result, error) => {
                if (error) { this._kbdUnsupported('no backlight found by UPower, /sys/class/leds or cinnamon-settings-daemon'); return; }
                this._kbdApply(result[0]);
            });
        }
    }

    _kbdSet(v, done) {
        v = Math.max(0, Math.min(this._kbdMax || 100, Math.round(v)));
        let b = this._kbdBackend;
        let after = () => { this._getKeyboard(); done(); };
        if (b === 'upower') {
            Gio.DBus.system.call('org.freedesktop.UPower', '/org/freedesktop/UPower/KbdBacklight',
                'org.freedesktop.UPower.KbdBacklight', 'SetBrightness', new GLib.Variant('(i)', [v]), null,
                Gio.DBusCallFlags.NONE, 3000, null, (c, r) => {
                    try { c.call_finish(r); } catch (e) { global.logError('[gqs] keyboard: ' + e); }
                    after();
                });
        } else if (b === 'logind') {
            Gio.DBus.system.call('org.freedesktop.login1', '/org/freedesktop/login1/session/auto',
                'org.freedesktop.login1.Session', 'SetBrightness', new GLib.Variant('(ssu)', ['leds', this._kbdLed, v]), null,
                Gio.DBusCallFlags.NONE, 3000, null, (c, r) => {
                    try { c.call_finish(r); } catch (e) { global.logError('[gqs] keyboard: ' + e); }
                    after();
                });
        } else if (b === 'rgb') {
            this._rgbSet({ brightness: v }, () => after());
        } else if (b === 'csd' && this._kbdProxy) {
            this._kbdProxy.SetPercentageRemote(v, () => after());
        } else {
            done();
        }
    }

    /* ----- Lenovo Legion 4-zone RGB keyboard (ITE 8295) ----- */

    _rgbHelper() {
        return this.metadata.path + '/helpers/gqs-legion-rgb';
    }

    _kbdTryLegionRgb(fallback) {
        if (!hasProgram('python3')) { fallback(); return; }
        run(['python3', this._rgbHelper(), 'detect'], (ok, out) => {
            let r = out.trim();
            if (r === 'ok') {
                this._kbdBackend = 'rgb';
                this._kbdMax = 2;
                global.log('[gqs] keyboard backlight: Legion 4-zone RGB controller');
                let st = this._rgbState();
                this._kbdApply(st.brightness);
                this._kbdLoginPolicy();             // restore your lighting (or keep it off) after login
                this._startRgbWatch();
            } else if (r === 'noperm') {
                this._kbdBackend = 'rgb-setup';
                global.log('[gqs] keyboard backlight: Legion RGB controller found, udev rule not installed');
                let t = this._kbdToggle;
                t.setShown(true);
                t.setChecked(false);
                t.setSubtitle(_('Setup needed'));
            } else {
                fallback();
            }
        });
    }

    // Follow changes made on the keyboard itself (Fn+Space): a helper reads the controller's
    // current lighting and reports whenever it changes.
    _startRgbWatch() {
        if (this._rgbWatch) return;
        try {
            this._rgbWatch = Gio.Subprocess.new(['python3', this._rgbHelper(), 'watch'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            let stream = new Gio.DataInputStream({ base_stream: this._rgbWatch.get_stdout_pipe() });
            let events = 0;
            let readNext = () => {
                stream.read_line_async(GLib.PRIORITY_LOW, null, (st, res) => {
                    let line = null;
                    try { [line] = st.read_line_finish_utf8(res); } catch (e) { return; }
                    if (line === null) { this._rgbWatch = null; return; }
                    if (line.startsWith('state ')) {
                        this._rgbFromHardware(line.slice(6).trim());
                    } else if (line === 'nostate') {
                        // Nothing to follow on this keyboard: stop checking.
                        global.log("[gqs] keyboard lighting: the controller doesn't report its current state, so Fn+Space changes can't be shown");
                        this._rgbNoState = true;
                        try { this._rgbWatch.force_exit(); } catch (e) { }
                        this._rgbWatch = null;
                        if (this._openMenu === this._kbdToggle.menu) this._buildKbdMenu();
                        return;
                    } else if (line.startsWith('event ') && events++ < 20) {
                        global.log(`[gqs] keyboard lighting: controller ${line}`);
                    }
                    readNext();
                });
            };
            readNext();
        } catch (e) {
            global.logError('[gqs] keyboard watch: ' + e);
            this._rgbWatch = null;
        }
    }

    _rgbDecode(hex) {
        if (!hex || hex.length < 40) return null;
        let b = [];
        for (let i = 0; i < 20; i++) b.push(parseInt(hex.substr(i * 2, 2), 16));
        if (b[0] !== 0xcc || b[1] !== 0x16) return null;
        let effect = { 1: 'static', 3: 'breath', 4: b[18] ? 'wave-rtl' : 'wave-ltr', 6: 'smooth' }[b[2]];
        if (!effect) return null;
        let colors = [0, 1, 2, 3].map(i => hex.substr((5 + i * 3) * 2, 6).toLowerCase());
        let brightness = Math.min(2, b[4]);
        let dark = colors.every(c => c === '000000');
        if (dark && (effect === 'static' || effect === 'breath')) brightness = 0;
        let out = { effect, speed: b[3] || 2, brightness };
        if (!dark) out.colors = colors;        // keep your colors while it's off
        if (brightness === 0) delete out.effect;
        return out;
    }

    _rgbFromHardware(hex) {
        let hw = this._rgbDecode(hex);
        if (!hw) return;
        let st = this._rgbState();
        let next = Object.assign({}, st, hw);
        if (next.brightness > 0) next.lastOn = next.brightness;
        let changed = ['brightness', 'effect', 'speed'].some(k => next[k] !== st[k]) || next.colors.join() !== st.colors.join();
        if (!changed) return;
        try { this.settings.setValue('kbd-rgb-state', next); } catch (e) { }
        this._kbdApply(next.brightness);
    }

    _rgbState() {
        let def = { brightness: 2, lastOn: 2, effect: 'static', speed: 2, colors: ['ffffff', 'ffffff', 'ffffff', 'ffffff'], userSet: false };
        let st = Object.assign({}, def, this.cfg('kbd-rgb-state') || {});
        if (!Array.isArray(st.colors) || st.colors.length !== 4) st.colors = def.colors;
        return st;
    }

    _rgbSend(st, cb) {
        let effect = st.brightness > 0 ? st.effect : 'off';
        let argv = ['python3', this._rgbHelper(), 'set', effect, String(st.speed), String(Math.max(1, st.brightness)), ...st.colors];
        run(argv, (ok, out) => {
            if (!ok) global.logError(`[gqs] keyboard lighting: ${out.trim() || 'failed'}`);
            if (cb) cb(ok);
        });
    }

    _rgbSet(changes, cb) {
        this._kbdUserTouched = true;
        let st = Object.assign(this._rgbState(), changes, { userSet: true });
        if (st.brightness > 0) st.lastOn = st.brightness;
        try { this.settings.setValue('kbd-rgb-state', st); } catch (e) { }
        this._kbdValue = st.brightness;
        this._rgbSend(st, () => {
            this._kbdApply(st.brightness);
            if (cb) cb();
        });
    }

    _buildRgbMenu(menu) {
        let st = this._rgbState();
        // Say it first, before the Off / Low / High choices.
        if (this._rgbNoState)
            menu.addLabel(_('Changes made with Fn+Space can\'t be shown here.'));
        let lvl = [[0, _('Off')], [1, _('Low')], [2, _('High')]];
        for (let [v, name] of lvl) {
            menu.addItem({
                label: name,
                icon: v === 0 ? ['keyboard-brightness-off-symbolic', 'input-keyboard-symbolic'] : ['keyboard-brightness-symbolic', 'input-keyboard-symbolic'],
                checked: st.brightness === v,
                onActivate: () => this._rgbSet({ brightness: v }),
            });
        }

        menu.addActor(new St.Widget({ style_class: 'gqs-separator', x_expand: true }));
        let effects = [
            ['static', _('Static'), ['color-select-symbolic', 'applications-graphics-symbolic']],
            ['breath', _('Breathing'), ['weather-clear-night-symbolic']],
            ['wave-ltr', _('Wave'), ['media-playlist-repeat-symbolic', 'view-refresh-symbolic']],
            ['smooth', _('Color cycle'), ['view-refresh-symbolic']],
        ];
        for (let [id, name, icon] of effects) {
            menu.addItem({
                label: name, icon,
                checked: st.effect === id || (id === 'wave-ltr' && st.effect === 'wave-rtl'),
                onActivate: () => this._rgbSet({ effect: id, brightness: st.brightness || st.lastOn || 2 }),
            });
        }

        if (st.effect === 'static' || st.effect === 'breath') {
            let swatches = [
                ['White', 'ffffff'], ['Red', 'ff0000'], ['Orange', 'ff6a00'], ['Yellow', 'ffd000'],
                ['Green', '00ff40'], ['Cyan', '00e5ff'], ['Blue', '0040ff'], ['Purple', '9000ff'], ['Pink', 'ff2fa0'],
            ];
            let row = new St.BoxLayout({ style_class: 'gqs-swatch-row', x_expand: true });
            let same = st.colors.every(c => c === st.colors[0]);
            for (let [name, hex] of swatches) {
                let b = new St.Button({ style_class: 'gqs-swatch', can_focus: true });
                b.set_style(`background-color: #${hex};`);
                try { b.set_accessible_name(name); } catch (e) { }
                if (same && st.colors[0] === hex) b.add_style_class_name('selected');
                b.connect('clicked', () => this._rgbSet({ colors: [hex, hex, hex, hex], brightness: st.brightness || st.lastOn || 2 }));
                row.add_child(b);
            }
            menu.addActor(row);
            menu.addItem({
                label: _('Rainbow (4 zones)'),
                icon: ['color-select-symbolic', 'applications-graphics-symbolic'],
                checked: st.colors.join() === 'ff0000,ffd000,00ff40,0040ff',
                onActivate: () => this._rgbSet({ colors: ['ff0000', 'ffd000', '00ff40', '0040ff'], brightness: st.brightness || st.lastOn || 2 }),
            });
        }
    }

    /* Keyboard light at login (and after waking from suspend). Many laptops switch the
       backlight on at every power-up, whatever it was before. Choices:
         remember: put back the state you left it in;  off: always start with it off;
         system: leave it to the laptop. Applied a few times over the first 30 s because some
       keyboards (USB controllers like Legion's) only settle after login. */
    _kbdLoginPolicy(resume) {
        let mode = this.cfg('kbd-at-login');
        if (mode === 'system' || !this._kbdBackend || this._kbdBackend === 'rgb-setup') { this._kbdPolicyDone = true; return; }
        this._kbdUserTouched = false;
        let apply = () => {
            if (this._kbdUserTouched) return;   // you changed it yourself meanwhile: leave it
            let b = this._kbdBackend;
            if (b === 'rgb') {
                let st = this._rgbState();
                if (mode === 'off') {
                    if (st.brightness !== 0) {
                        st = Object.assign(st, { brightness: 0 });
                        try { this.settings.setValue('kbd-rgb-state', st); } catch (e) { }
                    }
                    this._rgbSend(st, () => this._kbdApply(0));
                } else if (st.userSet || st.brightness === 0) {
                    this._rgbSend(st, () => this._kbdApply(st.brightness));
                }
                return;
            }
            let want = mode === 'off' ? 0 : this.cfg('kbd-last-level');
            if (typeof want !== 'number') return;        // nothing remembered yet
            want = Math.max(0, Math.min(this._kbdMax || 100, want));
            if (this._kbdValue !== want && this._kbdThrottle) this._kbdThrottle.set(want);
        };
        this._kbdPolicyDone = false;
        let delays = resume ? [2000, 8000] : [0, 6000, 20000];
        delays.forEach((ms, i) => {
            this._queue('kbd-policy-' + i, ms + 1, () => {
                apply();
                if (i === delays.length - 1) this._queue('kbd-policy-done', 3000, () => { this._kbdPolicyDone = true; });
            });
        });
        if (mode === 'off') global.log('[gqs] keyboard light at login: keeping it off');
    }

    // Shown (not hidden) when no keyboard light can be controlled, so it's clear why.
    _kbdUnsupported(reason) {
        if (this._kbdSupported) return;
        if (reason && reason !== this._kbdLoggedReason) {
            this._kbdLoggedReason = reason;
            global.log(`[gqs] keyboard backlight: ${reason}`);
        }
        let t = this._kbdToggle;
        t.setShown(true);
        t.setChecked(false);
        t.setSubtitle(_('Not detected'));
    }

    _kbdLevelName(v) {
        let max = this._kbdMax || 100;
        if (v <= 0) return _('Off');
        if (max === 1) return _('On');
        if (max === 2) return v === 1 ? _('Low') : _('High');
        if (max === 3) return [_('Low'), _('Medium'), _('High')][v - 1];
        if (max <= 4) return `${_('Level')} ${v}`;
        return `${Math.round(v / max * 100)}%`;
    }

    _kbdApply(v) {
        this._kbdSupported = true;
        // After the login window: remember the level (yours, or set with the keyboard's Fn keys
        // where the keyboard reports it) for the next login.
        if (this._kbdPolicyDone && this.settings && this._kbdBackend !== 'rgb' && this.cfg('kbd-last-level') !== v) {
            try { this.settings.setValue('kbd-last-level', v); } catch (e) { }
        }
        let max = this._kbdMax || 100;
        this._kbdValue = v;
        if (v > 0) this._kbdLast = v;
        this._kbdToggle.setShown(true);
        this._kbdToggle.setChecked(v > 0);
        this._kbdToggle.setSubtitle(v > 0 ? this._kbdLevelName(v) : '');
        this._kbdSlider.slider.setValue(v / max);
        if (this._openMenu === this._kbdToggle.menu) this._buildKbdMenu();
    }

    // Few fixed steps (most laptops: Off/Low/Medium/High) get buttons; finer control gets the slider.
    _buildKbdMenu() {
        let menu = this._kbdToggle.menu;
        let row = this._kbdSlider.row;
        if (row.get_parent()) row.get_parent().remove_child(row);
        menu.clear();
        if (this._kbdBackend === 'rgb-setup') {
            menu.addLabel(_('Your RGB keyboard needs a one-time setup.'));
            menu.addLabel(_('Run ./install.sh in the Quick Settings folder.'));
            return;
        }
        if (!this._kbdSupported) {
            menu.addLabel(_('No keyboard light control was found.'));
            menu.addLabel(_('Use your keyboard\'s Fn key, or the maker\'s app.'));
            return;
        }
        if (this._kbdBackend === 'rgb') { this._buildRgbMenu(menu); return; }
        let max = this._kbdMax || 100;
        if (max <= 4) {
            for (let lvl = 0; lvl <= max; lvl++) {
                menu.addItem({
                    label: this._kbdLevelName(lvl),
                    icon: lvl === 0 ? ['keyboard-brightness-off-symbolic', 'input-keyboard-symbolic'] : ['keyboard-brightness-symbolic', 'input-keyboard-symbolic'],
                    checked: lvl === this._kbdValue,
                    onActivate: () => { this._kbdUserTouched = true; this._kbdThrottle.set(lvl); },
                });
            }
        } else {
            menu.addActor(row);
        }
    }

    _toggleKeyboard() {
        this._kbdUserTouched = true;
        if (this._kbdBackend === 'rgb-setup') {
            this.menu.close();
            this._notify(_('Keyboard lighting needs a one-time setup'),
                _('Open a terminal in the Quick Settings folder and run: ./install.sh --keyboard'));
            return;
        }
        if (!this._kbdSupported) { this.toggleSubmenu(this._kbdToggle.menu); return; }
        if (!this._kbdBackend) return;
        this._kbdThrottle.set(this._kbdToggle.checked ? 0 : (this._kbdLast || this._kbdMax || 100));
    }

    /* ===== Display refresh rate (X11, xrandr) ===== */

    _initRefreshRate() {
        if (GLib.getenv('XDG_SESSION_TYPE') === 'wayland' || !hasProgram('xrandr')) {
            this._refreshToggle.setSubtitle(_('Unavailable'));
            global.log('[gqs] refresh rate: needs an X11 session and xrandr');
            return;
        }
        try { this._connect(Main.layoutManager, 'monitors-changed', () => this._queue('xrandr', 800, () => this._syncRefresh())); } catch (e) { }
        this._ensureCustomRates(() => this._syncRefresh(true));
    }

    // High refresh laptop panels often report only their top rate. Add 144/120/60 Hz modes
    // (below the top rate, if missing) for this session. They're only used when you choose them.
    _ensureCustomRates(done) {
        run(['xrandr', '--verbose'], (ok, out) => {
            if (!ok) { done(); return; }
            let jobs = [];
            for (let o of parseXrandrVerbose(out)) {
                if (!o.connected) continue;
                let cur = o.modes.find(m => m.current);
                if (!cur || !cur.h || !cur.v || cur.hz < 75 || cur.flags.includes('Interlace')) continue;
                let sameRes = o.modes.filter(m => m.h && m.v && m.h[0] === cur.h[0] && m.v[0] === cur.v[0]);
                let native = sameRes.reduce((a, b) => (b.hz > a.hz ? b : a), cur);
                // Common rates below the panel's top rate that it doesn't already report.
                for (let target of [144, 120, 60]) {
                    if (target > native.hz - 3) continue;
                    if (sameRes.some(m => !m.name.endsWith('-gqs') && Math.abs(m.hz - target) < 1.5)) continue;
                    let ml = customModeline(native, target);
                    if (!ml) continue;
                    if (!o.modes.some(m => m.name === ml.name)) jobs.push(['xrandr', '--newmode', ...ml.args]);
                    jobs.push(['xrandr', '--addmode', o.name, ml.name]);
                    global.log(`[gqs] refresh rate: adding ${target} Hz mode ${ml.name} for ${o.name}`);
                }
            }
            let next = () => {
                let argv = jobs.shift();
                if (!argv) { done(); return; }
                run(argv, () => next());   // "already exists" errors are fine
            };
            next();
        });
    }

    // Built-in screen first, then the primary one, then any.
    _refreshTarget() {
        let ds = (this._displays || []).filter(d => d.rates.length > 1);
        return ds.find(d => d.internal) || ds.find(d => d.primary) || ds[0] || null;
    }

    _syncRefresh(applySaved) {
        run(['xrandr', '--query'], (ok, out) => {
            this._displays = ok ? parseXrandr(out) : [];
            if (applySaved && this._applySavedRates()) return;   // re-syncs after applying
            let d = this._refreshTarget();
            let t = this._refreshToggle;
            t.setShown(true);
            let summary = this._displays.map(x => `${x.name} ${x.current} @ ${x.rate} (rates: ${x.rates.map(r => r.str).join(', ')})`).join('; ') || 'no active display found';
            if (summary !== this._loggedDisplays) { this._loggedDisplays = summary; global.log(`[gqs] refresh rate: ${summary}`); }
            if (!d) {
                // One rate only (or none found): show it instead of hiding the toggle.
                let one = this._displays.find(x => x.internal) || this._displays[0];
                t.setChecked(false);
                t.setSubtitle(one ? `${_('Only')} ${rateLabel(parseFloat(one.rate))}` : _('Unavailable'));
                if (this._openMenu === t.menu) this._buildRefreshMenu();
                return;
            }
            let max = d.rates[0];
            let current = d.rates.find(r => r.str === d.rate) || { hz: parseFloat(d.rate) };
            // Stays on (highlighted) at every rate; the subtitle shows which one is active.
            t.setChecked(true);
            t.setSubtitle(rateLabel(current.hz));
            if (this._openMenu === t.menu) this._buildRefreshMenu();
        });
    }

    _rateArgs(display, rate) {
        return ['xrandr', '--output', display.name, '--mode', rate.mode || display.current, '--rate', rate.str];
    }

    _setRate(display, rate) {
        let previous = display.rates.find(r => r.str === display.rate && r.mode === display.currentMode) || display.rates[0];
        run(this._rateArgs(display, rate), (ok) => {
            if (!ok) {
                global.logError(`[gqs] couldn't set ${display.name} to ${rate.str} Hz`);
                this._notify(_("Couldn't change the refresh rate"), _('Your screen didn\'t accept that rate.'));
            } else {
                // Every change asks "Keep this refresh rate?" and reverts after 15 seconds
                // unless you confirm (Keep Changes also remembers it for the next login).
                this._confirmRate(display, rate, previous);
            }
            this._queue('xrandr', 500, () => this._syncRefresh());
        });
    }

    _rateVerified(display, rate) {
        let v = this.cfg('refresh-rate-verified') || {};
        return !!v[`${display.name}|${rate.mode}`];
    }

    // "Keep this refresh rate?" with a 15 second automatic revert, in case the screen goes dark.
    _confirmRate(display, rate, previous) {
        let seconds = 15;
        let reverted = false;
        let dialog = null, timer = 0, label = null;
        let revert = () => {
            if (reverted) return;
            reverted = true;
            if (timer) { GLib.source_remove(timer); timer = 0; }
            if (dialog) { try { dialog.close(); } catch (e) { } }
            run(this._rateArgs(display, previous), () => this._queue('xrandr', 500, () => this._syncRefresh()));
        };
        let keep = () => {
            if (reverted) return;
            reverted = true;
            if (timer) { GLib.source_remove(timer); timer = 0; }
            if (dialog) { try { dialog.close(); } catch (e) { } }
            let v = Object.assign({}, this.cfg('refresh-rate-verified') || {});
            v[`${display.name}|${rate.mode}`] = true;
            try { this.settings.setValue('refresh-rate-verified', v); } catch (e) { }
            this._rememberRate(display, rate);
        };
        let text = () => `${_('Does the screen look right at')} ${rateLabel(rate.hz)}?\n${_('Going back to')} ${rateLabel(previous.hz)} ${_('in')} ${seconds} ${_('seconds.')}`;
        try {
            const ModalDialog = imports.ui.modalDialog;
            dialog = new ModalDialog.ModalDialog();
            let title = wrapLabel(new St.Label({ text: _('Keep this refresh rate?'), style_class: 'gqs-confirm-title' }));
            label = wrapLabel(new St.Label({ text: text(), style_class: 'gqs-confirm-body' }));
            dialog.contentLayout.add_child(title);
            dialog.contentLayout.add_child(label);
            let rateButtons = [
                { label: _('Revert'), action: revert, key: Clutter.KEY_Escape },
                { label: _('Keep Changes'), action: keep, default: true },
            ];
            dialog.setButtons(rateButtons);
            this._accentDialogButtons(dialog, rateButtons);
            dialog.open();
        } catch (e) {
            global.logError('[gqs] confirm dialog: ' + e);
        }
        timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            seconds--;
            if (seconds <= 0) { timer = 0; revert(); return GLib.SOURCE_REMOVE; }
            if (label) setText(label, text());
            return GLib.SOURCE_CONTINUE;
        });
    }

    _rememberRate(display, rate) {
        if (!this.settings || !this.cfg('refresh-rate-remember')) return;
        let mem = Object.assign({}, this.cfg('refresh-rate-memory') || {});
        mem[`${display.name}|${display.current}`] = rate.str;
        mem[`${display.name}|${display.current}|mode`] = rate.mode;
        try { this.settings.setValue('refresh-rate-memory', mem); } catch (e) { }
    }

    // After login, put back the rate chosen here (Cinnamon may start at a different one).
    _applySavedRates() {
        if (!this.cfg('refresh-rate-remember')) return false;
        let mem = this.cfg('refresh-rate-memory') || {};
        let applied = false;
        for (let d of this._displays || []) {
            let want = mem[`${d.name}|${d.current}`];
            let wantMode = mem[`${d.name}|${d.current}|mode`];
            if (!want || (want === d.rate && (!wantMode || wantMode === d.currentMode))) continue;
            let rate = d.rates.find(r => r.str === want && (!wantMode || r.mode === wantMode)) || d.rates.find(r => r.str === want);
            if (!rate) continue;
            applied = true;
            if (rate.custom && !this._rateVerified(d, rate)) continue;
            run(this._rateArgs(d, rate),
                () => this._queue('xrandr', 500, () => this._syncRefresh()));
        }
        return applied;
    }

    // Click: switch between the highest rate and 60 Hz (or the closest rate to it).
    _toggleRefreshRate() {
        let d = this._refreshTarget();
        if (!d) { this.toggleSubmenu(this._refreshToggle.menu); return; }
        let max = d.rates[0];
        let atMax = Math.abs(parseFloat(d.rate) - max.hz) < 0.5;
        let target = max;
        if (atMax) {
            let lower = d.rates.filter(r => r.hz < max.hz - 0.5);
            target = lower.reduce((best, r) => (!best || Math.abs(r.hz - 60) < Math.abs(best.hz - 60)) ? r : best, null) || max;
        }
        this._setRate(d, target);
    }

    _buildRefreshMenu() {
        let menu = this._refreshToggle.menu;
        menu.clear();
        menu.setFooter([{ label: _('Display Settings'), onActivate: () => this._launch(['cinnamon-settings', 'display']) }]);
        let displays = (this._displays || []).filter(d => d.rates.length > 1);
        if (!displays.length) {
            let one = (this._displays || []).find(x => x.internal) || (this._displays || [])[0];
            if (one) menu.addItem({ label: rateLabel(parseFloat(one.rate)), icon: ['video-display-symbolic'], checked: true });
            menu.addLabel(_('Your screen reports only this refresh rate to Linux.'));
            return;
        }
        for (let d of displays) {
            if (displays.length > 1)
                menu.addLabel(d.internal ? _('Built-in display') : d.name);
            let seen = new Set();
            for (let r of d.rates) {
                let label = rateLabel(r.hz);
                if (seen.has(label)) continue;
                seen.add(label);
                menu.addItem({
                    label,
                    sublabel: r === d.rates[0] ? _('Smoothest') : (Math.abs(r.hz - 60) < 0.5 ? _('Saves battery') : null),
                    icon: ['video-display-symbolic', 'preferences-desktop-display-symbolic'],
                    checked: r.str === d.rate && r.mode === d.currentMode,
                    onActivate: () => { if (!(r.str === d.rate && r.mode === d.currentMode)) this._setRate(d, r); },
                });
            }
        }
    }

    /* ===== Battery (UPower) ===== */

    _initBattery() {
        if (this._upowerPending) return;
        this._upowerPending = true;
        new UPowerDeviceProxy(Gio.DBus.system, 'org.freedesktop.UPower',
            '/org/freedesktop/UPower/devices/DisplayDevice', (proxy, error) => {
                this._upowerPending = false;
                if (error) return;
                this._upower = proxy;
                this._connect(proxy, 'g-properties-changed', () => this._syncBattery());
                this._syncBattery();
            });
    }

    _syncBattery() {
        let p = this._upower;
        let present = !!(p && p.IsPresent && p.Type === 2);
        this._avail.battery = present;
        this._batteryPill.visible = present && this.cfg('show-battery-pill');
        this._fitTopRow();
        if (!present) { this._batteryPercent.text = ''; this._setPanelIcon('battery', null, false); return; }

        let pct = Math.round(p.Percentage);
        let state = p.State; // 1 charging, 2 discharging, 4 full, 5 pending-charge
        let charging = state === 1 || state === 4 || state === 5;
        let level = Math.min(100, Math.floor(pct / 10) * 10);
        let names = [];
        if (state === 4 || (charging && pct >= 100)) names.push('battery-level-100-charged-symbolic');
        names.push(`battery-level-${level}${charging ? '-charging' : ''}-symbolic`);
        if (p.IconName) names.push(p.IconName);
        names.push('battery-symbolic');

        setGicon(this._batIcon, names);
        this._batLabel.text = `${pct} %`;
        this._batteryPercent.text = `${pct}%`;
        this._batState = { pct: p.Percentage, charging: state === 1 };
        this._batteryTime.text = this._batteryTimeText(p, state);
        this._setPanelIcon('battery', names, true);
        this._fitTopRow();
        this._refreshBatteryPill();
    }

    // Where the time remaining shows: off / panel (on the Quick Settings button) / menu (inside) / both.
    // Older versions stored a plain on/off switch: on meant the panel.
    _batTimeMode() {
        let v = this.cfg('panel-battery-time');
        if (v === true) return 'panel';
        if (v === false || v === null || v === undefined) return 'off';
        return ['off', 'panel', 'menu', 'both'].includes(v) ? v : 'off';
    }

    // "3 h 25 min" left on battery, or "1 h 10 min to full" while charging.
    // Empty while UPower is still estimating (it reports 0) or when the battery is full.
    _batteryTimeText(p, state) {
        let secs = 0, charging = state === 1;
        try { secs = Number(charging ? p.TimeToFull : (state === 2 ? p.TimeToEmpty : 0)) || 0; } catch (e) { secs = 0; }
        if (secs <= 0) return '';
        let mins = Math.round(secs / 60);
        let h = Math.floor(mins / 60), m = mins % 60;
        let t = h > 0 ? (m > 0 ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
        return charging ? `${t} ${_('to full')}` : t;
    }

    /* ===== Network: Wi-Fi, Wired, VPN, Hotspot (NetworkManager via nmcli) ===== */

    _initNetwork() {
        this._net = { hasWifi: false, enabled: false, state: '', ssid: '', signal: 0, wired: [], vpns: [], hotspot: null, wifiDev: null };
        this._wifiToggle.setShown(true);
        if (!hasProgram('nmcli')) {
            this._wifiToggle.setSubtitle(_('Unavailable'));
            return;
        }
        this._nmSync();
        this._startNmMonitor();
        // signal strength isn't reported by "nmcli monitor"; refresh it now and then
        this._netTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 20, () => { this._nmSync(); return GLib.SOURCE_CONTINUE; });
    }

    _startNmMonitor() {
        try {
            this._nmMon = Gio.Subprocess.new(['nmcli', 'monitor'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            let stream = new Gio.DataInputStream({ base_stream: this._nmMon.get_stdout_pipe() });
            let readNext = () => {
                stream.read_line_async(GLib.PRIORITY_LOW, null, (st, res) => {
                    let line = null;
                    try { [line] = st.read_line_finish_utf8(res); } catch (e) { return; }
                    if (line === null) return;
                    this._queue('net', 400, () => this._nmSync());
                    readNext();
                });
            };
            readNext();
        } catch (e) { global.logError('[gqs] nmcli monitor: ' + e); }
    }

    _nmSync() {
        this._lastNmSync = GLib.get_monotonic_time();
        let n = this._net;
        run(['nmcli', '-t', '-f', 'TYPE,STATE,CONNECTION,DEVICE', 'device'], (ok, out) => {
            let devs = terseLines(out).map(f => ({ type: f[0], state: f[1] || '', conn: f[2] || '', dev: f[3] || '' }));
            let wifi = devs.find(d => d.type === 'wifi');
            n.hasWifi = !!wifi;
            n.wifiDev = wifi ? wifi.dev : null;
            n.state = wifi ? wifi.state : '';
            n.wired = devs.filter(d => d.type === 'ethernet' && d.state !== 'unmanaged');

            run(['nmcli', 'radio', 'wifi'], (ok2, out2) => {
                n.enabled = out2.trim() === 'enabled';
                run(['nmcli', '-t', '-f', 'NAME,UUID,TYPE,ACTIVE', 'connection', 'show'], (ok3, out3) => {
                    let conns = terseLines(out3).map(f => ({ name: f[0], uuid: f[1], type: f[2], active: f[3] === 'yes' }));
                    n.vpns = conns.filter(c => c.type === 'vpn' || c.type === 'wireguard');
                    let activeWifi = conns.find(c => c.active && c.type === '802-11-wireless');

                    let finish = () => {
                        if (wifi && wifi.state === 'connected' && !n.hotspot) {
                            run(['nmcli', '-t', '-f', 'ACTIVE,SIGNAL,SSID', 'device', 'wifi', 'list', '--rescan', 'no'], (ok5, out5) => {
                                let active = terseLines(out5).find(f => f[0] === 'yes');
                                n.signal = active ? parseInt(active[1]) || 0 : 70;
                                n.ssid = active ? active[2] : wifi.conn;
                                this._applyNetwork();
                            });
                        } else {
                            n.ssid = '';
                            this._applyNetwork();
                        }
                    };

                    if (activeWifi) {
                        run(['nmcli', '-g', '802-11-wireless.mode', 'connection', 'show', 'uuid', activeWifi.uuid], (ok4, out4) => {
                            n.hotspot = out4.trim() === 'ap' ? activeWifi : null;
                            finish();
                        });
                    } else {
                        n.hotspot = null;
                        finish();
                    }
                });
            });
        });
    }

    _applyNetwork() {
        let n = this._net;
        let wifiIcon, subtitle = '';
        if (!n.hasWifi) {
            wifiIcon = 'network-wireless-disabled-symbolic';
            subtitle = _('No adapter');
        } else if (!n.enabled) {
            wifiIcon = 'network-wireless-disabled-symbolic';
        } else if (n.hotspot) {
            wifiIcon = 'network-wireless-hotspot-symbolic';
            subtitle = _('Hotspot');
        } else if (n.state === 'connected') {
            wifiIcon = wifiSignalIcon(n.signal);
            subtitle = n.ssid;
        } else if (n.state.startsWith('connecting')) {
            wifiIcon = 'network-wireless-acquiring-symbolic';
            subtitle = _('Connecting…');
        } else {
            wifiIcon = 'network-wireless-offline-symbolic';
        }
        let t = this._wifiToggle;
        t.setShown(true);
        t.setChecked(n.hasWifi && n.enabled);
        t.setSubtitle(subtitle);
        t.setIcon([wifiIcon, 'network-wireless-symbolic']);

        // Wired
        let wiredUp = n.wired.find(d => d.state === 'connected');
        let wiredBusy = n.wired.find(d => d.state.startsWith('connecting'));
        this._wiredToggle.setShown(n.wired.length > 0);
        this._wiredToggle.setChecked(!!wiredUp);
        this._wiredToggle.setSubtitle(wiredUp ? wiredUp.conn : (wiredBusy ? _('Connecting…') : (n.wired.length && n.wired[0].state === 'unavailable' ? _('Cable unplugged') : '')));
        this._wiredToggle.setIcon([wiredUp ? 'network-wired-symbolic' : 'network-wired-disconnected-symbolic', 'network-wired-symbolic']);

        // VPN
        let activeVpns = n.vpns.filter(v => v.active);
        this._vpnToggle.setShown(n.vpns.length > 0);
        this._vpnToggle.setChecked(activeVpns.length > 0);
        this._vpnToggle.setSubtitle(activeVpns.length === 1 ? activeVpns[0].name : (activeVpns.length > 1 ? `${activeVpns.length} ${_('Connected')}` : ''));
        if (this._openMenu === this._vpnToggle.menu) this._buildVpnMenu();

        // Hotspot
        this._hotspotToggle.setShown(n.hasWifi);
        this._hotspotToggle.setChecked(!!n.hotspot);
        this._hotspotToggle.setSubtitle(n.hotspot ? n.hotspot.name : '');
        if (this._openMenu === this._hotspotToggle.menu) this._buildHotspotMenu();

        // Panel
        let panel;
        if (activeVpns.length) panel = ['network-vpn-symbolic', 'network-wired-symbolic'];
        else if (wiredUp) panel = ['network-wired-symbolic'];
        else if (n.hasWifi && n.enabled) panel = [wifiIcon, 'network-wireless-symbolic'];
        else panel = ['network-offline-symbolic', 'network-wired-disconnected-symbolic'];
        this._setPanelIcon('network', panel, true);

        this._syncAirplane();
    }

    _toggleWifi() {
        if (!this._net || !this._net.hasWifi) { this._launch(['cinnamon-settings', 'network']); return; }
        let on = !this._net.enabled;
        this._net.enabled = on;
        this._applyNetwork();
        run(['nmcli', 'radio', 'wifi', on ? 'on' : 'off'], () => this._queue('net', 600, () => this._nmSync()));
    }

    _toggleWired() {
        let wired = this._net ? this._net.wired : [];
        if (!wired.length) return;
        let up = wired.find(d => d.state === 'connected');
        let dev = up || wired[0];
        run(['nmcli', 'device', up ? 'disconnect' : 'connect', dev.dev], () => this._queue('net', 400, () => this._nmSync()));
    }

    _buildWifiMenu(networks) {
        let menu = this._wifiToggle.menu;
        menu.clear();
        menu.setFooter([{ label: _('All Networks'), onActivate: () => this._launch(['cinnamon-settings', 'network']) }]);
        if (!this._net || !this._net.hasWifi) { menu.addLabel(_('No Wi-Fi adapter found')); return; }
        if (!this._net.enabled) { menu.addLabel(_('Wi-Fi is off')); return; }
        if (this._net.hotspot) { menu.addLabel(_('Wi-Fi is being used as a hotspot')); return; }
        if (!networks) {
            menu.addLabel(_('Scanning…'));
            // Start nmcli once the submenu animation is done (spawning briefly stalls Cinnamon).
            this._queue('wifiscan', this._afterAnim(200), () => { if (this._openMenu === menu) run(['nmcli', '-t', '-f', 'IN-USE,SIGNAL,SECURITY,SSID', 'device', 'wifi', 'list'], (ok, out) => {
                let best = new Map();
                for (let f of terseLines(out)) {
                    let net = { active: f[0] === '*', signal: parseInt(f[1]) || 0, secure: !!f[2] && f[2] !== '--', ssid: f[3] };
                    if (!net.ssid) continue;
                    let cur = best.get(net.ssid);
                    if (!cur || net.active || (!cur.active && net.signal > cur.signal)) best.set(net.ssid, net);
                }
                let list = [...best.values()].sort((a, b) => (b.active - a.active) || (b.signal - a.signal)).slice(0, 25);
                if (this._openMenu === menu) this._buildWifiMenu(list);
            }); });
            return;
        }
        if (!networks.length) { menu.addLabel(_('No networks found')); return; }
        for (let net of networks) {
            menu.addItem({
                label: net.ssid,
                icon: [wifiSignalIcon(net.signal)],
                checked: net.active,
                trailingIcon: (!net.active && net.secure) ? ['channel-secure-symbolic', 'network-wireless-encrypted-symbolic', 'changes-prevent-symbolic'] : null,
                onActivate: () => {
                    this.menu.close();
                    // Cinnamon's network agent asks for the password if one is needed.
                    if (!net.active) run(['nmcli', 'device', 'wifi', 'connect', net.ssid], () => this._nmSync());
                },
            });
        }
    }

    _toggleVpn() {
        let vpns = this._net ? this._net.vpns : [];
        if (!vpns.length) return;
        let active = vpns.filter(v => v.active);
        if (active.length) {
            for (let v of active) run(['nmcli', 'connection', 'down', 'uuid', v.uuid], () => this._queue('net', 400, () => this._nmSync()));
        } else {
            let target = vpns.find(v => v.uuid === this._lastVpn) || vpns[0];
            this._lastVpn = target.uuid;
            run(['nmcli', 'connection', 'up', 'uuid', target.uuid], () => this._queue('net', 400, () => this._nmSync()));
        }
    }

    _buildVpnMenu() {
        let menu = this._vpnToggle.menu;
        menu.clear();
        menu.setFooter([{ label: _('VPN Settings'), onActivate: () => this._launch(hasProgram('nm-connection-editor') ? ['nm-connection-editor'] : ['cinnamon-settings', 'network']) }]);
        let vpns = this._net ? this._net.vpns : [];
        if (!vpns.length) { menu.addLabel(_('No VPN connections')); return; }
        for (let v of vpns) {
            menu.addItem({
                label: v.name,
                icon: ['network-vpn-symbolic'],
                checked: v.active,
                onActivate: () => {
                    if (!v.active) this._lastVpn = v.uuid;
                    run(['nmcli', 'connection', v.active ? 'down' : 'up', 'uuid', v.uuid], () => this._queue('net', 400, () => this._nmSync()));
                },
            });
        }
    }

    _toggleHotspot() {
        let n = this._net;
        if (!n || !n.hasWifi) return;
        if (n.hotspot) {
            run(['nmcli', 'connection', 'down', 'uuid', n.hotspot.uuid], () => this._queue('net', 400, () => this._nmSync()));
        } else {
            let argv = ['nmcli', 'device', 'wifi', 'hotspot'];
            if (n.wifiDev) argv.push('ifname', n.wifiDev);
            run(argv, (ok) => {
                if (!ok) global.logError('[gqs] hotspot could not be started');
                this._queue('net', 600, () => this._nmSync());
            });
        }
    }

    _buildHotspotMenu() {
        let menu = this._hotspotToggle.menu;
        menu.clear();
        menu.setFooter([{ label: _('Wi-Fi Settings'), onActivate: () => this._launch(['cinnamon-settings', 'network']) }]);
        let hs = this._net ? this._net.hotspot : null;
        if (!hs) { menu.addLabel(_('Turn on Hotspot to share your connection')); return; }
        menu.addLabel(_('Loading…'));
        run(['nmcli', '-s', '-g', '802-11-wireless.ssid,802-11-wireless-security.psk', 'connection', 'show', 'uuid', hs.uuid], (ok, out) => {
            if (this._openMenu !== menu) return;
            let [ssid, psk] = out.split('\n');
            menu.clear();
            menu.addItem({ label: ssid || hs.name, sublabel: _('Network name'), icon: ['network-wireless-hotspot-symbolic', 'network-wireless-symbolic'] });
            menu.addItem({ label: psk || _('No password'), sublabel: _('Password'), icon: ['dialog-password-symbolic', 'channel-secure-symbolic'] });
        });
    }

    /* ===== Bluetooth (BlueZ) ===== */

    _initBluetooth() {
        this._watchResumeForBt();
        this._btPowered = false;
        this._btDevices = [];
        this._btAdapter = null;
        this._btWatch = Gio.bus_watch_name(Gio.BusType.SYSTEM, 'org.bluez', Gio.BusNameWatcherFlags.NONE,
            () => this._btRefresh(),
            () => { this._btAdapter = null; this._btDevices = []; this._syncBluetooth(); });
        this._btSub = Gio.DBus.system.signal_subscribe('org.bluez', null, null, null, null,
            Gio.DBusSignalFlags.NONE, () => this._queue('bt', 300, () => this._btRefresh()));
    }

    _btRefresh() {
        if (this._btWatch === undefined) return;
        Gio.DBus.system.call('org.bluez', '/', 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects',
            null, null, Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                let objs;
                try { objs = conn.call_finish(res).recursiveUnpack()[0]; }
                catch (e) { this._btAdapter = null; this._btDevices = []; this._syncBluetooth(); return; }

                let adapter = null, powered = false, devices = [];
                for (let path in objs) {
                    let ifaces = objs[path];
                    if (!adapter && ifaces['org.bluez.Adapter1']) {
                        adapter = path;
                        powered = !!ifaces['org.bluez.Adapter1'].Powered;
                    }
                }
                for (let path in objs) {
                    let d = objs[path]['org.bluez.Device1'];
                    if (!d || (adapter && d.Adapter !== adapter)) continue;
                    if (!d.Paired && !d.Connected) continue;
                    devices.push({
                        path, name: d.Alias || d.Name || d.Address || _('Unknown device'),
                        icon: d.Icon || null, connected: !!d.Connected,
                    });
                }
                devices.sort((a, b) => (b.connected - a.connected) || a.name.localeCompare(b.name));
                this._btAdapter = adapter;
                this._btPowered = powered;
                this._btDevices = devices;
                this._syncBluetooth();
                this._btLoginPolicy();
            });
    }

    /* Bluetooth at login. BlueZ switches the adapter on at every boot (AutoEnable=true);
       normally Blueman's tray app turns it back to your last state, but only if it starts
       at login. Quick Settings does that job here. */
    _btLoginPolicy() {
        if (!this._btAdapter) {
            // Adapter gone (rfkill, USB reset, suspend): when it comes back the system powers it on
            // again, so apply the login choice afresh then.
            this._btLoginStart = undefined;
            return;
        }
        let mode = this.cfg('bt-at-login');
        let now = GLib.get_monotonic_time();
        if (this._btLoginStart === undefined) { this._btLoginStart = now; this._btWant = undefined; }
        if (mode === 'off') this._blumanAutoPowerOff();

        // Window after login / adapter appearing / resume: apply the chosen state. 60 s, because
        // BlueZ and Bluetooth Manager (Blueman) can switch it on well after login on a slow boot.
        if (now - this._btLoginStart < 60e6 && mode !== 'system') {
            if (this._btWant === undefined) {
                let saved = this.cfg('bt-last-powered');
                if (mode === 'off') this._btWant = false;
                else if (mode === 'on') this._btWant = true;
                else this._btWant = (saved === true || saved === false) ? saved : null;   // remember
                if (this._btWant !== null) global.log(`[gqs] bluetooth at login: ${mode} -> ${this._btWant ? 'on' : 'off'}`);
            }
            if (this._btWant !== null && this._btWant !== this._btPowered && !this._btApplying) {
                this._btApplying = true;
                this._setBtPowered(this._btWant, true);
            }
            return;
        }
        // After that: remember whatever you (or any app) set, for the next login.
        if (this.cfg('bt-last-powered') !== this._btPowered) {
            try { this.settings.setValue('bt-last-powered', this._btPowered); } catch (e) { }
        }
    }

    // With "Always off", stop Bluetooth Manager (Blueman) powering the adapter on by itself.
    _blumanAutoPowerOff() {
        if (this._blumanDone) return;
        this._blumanDone = true;
        let s = lookupSettings('org.blueman.plugins.powermanager', 'auto-power-on');
        try { if (s && s.get_boolean('auto-power-on')) { s.set_boolean('auto-power-on', false); global.log('[gqs] Blueman auto power-on turned off'); } }
        catch (e) { }
    }

    // After waking from suspend the system may switch Bluetooth on again: re-apply the choice.
    _watchResumeForBt() {
        if (this._btResumeSub) return;
        try {
            this._btResumeSub = Gio.DBus.system.signal_subscribe('org.freedesktop.login1', 'org.freedesktop.login1.Manager',
                'PrepareForSleep', '/org/freedesktop/login1', null, Gio.DBusSignalFlags.NONE,
                (conn, sender, path, iface, signal, params) => {
                    let [sleeping] = params.deep_unpack();
                    if (sleeping) return;
                    this._kbdLoginPolicy(true);   // keyboards often light up again after waking
                    if (this.cfg('bt-at-login') !== 'system') {
                        this._btLoginStart = undefined;
                        this._queue('bt-resume', 3000, () => this._btRefresh());
                    }
                });
        } catch (e) { this._btResumeSub = 0; }
    }

    _syncBluetooth() {
        let t = this._btToggle;
        t.setShown(!!this._btAdapter);
        t.setChecked(this._btPowered);
        let connected = this._btDevices.filter(d => d.connected);
        if (!this._btPowered) t.setSubtitle('');
        else if (connected.length === 1) t.setSubtitle(connected[0].name);
        else if (connected.length > 1) t.setSubtitle(`${connected.length} ${_('Connected')}`);
        else t.setSubtitle('');
        t.setIcon(this._btPowered ? ['bluetooth-active-symbolic'] : ['bluetooth-disabled-symbolic', 'bluetooth-active-symbolic']);
        this._setPanelIcon('bluetooth', ['bluetooth-active-symbolic'], this._btPowered && connected.length > 0);
        if (this._openMenu === t.menu) this._buildBtMenu();
        this._syncAirplane();
    }

    _setBtPowered(on, fromPolicy) {
        if (!this._btAdapter) return;
        let adapter = this._btAdapter;
        if (!fromPolicy) {
            // Your choice wins, and is remembered for the next login.
            this._btWant = on;
            try { this.settings.setValue('bt-last-powered', on); } catch (e) { }
        }
        let doSet = () => Gio.DBus.system.call('org.bluez', adapter, 'org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', ['org.bluez.Adapter1', 'Powered', new GLib.Variant('b', on)]),
            null, Gio.DBusCallFlags.NONE, -1, null, (c, r) => {
                try { c.call_finish(r); } catch (e) { global.logError('[gqs] bluetooth: ' + e); }
                this._btApplying = false;
                this._btRefresh();
            });
        if (on && hasProgram('rfkill')) run(['rfkill', 'unblock', 'bluetooth'], () => doSet());
        else doSet();
    }

    _btDeviceAction(dev) {
        Gio.DBus.system.call('org.bluez', dev.path, 'org.bluez.Device1', dev.connected ? 'Disconnect' : 'Connect',
            null, null, Gio.DBusCallFlags.NONE, 30000, null, (c, r) => {
                try { c.call_finish(r); } catch (e) { global.logError('[gqs] bluetooth: ' + e); }
                this._btRefresh();
            });
    }

    _buildBtMenu() {
        let menu = this._btToggle.menu;
        menu.clear();
        let settings = hasProgram('blueman-manager') ? ['blueman-manager'] : ['cinnamon-settings', 'bluetooth'];
        menu.setFooter([{ label: _('Bluetooth Settings'), onActivate: () => this._launch(settings) }]);
        if (!this._btPowered) { menu.addLabel(_('Bluetooth is off')); return; }
        if (!this._btDevices.length) { menu.addLabel(_('No paired devices')); return; }
        for (let dev of this._btDevices) {
            menu.addItem({
                label: dev.name,
                icon: dev.icon ? [`${dev.icon}-symbolic`, 'bluetooth-active-symbolic'] : ['bluetooth-active-symbolic'],
                checked: dev.connected,
                onActivate: () => this._btDeviceAction(dev),
            });
        }
    }

    /* ===== Power profiles (power-profiles-daemon) ===== */

    _initPowerProfiles(candidates) {
        if (!candidates.length) { this._powerModeToggle.setShown(false); return; }
        let [name, path] = candidates[0];
        let Proxy = Gio.DBusProxy.makeProxyWrapper(powerProfilesXml(name));
        new Proxy(Gio.DBus.system, name, path, (proxy, error) => {
            if (error || !proxy.g_name_owner || !proxy.ActiveProfile) {
                this._initPowerProfiles(candidates.slice(1));
                return;
            }
            this._ppProxy = proxy;
            this._connect(proxy, 'g-properties-changed', () => this._syncPowerMode());
            this._syncPowerMode();
        });
    }

    _profiles() {
        try { return this._ppProxy.Profiles.map(p => p.Profile.unpack()); }
        catch (e) { return ['power-saver', 'balanced', 'performance']; }
    }

    _syncPowerMode() {
        let p = this._ppProxy;
        if (!p) return;
        let active = p.ActiveProfile;
        let info = PROFILE_INFO[active] || PROFILE_INFO['balanced'];
        if (active !== 'balanced' && PROFILE_INFO[active]) this._lastProfile = active;
        let t = this._powerModeToggle;
        t.setShown(true);
        t.setChecked(active !== 'balanced');
        t.setSubtitle(info.label);
        t.setIcon(info.icon);
        if (this._openMenu === t.menu) this._buildPowerModeMenu();
    }

    _togglePowerMode() {
        if (!this._ppProxy) return;
        let profiles = this._profiles();
        let fallback = profiles.includes('power-saver') ? 'power-saver' : profiles.find(p => p !== 'balanced');
        this._ppProxy.ActiveProfile = this._powerModeToggle.checked ? 'balanced' : (this._lastProfile || fallback || 'balanced');
    }

    _buildPowerModeMenu() {
        let menu = this._powerModeToggle.menu;
        menu.clear();
        menu.setFooter([{ label: _('Power Settings'), onActivate: () => this._launch(['cinnamon-settings', 'power']) }]);
        if (!this._ppProxy) return;
        let active = this._ppProxy.ActiveProfile;
        let available = this._profiles();
        for (let prof of ['performance', 'balanced', 'power-saver']) {
            if (!available.includes(prof)) continue;
            let info = PROFILE_INFO[prof];
            menu.addItem({
                label: info.label, icon: info.icon, checked: prof === active,
                onActivate: () => { this._ppProxy.ActiveProfile = prof; },
            });
        }
    }

    /* ===== Night Light ===== */

    _initNightLight() {
        this._colorSettings = lookupSettings('org.cinnamon.settings-daemon.plugins.color', 'night-light-enabled');
        if (!this._colorSettings) { this._nightToggle.setShown(false); return; }
        this._connect(this._colorSettings, 'changed::night-light-enabled', () => this._syncNightLight());
        this._syncNightLight();
    }

    _syncNightLight() {
        let on = this._colorSettings.get_boolean('night-light-enabled');
        this._nightToggle.setShown(true);
        this._nightToggle.setChecked(on);
        this._setPanelIcon('nightlight', ['night-light-symbolic', 'weather-clear-night-symbolic'], on);
    }

    /* ===== Do Not Disturb ===== */

    _initDnd() {
        this._notifSettings = lookupSettings('org.cinnamon.desktop.notifications', 'display-notifications');
        if (!this._notifSettings) { this._dndToggle.setShown(false); return; }
        this._connect(this._notifSettings, 'changed::display-notifications', () => this._syncDnd());
        this._syncDnd();
    }

    _syncDnd() {
        let dnd = !this._notifSettings.get_boolean('display-notifications');
        this._dndToggle.setShown(true);
        this._dndToggle.setChecked(dnd);
        this._setPanelIcon('dnd', ['notifications-disabled-symbolic', 'notification-disabled-symbolic'], dnd);
    }

    /* ===== Caffeine (session idle inhibitor) ===== */

    _setCaffeine(on) {
        let bus = Gio.DBus.session;
        const NAME = 'org.gnome.SessionManager', PATH = '/org/gnome/SessionManager';
        if (on && !this._inhibitCookie) {
            // flags: 4 = suspend, 8 = idle (screen blank / lock)
            bus.call(NAME, PATH, NAME, 'Inhibit',
                new GLib.Variant('(susu)', ['LMQS', 0, 'Caffeine is keeping the computer awake', 12]),
                null, Gio.DBusCallFlags.NONE, -1, null, (c, r) => {
                    try { [this._inhibitCookie] = c.call_finish(r).deepUnpack(); }
                    catch (e) { global.logError('[gqs] caffeine: ' + e); }
                    this._syncCaffeine();
                });
        } else if (!on && this._inhibitCookie) {
            let cookie = this._inhibitCookie;
            this._inhibitCookie = 0;
            bus.call(NAME, PATH, NAME, 'Uninhibit', new GLib.Variant('(u)', [cookie]),
                null, Gio.DBusCallFlags.NONE, -1, null, (c, r) => {
                    try { c.call_finish(r); } catch (e) { }
                });
            this._syncCaffeine();
        }
    }

    _syncCaffeine() {
        let on = !!this._inhibitCookie;
        this._caffeineToggle.setChecked(on);
        this._caffeineToggle.setSubtitle(on ? _('Keeping awake') : '');
        this._setPanelIcon('caffeine', [localIcon('gqs-caffeine-symbolic'), 'preferences-desktop-screensaver-symbolic'], on);
    }

    /* ===== Auto Rotate ===== */

    _initRotation() {
        this._touchscreenSettings = lookupSettings('org.cinnamon.settings-daemon.peripherals.touchscreen', 'orientation-lock');
        if (!this._touchscreenSettings) return;
        this._connect(this._touchscreenSettings, 'changed::orientation-lock', () => this._syncRotation());
        this._sensorWatch = Gio.bus_watch_name(Gio.BusType.SYSTEM, 'net.hadess.SensorProxy', Gio.BusNameWatcherFlags.NONE,
            () => {
                if (this._sensorProxy || this._sensorPending) { this._syncRotation(); return; }
                this._sensorPending = true;
                new SensorProxy(Gio.DBus.system, 'net.hadess.SensorProxy', '/net/hadess/SensorProxy', (proxy, error) => {
                    this._sensorPending = false;
                    if (error) return;
                    this._sensorProxy = proxy;
                    this._connect(proxy, 'g-properties-changed', () => this._syncRotation());
                    this._syncRotation();
                }, null, Gio.DBusProxyFlags.DO_NOT_AUTO_START);
            },
            () => this._syncRotation());
    }

    _syncRotation() {
        let has = !!(this._sensorProxy && this._sensorProxy.g_name_owner && this._sensorProxy.HasAccelerometer);
        let locked = this._touchscreenSettings.get_boolean('orientation-lock');
        this._rotateToggle.setShown(has);
        this._rotateToggle.setChecked(!locked);
        this._rotateToggle.setIcon(locked ? ['rotation-locked-symbolic', 'object-rotate-right-symbolic'] : ['rotation-allowed-symbolic', 'object-rotate-right-symbolic']);
    }

    /* ===== Touchpad ===== */

    _initTouchpad() {
        let id = 'org.cinnamon.desktop.peripherals.touchpad';
        this._touchpadSettings = lookupSettings(id, 'send-events');
        this._touchpadKey = 'send-events';
        if (!this._touchpadSettings) {
            this._touchpadSettings = lookupSettings(id, 'touchpad-enabled');
            this._touchpadKey = 'touchpad-enabled';
        }
        if (!this._touchpadSettings) return;
        this._connect(this._touchpadSettings, 'changed::' + this._touchpadKey, () => this._syncTouchpad());
        this._syncTouchpad();
    }

    _hasTouchpad() {
        let devices = readFile('/proc/bus/input/devices') || '';
        return /touch ?pad|trackpad/i.test(devices);
    }

    _touchpadOn() {
        let s = this._touchpadSettings;
        if (this._touchpadKey === 'send-events') return s.get_string('send-events') !== 'disabled';
        return s.get_boolean('touchpad-enabled');
    }

    _syncTouchpad() {
        if (!this._touchpadSettings) return;
        let on = this._touchpadOn();
        this._touchpadToggle.setShown(this._hasTouchpad());
        this._touchpadToggle.setChecked(on);
        this._touchpadToggle.setIcon(on ? ['input-touchpad-symbolic'] : ['touchpad-disabled-symbolic', 'input-touchpad-symbolic']);
    }

    _toggleTouchpad() {
        let s = this._touchpadSettings;
        if (!s) return;
        let on = !this._touchpadOn();
        let apply = mode => {
            if (this._touchpadKey === 'send-events') s.set_string('send-events', mode);
            else s.set_boolean('touchpad-enabled', mode === 'enabled');
        };
        if (on) { apply('enabled'); return; }   // turning it back on needs no question

        // Turning it off: make sure there's another way to point and click first.
        let mice = this._externalMice();
        let body = mice.length
            ? _('Mouse found: %s.\n\nThe touchpad stops working until you turn it back on here.').replace('%s', mice.join(', '))
            : _('No mouse is connected by USB or Bluetooth, so the touchpad can only be set to turn off while a mouse is plugged in. Connect a mouse to turn it off completely.');
        let buttons = [{ label: _('Cancel'), key: Clutter.KEY_Escape, action: () => { } }];
        if (this._touchpadKey === 'send-events')
            buttons.push({ label: _('Only While a Mouse Is Plugged In'), action: () => apply('disabled-on-external-mouse') });
        // No mouse: "Disable Touchpad" is greyed out so it can't be tapped by accident.
        // "Only While a Mouse Is Plugged In" stays available: it's safe without a mouse.
        buttons.push({ label: _('Disable Touchpad'), default: !!mice.length, disabled: !mice.length, action: () => apply('disabled') });
        this._showDialog(_('Disable the touchpad?'), body, buttons, null, () => { });
    }

    /* Mice plugged into a USB port (USB-A or USB-C, including wireless receivers) or connected
       over Bluetooth. Anything wired inside the laptop is skipped: the touchpad, a TrackPoint,
       and the built-in keyboard (some, like Legion keyboards, also announce a "mouse" part).
       Each device's place in /sys tells us which bus it's on and whether its USB port is
       one you can plug into ("removable") or a fixed, internal connection. */
    _externalMice() {
        let text = readFile('/proc/bus/input/devices') || '';
        let found = [];
        for (let block of text.split(/\n\s*\n/)) {
            let name = (block.match(/^N: Name="(.*)"$/m) || [])[1] || '';
            let handlers = (block.match(/^H: Handlers=(.*)$/m) || [])[1] || '';
            let rel = (block.match(/^B: REL=(\S+)/m) || [])[1] || '0';
            let bus = ((block.match(/^I: Bus=(\w+)/m) || [])[1] || '').toLowerCase();
            let sysfs = (block.match(/^S: Sysfs=(.*)$/m) || [])[1] || '';
            let vendor = ((block.match(/^I: .*Vendor=(\w+)/m) || [])[1] || '').toLowerCase();
            if (!/\bmouse\d*\b/.test(handlers)) continue;                       // not a pointer
            if ((parseInt(rel.slice(-1), 16) & 3) !== 3) continue;               // no X/Y movement
            if (/touch ?pad|trackpad|synaptics|clickpad|keyboard/i.test(name)) continue;
            if (vendor === '048d') continue;   // ITE: laptop keyboard/lighting controllers (Legion etc.)
            let via = null;
            if (bus === '0005') via = 'Bluetooth';
            else if (bus === '0003') {
                // USB: internal (fixed) ports are part of the laptop; real ports are "removable".
                let port = this._usbPortKind(sysfs);
                if (port === 'fixed') continue;
                via = 'USB';
            } else continue;                                                      // PS/2, I2C, SMBus: built in
            let label = `${name} (${via})`;
            if (!found.includes(label)) found.push(label);
        }
        return found;
    }

    // "removable" / "fixed" / "unknown" for the USB port a device hangs off.
    _usbPortKind(sysfsPath) {
        if (!sysfsPath) return 'unknown';
        let parts = ('/sys' + sysfsPath).split('/');
        for (let i = parts.length; i > 3; i--) {
            let dir = parts.slice(0, i).join('/');
            let removable = readFile(dir + '/removable');
            if (removable === 'removable' || removable === 'fixed') return removable;
        }
        return 'unknown';
    }

    /* ===== Camera (privacy: unloads/blocks the webcam driver via a pkexec helper) ===== */

    _initCamera() {
        try {
            let dir = Gio.File.new_for_path('/etc/modprobe.d');
            this._cameraMonitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._connect(this._cameraMonitor, 'changed', () => this._queue('camera', 200, () => this._syncCamera()));
        } catch (e) { }
        this._syncCamera();
    }

    _hasCameraHardware() {
        try {
            let en = Gio.File.new_for_path('/sys/class/video4linux')
                .enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let found = en.next_file(null) !== null;
            en.close(null);
            return found;
        } catch (e) { return false; }
    }

    _syncCamera() {
        let helper = GLib.file_test(CAMERA_ON, GLib.FileTest.IS_EXECUTABLE) && GLib.file_test(CAMERA_OFF, GLib.FileTest.IS_EXECUTABLE);
        let blocked = GLib.file_test(CAMERA_BLOCK_FILE, GLib.FileTest.EXISTS);
        let t = this._cameraToggle;
        // Show it when a camera exists, or when we've blocked one (the device disappears then).
        let hardware = blocked || this._hasCameraHardware();
        t.setShown(true);
        t.setChecked(helper && !blocked);
        if (!helper) t.setSubtitle(_('Setup needed'));
        else if (!hardware) t.setSubtitle(_('No camera found'));
        else if (this._cameraBusy) t.setSubtitle(_('Switching…'));
        else t.setSubtitle(blocked ? _('Blocked') : '');
        t.setIcon(blocked || !helper ? ['camera-disabled-symbolic', 'camera-hardware-disabled-symbolic', 'camera-web-symbolic']
                                     : ['camera-web-symbolic', 'camera-photo-symbolic']);
        this._setPanelIcon('camera', ['camera-disabled-symbolic', 'camera-hardware-disabled-symbolic', 'camera-web-symbolic'], blocked);
    }

    _notify(title, body) {
        try { Main.notify(title, body); } catch (e) { global.logError(`[gqs] ${title}: ${body}`); }
    }

    _toggleCamera() {
        let ready = GLib.file_test(CAMERA_ON, GLib.FileTest.IS_EXECUTABLE) && GLib.file_test(CAMERA_OFF, GLib.FileTest.IS_EXECUTABLE);
        if (!ready) {
            this.menu.close();
            this._notify(_('Camera toggle needs a one-time setup'),
                _('Open a terminal in the Quick Settings folder and run: ./install.sh --camera'));
            return;
        }
        if (this._cameraBusy) return;
        let turnOff = !GLib.file_test(CAMERA_BLOCK_FILE, GLib.FileTest.EXISTS);
        this._cameraBusy = turnOff ? 'off' : 'on';
        this._syncCamera();
        run(['pkexec', turnOff ? CAMERA_OFF : CAMERA_ON], (ok, out, status) => {
            this._cameraBusy = false;
            this._syncCamera();
            if (ok) return;
            if (status === 126 || status === 127) {
                this._notify(_('Camera toggle needs updating'),
                    _('Open a terminal in the Quick Settings folder and run: ./install.sh --camera'));
                return;
            }
            if (turnOff)
                this._notify(_("Couldn't turn off the camera"), _('An app is using it. Close the app and try again.'));
            else
                this._notify(_("Couldn't turn on the camera"), _('Try again, or check the log (Alt+F2, lg).'));
        });
    }

    /* ===== Dark Style ===== */

    _initDarkStyle() {
        this._ifaceSettings = lookupSettings('org.cinnamon.desktop.interface', 'gtk-theme');
        this._cinnTheme = lookupSettings('org.cinnamon.theme', 'name');
        this._portalSettings = lookupSettings('org.x.apps.portal', 'color-scheme');
        this._gnomeIface = lookupSettings('org.gnome.desktop.interface', 'color-scheme');
        if (this._ifaceSettings) this._connect(this._ifaceSettings, 'changed::gtk-theme', () => this._syncDarkStyle());
        if (this._portalSettings) this._connect(this._portalSettings, 'changed::color-scheme', () => this._syncDarkStyle());
        this._syncDarkStyle();
    }

    _isDark() {
        if (this._portalSettings && this._portalSettings.get_string('color-scheme') === 'prefer-dark') return true;
        if (this._ifaceSettings && /dark/i.test(this._ifaceSettings.get_string('gtk-theme'))) return true;
        return false;
    }

    /* "Apply the menu style to the whole system": picking Dark or Light for the menu switches
       the OS (apps, windows, Cinnamon theme) the same way the Dark Style tile does, and the
       other way round, a system change (tile or System Settings) updates the menu style. */
    _styleWide() {
        return !!this.cfg('style-system-wide') && ['dark', 'light'].includes(this.cfg('card-style'));
    }

    _pushStyleToSystem() {
        if (!this._styleWide()) return;
        let dark = this.cfg('card-style') === 'dark';
        if (this._isDark() === dark) return;
        this._styleSetAt = GLib.get_monotonic_time();
        this._setDarkStyle(dark);
    }

    _pullStyleFromSystem(dark) {
        if (!this._styleWide() || !this.settings) return;
        // Ignore the echo of our own change for a moment (some themes have no exact light/dark pair).
        if (this._styleSetAt && GLib.get_monotonic_time() - this._styleSetAt < 3e6) return;
        let want = dark ? 'dark' : 'light';
        if (this.cfg('card-style') === want) return;
        this._cfg_card_style = want;
        this._syncingFromFile = true;
        try { this.settings.setValue('card-style', want); } catch (e) { }
        this._syncingFromFile = false;
        this._changedKeys = null;   // handled right here
        this._applySettingsAnimated(['accent-color']);   // light/dark look change, not a layout change
    }

    _syncDarkStyle() {
        if (!this._darkToggle) return;
        this._darkToggle.setChecked(this._isDark());
        this._pullStyleFromSystem(this._isDark());
        if (this._main && this.cfg('card-style') === 'system') this._applyCardStyle();
    }

    _themeExists(name, sub) {
        let dirs = [GLib.get_home_dir() + '/.themes', GLib.get_user_data_dir() + '/themes'];
        for (let d of GLib.get_system_data_dirs()) dirs.push(d + '/themes');
        return dirs.some(d => GLib.file_test(`${d}/${name}/${sub}`, GLib.FileTest.IS_DIR));
    }

    // Installed theme names that have a given part (gtk-3.0, gtk-4.0, cinnamon).
    _listThemes(sub) {
        let dirs = [GLib.get_home_dir() + '/.themes', GLib.get_user_data_dir() + '/themes'];
        for (let d of GLib.get_system_data_dirs()) dirs.push(d + '/themes');
        let names = new Set();
        for (let d of dirs) {
            try {
                let en = Gio.File.new_for_path(d).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                let info;
                while ((info = en.next_file(null)) !== null) {
                    let n = info.get_name();
                    if (GLib.file_test(`${d}/${n}/${sub}`, GLib.FileTest.IS_DIR)) names.add(n);
                }
                en.close(null);
            } catch (e) { }
        }
        return [...names];
    }

    /* The light or dark twin of a theme. Works with the usual naming schemes:
       Mint-Y-Aqua <-> Mint-Y-Dark-Aqua, Adwaita <-> Adwaita-dark, Yaru <-> Yaru-dark,
       Orchis-Compact <-> Orchis-Dark-Compact, WhiteSur-Light <-> WhiteSur-Dark, ... */
    _themeVariant(name, dark, sub) {
        const isDark = n => /dark/i.test(n);
        if (dark === isDark(name)) return name;
        // Same name once "dark"/"light" (and the separators around them) are taken out.
        const key = n => n.toLowerCase().replace(/darker|dark|light/g, '').replace(/[-_ .]+/g, '-').replace(/^-|-$/g, '');
        let k = key(name);
        let themes = this._listThemes(sub).filter(t => t !== name && key(t) === k && isDark(t) === dark);
        if (!themes.length) return null;
        // Prefer "Dark" over "Darker", and the plain light theme over a "-Light" one.
        const score = t => dark ? (/darker/i.test(t) ? 1 : 0) : (/light/i.test(t) ? 1 : 0);
        themes.sort((a, b) => score(a) - score(b) || a.length - b.length);
        return themes[0];
    }

    _setDarkStyle(dark) {
        // Apps and windows (Nemo, Text Editor, ...): the GTK theme. GTK 3 apps only switch when
        // the theme itself changes, the dark/light preference alone isn't enough for them.
        if (this._ifaceSettings) {
            let cur = this._ifaceSettings.get_string('gtk-theme');
            let v = this._themeVariant(cur, dark, 'gtk-3.0');
            if (v && v !== cur) this._ifaceSettings.set_string('gtk-theme', v);
            if (!v) global.logError(`[gqs] no ${dark ? 'dark' : 'light'} version of the "${cur}" app theme is installed`);
            else global.log(`[gqs] app theme: ${cur} -> ${v}`);
            this._styleThemeMissing = !v;
        }
        if (this._cinnTheme) {
            let cur = this._cinnTheme.get_string('name');
            if (cur) {
                let v = this._themeVariant(cur, dark, 'cinnamon');
                if (v && v !== cur) this._cinnTheme.set_string('name', v);
            }
        }
        if (this._portalSettings) this._portalSettings.set_string('color-scheme', dark ? 'prefer-dark' : 'default');
        if (this._gnomeIface) this._gnomeIface.set_string('color-scheme', dark ? 'prefer-dark' : 'default');
        this._darkToggle.setChecked(dark);
        // Say so when the app theme has no light/dark twin (apps like Nemo then can't follow).
        this._darkToggle.setSubtitle(this._styleThemeMissing ? _('Apps unchanged: no matching theme') : '');
        if (this.cfg('card-style') === 'system') this._applyCardStyle();
    }

    /* ===== Airplane mode (rfkill) ===== */

    _readRfkill() {
        let devs = [];
        try {
            let dir = Gio.File.new_for_path('/sys/class/rfkill');
            let en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null)) !== null) {
                let base = '/sys/class/rfkill/' + info.get_name();
                let soft = readFile(base + '/soft');
                if (soft === null) continue;
                devs.push({ soft: soft === '1', hard: readFile(base + '/hard') === '1' });
            }
            en.close(null);
        } catch (e) { }
        return devs;
    }

    _syncAirplane() {
        if (!this._airplaneToggle) return;
        let devs = this._readRfkill();
        let ok = devs.length > 0 && hasProgram('rfkill');
        let on = ok && devs.every(d => d.soft || d.hard);
        this._airplaneOn = on;
        this._airplaneToggle.setShown(ok);
        this._airplaneToggle.setChecked(on);
        this._setPanelIcon('airplane', ['airplane-mode-symbolic'], on);
        if (on) { this._panelState.network.visible = false; this._refreshPanelIcon('network'); }
    }

    _toggleAirplane() {
        let on = !this._airplaneToggle.checked;
        run(['rfkill', on ? 'block' : 'unblock', 'all'], () => {
            this._queue('airplane', 400, () => { this._syncAirplane(); if (this._net) this._nmSync(); this._btRefresh(); });
        });
    }

    /* ===== Notifications (bottom section) ===== */

    _buildNotifications() {
        let n = {};
        n.actor = new St.BoxLayout({ vertical: true, style_class: 'gqs-notifications', x_expand: true, visible: false });

        // Header: tap to drop the list down (tiles shrink to a row of round buttons) or fold it up.
        let header = new St.BoxLayout({ style_class: 'gqs-notif-header-box', x_expand: true });
        n.title = new St.Label({ text: _('Notifications'), style_class: 'gqs-notif-title', y_align: CENTER });
        n.count = new St.Label({ text: '', style_class: 'gqs-notif-count', y_align: CENTER, visible: false });
        n.preview = ellipsize(new St.Label({ text: '', style_class: 'gqs-notif-preview', y_align: CENTER, x_expand: true }));
        n.chevron = new St.Icon({ icon_name: 'go-down-symbolic', icon_size: 16, y_align: CENTER });
        header.add_child(n.title);
        header.add_child(n.count);
        header.add_child(n.preview);
        header.add_child(n.chevron);
        n.headerButton = fill(new St.Button({ style_class: 'gqs-notif-header', child: header, x_expand: true, can_focus: true }));
        n.headerButton.connect('clicked', () => { if (this.guardClick()) return; this._setNotifExpanded(!this._notifExpanded); });
        let top = new St.BoxLayout({ x_expand: true, style_class: 'gqs-notif-top' });
        top.add_child(n.headerButton);
        n.actor.add_child(top);

        n.scroll = new St.ScrollView({ style_class: 'gqs-notif-scroll', x_expand: true, visible: false });
        setScrollPolicy(n.scroll);
        n.list = new St.BoxLayout({ vertical: true, style_class: 'gqs-notif-list', x_expand: true });
        setScrollChild(n.scroll, n.list);
        n.actor.add_child(n.scroll);
        n.empty = new St.Label({ text: _('No notifications'), style_class: 'gqs-notif-empty', x_align: CENTER, visible: false });
        n.actor.add_child(n.empty);
        // "Clear all" under the list, like Android.
        n.clearAll = align(new St.Button({ style_class: 'gqs-notif-clear-all', label: _('Clear all'), can_focus: true, visible: false }), CENTER, null);
        n.clearAll.connect('clicked', () => this._clearNotifications());
        n.actor.add_child(n.clearAll);
        n.chevron.set_pivot_point(0.5, 0.5);

        this._notif = n;
        this._notifications = [];
        this._notifExpanded = false;
    }

    _initNotifications() {
        let mt = Main.messageTray;
        if (!mt) return;
        this._notifAvailable = true;
        this._notifExpanded = !!this.cfg('notifications-expanded');
        // Cinnamon announces each notification it shows (the same signal its notification applet uses).
        this._connect(mt, 'notify-applet-update', (tray, notification) => this._addNotification(notification));
        this._renderNotifications();
        this._updateRows();
        this._relayout();
    }

    _setNotifExpanded(on) {
        this._notifExpanded = !!on;
        try { this.settings.setValue('notifications-expanded', this._notifExpanded); } catch (e) { }
        this.closeSubmenu(true);
        let nb = this._notif;
        let anim = this._animFactor() > 0;
        this._ease(nb.chevron, { rotation_angle_z: this._notifExpanded ? 180 : 0 }, 220);

        let wasCompact = !!this._shownCompact;
        let swapTiles = () => {
            // Tiles <-> round buttons: fade the new one in (only if they actually swap).
            this._updateRows();
            this._relayout();
            this._shownCompact = this._isCompact();
            if (anim && this._shownCompact !== wasCompact) {
                let target = this._isCompact() ? this._compactRow : this._grid;
                target.opacity = 0;
                target.translation_y = this._isCompact() ? 6 : -6;
                this._ease(target, { opacity: 255, translation_y: 0 }, 220);
            }
        };

        if (this._notifExpanded) {
            this._renderNotifications();
            swapTiles();
            for (let a of [nb.scroll, nb.empty, nb.clearAll]) {
                if (!a.visible || !anim) continue;
                a.opacity = 0;
                a.translation_y = -10;
                this._ease(a, { opacity: 255, translation_y: 0 }, 240);
            }
        } else {
            let showing = [nb.scroll, nb.empty, nb.clearAll].filter(a => a.visible);
            if (!anim || !showing.length) { this._renderNotifications(); swapTiles(); return; }
            showing.forEach(a => this._ease(a, { opacity: 0, translation_y: -10 }, 150, null, Clutter.AnimationMode.EASE_IN_QUAD));
            this._queue('notif-fold', this._afterAnim(150), () => {
                showing.forEach(a => { a.opacity = 255; a.translation_y = 0; });
                this._renderNotifications();
                swapTiles();
            });
        }
    }

    _addNotification(n) {
        if (!n || this._notifications.some(e => e.n === n)) { this._renderNotifications(); return; }
        let entry = { n, time: GLib.get_real_time() };
        try { entry.destroyId = n.connect('destroy', () => this._dropNotification(entry)); } catch (e) { }
        try { entry.updateId = n.connect('updated', () => this._queue('notif', 100, () => this._renderNotifications())); } catch (e) { }
        this._notifications.unshift(entry);
        while (this._notifications.length > 50) this._dropNotification(this._notifications[this._notifications.length - 1]);
        this._queue('notif', 50, () => this._renderNotifications());
    }

    _dropNotification(entry) {
        let i = this._notifications.indexOf(entry);
        if (i < 0) return;
        this._notifications.splice(i, 1);
        for (let id of [entry.destroyId, entry.updateId]) if (id) { try { entry.n.disconnect(id); } catch (e) { } }
        this._queue('notif', 50, () => this._renderNotifications());
    }

    _notifData(n) {
        let clean = t => String(t || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
        let title = clean(n.title || (n._titleLabel && n._titleLabel.text));
        let body = clean(n.bannerBodyText || n._bannerBodyText || n.body || (n._bodyText && n._bodyText.text));
        let app = '';
        try { app = clean(n.source && n.source.title); } catch (e) { }
        let gicon = null;
        try {
            if (n._icon && n._icon.gicon) gicon = n._icon.gicon;
            else if (n._icon && n._icon.icon_name) gicon = themedIcon([n._icon.icon_name]);
        } catch (e) { }
        if (!gicon) {
            try {
                let i = n.source.createNotificationIcon();
                gicon = i.gicon || (i.icon_name ? themedIcon([i.icon_name]) : null);
                i.destroy();
            } catch (e) { }
        }
        return { title, body, app, gicon: gicon || themedIcon(['dialog-information-symbolic', 'preferences-system-notifications-symbolic']) };
    }

    _timeAgo(usec) {
        let secs = Math.max(0, Math.round((GLib.get_real_time() - usec) / 1e6));
        if (secs < 60) return _('now');
        if (secs < 3600) return `${Math.floor(secs / 60)} ${_('min')}`;
        if (secs < 86400) return `${Math.floor(secs / 3600)} ${_('h')}`;
        let dt = GLib.DateTime.new_from_unix_local(Math.floor(usec / 1e6));
        return dt.format('%e %b').trim();
    }

    _renderNotifications() {
        let nb = this._notif;
        if (!nb) return;
        let list = this._notifications;
        let count = list.length;
        setText(nb.count, String(count));
        nb.count.visible = count > 0;
        let side = this._notifSide();
        let open = this._notifExpanded || side;     // at the side the list is always shown
        nb.chevron.icon_name = 'go-down-symbolic';
        nb.chevron.visible = !side;
        nb.chevron.rotation_angle_z = this._notifExpanded ? 180 : 0;
        nb.headerButton.reactive = !side;
        let first = count ? this._notifData(list[0].n) : null;
        setText(nb.preview, !open && first ? (first.title || first.body) : '');

        nb.scroll.visible = open && count > 0;
        nb.empty.visible = open && count === 0;
        nb.clearAll.visible = open && count > 1;
        if (!open) return;

        nb.list.destroy_all_children();
        for (let entry of list) {
            let d = this._notifData(entry.n);
            let card = new St.BoxLayout({ style_class: 'gqs-notif-card-box', x_expand: true });
            card.add_child(new St.Icon({ gicon: d.gicon, icon_size: 32, style_class: 'gqs-notif-icon', y_align: Clutter.ActorAlign.START }));
            let texts = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'gqs-notif-texts' });
            let meta = new St.BoxLayout({ x_expand: true });
            meta.add_child(ellipsize(new St.Label({ text: d.app || _('Notification'), style_class: 'gqs-notif-app', x_expand: true })));
            meta.add_child(new St.Label({ text: this._timeAgo(entry.time), style_class: 'gqs-notif-time' }));
            texts.add_child(meta);
            if (d.title) texts.add_child(ellipsize(new St.Label({ text: d.title, style_class: 'gqs-notif-card-title' })));
            if (d.body) {
                let body = new St.Label({ text: d.body, style_class: 'gqs-notif-body' });
                try {
                    body.clutter_text.line_wrap = true;
                    body.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
                    body.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                } catch (e) { }
                texts.add_child(body);
            }
            card.add_child(texts);

            let closeIcon = new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 14, x_align: CENTER, y_align: CENTER, x_expand: true, y_expand: true });
            let close = align(fill(new St.Button({ style_class: 'gqs-notif-close', child: closeIcon, can_focus: true })), null, Clutter.ActorAlign.START);
            try { close.set_accessible_name(_('Dismiss')); } catch (e) { }
            close.connect('clicked', () => this._dismissNotification(entry));
            card.add_child(close);

            let btn = fill(new St.Button({ style_class: 'gqs-notif-card', child: card, x_expand: true, can_focus: true }));
            btn.connect('clicked', () => this._openNotification(entry));
            nb.list.add_child(btn);
        }
    }

    _openNotification(entry) {
        this.menu.close();
        let n = entry.n;
        try { n.emit('clicked'); } catch (e) { }
        // The app's handler usually closes it; make sure it's gone either way.
        this._queue('notif-open', 100, () => {
            if (this._notifications.includes(entry)) { try { n.destroy(); } catch (e) { this._dropNotification(entry); } }
        });
    }

    _dismissNotification(entry) {
        try { entry.n.destroy(); } catch (e) { }
        this._dropNotification(entry);
    }

    _clearNotifications() {
        for (let entry of this._notifications.slice()) this._dismissNotification(entry);
    }

    /* ===== Media player card (MPRIS) ===== */

    _buildMediaCard() {
        let m = {};
        m.actor = new St.BoxLayout({ vertical: true, style_class: 'gqs-media', x_expand: true, visible: false });

        let mkButton = (names, cb, cls, size) => {
            let icon = new St.Icon({ gicon: themedIcon(names), icon_size: size || 16, x_align: CENTER, y_align: CENTER, x_expand: true, y_expand: true });
            let b = align(fill(new St.Button({ style_class: cls || 'gqs-media-button', child: icon, can_focus: true })), null, CENTER);
            b.connect('clicked', cb);
            b._icon = icon;
            return b;
        };

        /* small (one row) */
        m.small = new St.BoxLayout({ style_class: 'gqs-media-small', x_expand: true });
        m.art = new St.Icon({ style_class: 'gqs-media-art', icon_size: 48, y_align: CENTER });
        let artButton = align(fill(new St.Button({ style_class: 'gqs-media-art-button', child: m.art, can_focus: true })), null, CENTER);
        artButton.connect('clicked', () => this._raisePlayer());
        let info = new St.BoxLayout({ vertical: true, x_expand: true, y_align: CENTER, style_class: 'gqs-media-info' });
        m.app = ellipsize(new St.Label({ style_class: 'gqs-media-app', text: '' }));
        m.title = ellipsize(new St.Label({ style_class: 'gqs-media-title', text: '' }));
        m.artist = ellipsize(new St.Label({ style_class: 'gqs-media-artist', text: '' }));
        info.add_child(m.app);
        info.add_child(m.title);
        info.add_child(m.artist);
        let infoButton = fill(new St.Button({ style_class: 'gqs-media-info-button', child: info, x_expand: true, can_focus: true }));
        infoButton.connect('clicked', () => this._raisePlayer());
        let controls = new St.BoxLayout({ style_class: 'gqs-media-controls', y_align: CENTER });
        m.prev = mkButton(['media-skip-backward-symbolic'], () => this._mediaCall('Previous'));
        m.play = mkButton(['media-playback-start-symbolic'], () => this._mediaCall('PlayPause'));
        m.play.add_style_class_name('primary');
        m.next = mkButton(['media-skip-forward-symbolic'], () => this._mediaCall('Next'));
        m.grow = mkButton(['view-fullscreen-symbolic', 'zoom-in-symbolic'], () => this._setMediaLarge(true), 'gqs-media-button gqs-media-resize');
        try { m.grow.set_accessible_name(_('Enlarge player')); } catch (e) { }
        for (let b of [m.prev, m.play, m.next, m.grow]) controls.add_child(b);
        m.small.add_child(artButton);
        m.small.add_child(infoButton);
        m.small.add_child(controls);

        /* large (Android-style player) */
        m.large = new St.BoxLayout({ vertical: true, style_class: 'gqs-media-large', x_expand: true, visible: false });
        let head = new St.BoxLayout({ style_class: 'gqs-media-large-head', x_expand: true });
        m.bigArt = new St.Icon({ style_class: 'gqs-media-big-art', icon_size: 96, y_align: Clutter.ActorAlign.START });
        let bigArtButton = align(fill(new St.Button({ style_class: 'gqs-media-art-button', child: m.bigArt, can_focus: true })), null, Clutter.ActorAlign.START);
        bigArtButton.connect('clicked', () => this._raisePlayer());
        let bigInfo = new St.BoxLayout({ vertical: true, x_expand: true, y_align: CENTER, style_class: 'gqs-media-big-info' });
        m.bigApp = ellipsize(new St.Label({ style_class: 'gqs-media-app', text: '' }));
        m.bigTitle = new St.Label({ style_class: 'gqs-media-big-title', text: '' });
        try { m.bigTitle.clutter_text.line_wrap = true; m.bigTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END; } catch (e) { }
        m.bigArtist = ellipsize(new St.Label({ style_class: 'gqs-media-big-artist', text: '' }));
        bigInfo.add_child(m.bigApp);
        bigInfo.add_child(m.bigTitle);
        bigInfo.add_child(m.bigArtist);
        m.shrink = mkButton(['view-restore-symbolic', 'zoom-out-symbolic'], () => this._setMediaLarge(false), 'gqs-media-button gqs-media-resize');
        try { m.shrink.set_accessible_name(_('Shrink player')); } catch (e) { }
        head.add_child(bigArtButton);
        head.add_child(bigInfo);
        head.add_child(m.shrink);
        m.large.add_child(head);

        m.seekBox = new St.BoxLayout({ vertical: true, style_class: 'gqs-media-seek', x_expand: true });
        m.seek = new QSSlider(v => this._mediaSeek(v));
        this._sliders.push(m.seek);
        m.seekBox.add_child(m.seek.actor);
        let times = new St.BoxLayout({ x_expand: true, style_class: 'gqs-media-times' });
        m.pos = new St.Label({ text: '0:00', style_class: 'gqs-media-time', x_expand: true });
        m.len = new St.Label({ text: '0:00', style_class: 'gqs-media-time' });
        times.add_child(m.pos);
        times.add_child(m.len);
        m.seekBox.add_child(times);
        m.large.add_child(m.seekBox);

        let bigControls = new St.BoxLayout({ style_class: 'gqs-media-big-controls', x_align: CENTER });
        m.bigPrev = mkButton(['media-skip-backward-symbolic'], () => this._mediaCall('Previous'), 'gqs-media-big-button', 20);
        m.bigPlay = mkButton(['media-playback-start-symbolic'], () => this._mediaCall('PlayPause'), 'gqs-media-big-button gqs-media-big-play', 24);
        m.bigNext = mkButton(['media-skip-forward-symbolic'], () => this._mediaCall('Next'), 'gqs-media-big-button', 20);
        for (let b of [m.bigPrev, m.bigPlay, m.bigNext]) bigControls.add_child(b);
        m.large.add_child(bigControls);

        m.actor.add_child(m.small);
        m.actor.add_child(m.large);
        this._media = m;
        this._players = new Map();
    }

    _setMediaLarge(on) {
        let m = this._media;
        this._mediaLarge = !!on;
        try { this.settings.setValue('media-expanded', this._mediaLarge); } catch (e) { }
        let show = on ? m.large : m.small, hide = on ? m.small : m.large;
        hide.visible = false;
        show.visible = true;
        if (this._animFactor()) {
            show.opacity = 0;
            show.set_pivot_point(0.5, 0);
            show.scale_y = 0.92;
            this._ease(show, { opacity: 255, scale_y: 1 }, 220);
        }
        this._syncMedia();
        this._mediaPoll();
    }

    _fmtTime(usec) {
        let t = Math.max(0, Math.floor(usec / 1e6));
        let h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
        let ss = String(sec).padStart(2, '0');
        return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
    }

    // Position isn't announced by players, so ask once a second while the big player is visible.
    _mediaPoll() {
        let e = this._currentPlayer();
        let m = this._media;
        let want = !!(e && this._mediaLarge && this.menu.isOpen && m.actor.visible && m.seekBox.visible);
        if (!want) { if (this._mediaTimer) { GLib.source_remove(this._mediaTimer); this._mediaTimer = 0; } return; }
        let fetch = () => {
            let cur = this._currentPlayer();
            if (!cur) return;
            Gio.DBus.session.call(cur.busName, '/org/mpris/MediaPlayer2', 'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']), null,
                Gio.DBusCallFlags.NONE, 1000, null, (c, r) => {
                    try {
                        let pos = c.call_finish(r).deepUnpack()[0].deepUnpack();
                        this._mediaPos = Number(pos);
                        if (this._mediaLen) {
                            m.seek.setValue(this._mediaPos / this._mediaLen);
                            setText(m.pos, this._fmtTime(this._mediaPos));
                        }
                    } catch (err) { }
                });
        };
        fetch();
        if (!this._mediaTimer) this._mediaTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 1, () => {
            let cur = this._currentPlayer();
            if (!cur || !this._mediaLarge || !this.menu.isOpen) { this._mediaTimer = 0; return GLib.SOURCE_REMOVE; }
            fetch();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _mediaSeek(v) {
        let e = this._currentPlayer();
        if (!e || !e.player || !this._mediaLen || !this._mediaTrack) return;
        let pos = Math.round(v * this._mediaLen);
        setText(this._media.pos, this._fmtTime(pos));
        // Wait for the drag to settle before telling the player.
        this._pendingSeek = pos;
        this._queue('seek', 150, () => {
            try { e.player.SetPositionRemote(this._mediaTrack, this._pendingSeek, () => { }); } catch (err) { global.logError('[gqs] seek: ' + err); }
        });
    }

    _initMedia() {
        this._mediaLarge = !!this.cfg('media-expanded');
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
            null, null, Gio.DBusCallFlags.NONE, -1, null, (c, r) => {
                try {
                    let [names] = c.call_finish(r).deepUnpack();
                    for (let n of names) if (n.startsWith('org.mpris.MediaPlayer2.')) this._addPlayer(n);
                } catch (e) { }
            });
        this._mprisSub = Gio.DBus.session.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus',
            'NameOwnerChanged', '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
            (conn, sender, path, iface, signal, params) => {
                let [name, oldOwner, newOwner] = params.deepUnpack();
                if (!name.startsWith('org.mpris.MediaPlayer2.')) return;
                if (newOwner && !oldOwner) this._addPlayer(name);
                else if (!newOwner) this._removePlayer(name);
            });
    }

    _addPlayer(busName) {
        if (this._players.has(busName)) return;
        let entry = { busName, player: null, root: null, sigId: 0, lastActive: 0 };
        this._players.set(busName, entry);
        new MprisPlayerProxy(Gio.DBus.session, busName, '/org/mpris/MediaPlayer2', (proxy, error) => {
            if (error || !this._players.has(busName)) return;
            entry.player = proxy;
            entry.lastActive = GLib.get_monotonic_time();
            entry.sigId = proxy.connect('g-properties-changed', () => {
                if (proxy.PlaybackStatus === 'Playing') entry.lastActive = GLib.get_monotonic_time();
                this._queue('media', 100, () => this._syncMedia());
            });
            this._syncMedia();
        });
        new MprisProxy(Gio.DBus.session, busName, '/org/mpris/MediaPlayer2', (proxy, error) => {
            if (error || !this._players.has(busName)) return;
            entry.root = proxy;
            this._syncMedia();
        });
    }

    _removePlayer(busName) {
        let entry = this._players.get(busName);
        if (!entry) return;
        if (entry.player && entry.sigId) { try { entry.player.disconnect(entry.sigId); } catch (e) { } }
        this._players.delete(busName);
        this._syncMedia();
    }

    _currentPlayer() {
        if (!this._players) return null;
        let list = [...this._players.values()].filter(e => e.player && e.player.g_name_owner);
        if (!list.length) return null;
        let playing = list.filter(e => e.player.PlaybackStatus === 'Playing');
        let pool = playing.length ? playing : list.filter(e => e.player.PlaybackStatus === 'Paused');
        if (!pool.length) return null;
        pool.sort((a, b) => b.lastActive - a.lastActive);
        return pool[0];
    }

    _syncMedia() {
        if (!this._media) return;
        let m = this._media;
        let e = this._currentPlayer();
        this._updateRows();
        if (!e) return;
        let p = e.player;
        let md = {};
        try { md = p.Metadata || {}; } catch (err) { }
        let get = (k) => { try { return md[k] ? md[k].deepUnpack() : null; } catch (err) { return null; } };

        let title = get('xesam:title') || _('Unknown title');
        let artist = get('xesam:artist');
        if (Array.isArray(artist)) artist = artist.join(', ');
        let artUrl = get('mpris:artUrl');
        let identity = '', desktop = null;
        try { identity = e.root ? e.root.Identity : ''; desktop = e.root ? e.root.DesktopEntry : null; } catch (err) { }

        let appName = identity || e.busName.replace('org.mpris.MediaPlayer2.', '');
        setText(m.title, title);
        setText(m.artist, artist || '');
        m.artist.visible = !!artist;
        setText(m.app, appName);
        setText(m.bigTitle, title);
        setText(m.bigArtist, artist || '');
        m.bigArtist.visible = !!artist;
        setText(m.bigApp, appName);

        // Seek bar (needs a track id and a length from the player)
        let len = get('mpris:length');
        this._mediaLen = len ? Number(len) : 0;
        this._mediaTrack = get('mpris:trackid');
        let canSeek = false;
        try { canSeek = !!p.CanSeek; } catch (err) { }
        m.seekBox.visible = !!(this._mediaLen && this._mediaTrack && canSeek);
        setText(m.len, this._fmtTime(this._mediaLen));
        m.small.visible = !this._mediaLarge;
        m.large.visible = !!this._mediaLarge;

        let gicon = null;
        if (artUrl && /^(file|https?):\/\//.test(artUrl)) {
            try { gicon = new Gio.FileIcon({ file: Gio.File.new_for_uri(artUrl) }); } catch (err) { gicon = null; }
        }
        if (!gicon) gicon = themedIcon([desktop || '', 'audio-x-generic-symbolic']);
        m.art.gicon = gicon;
        m.bigArt.gicon = gicon;

        let playing = p.PlaybackStatus === 'Playing';
        let playIcon = [playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic'];
        setGicon(m.play._icon, playIcon);
        setGicon(m.bigPlay._icon, playIcon);
        for (let b of [m.prev, m.bigPrev]) { b.reactive = !!p.CanGoPrevious; b.opacity = p.CanGoPrevious ? 255 : 100; }
        for (let b of [m.next, m.bigNext]) { b.reactive = !!p.CanGoNext; b.opacity = p.CanGoNext ? 255 : 100; }
        this._mediaPoll();
    }

    _mediaCall(method) {
        let e = this._currentPlayer();
        if (!e || !e.player) return;
        try { e.player[method + 'Remote'](() => { }); } catch (err) { global.logError('[gqs] media: ' + err); }
    }

    _raisePlayer() {
        let e = this._currentPlayer();
        if (!e || !e.root) return;
        this.menu.close();
        try { e.root.RaiseRemote(() => { }); } catch (err) { }
    }

    /* ---------- cleanup ---------- */

    on_applet_removed_from_panel() {
        this._cancelDrag();
        if (this._btResumeSub) { try { Gio.DBus.system.signal_unsubscribe(this._btResumeSub); } catch (e) { } this._btResumeSub = 0; }
        if (this._netSpeedTimer) { GLib.source_remove(this._netSpeedTimer); this._netSpeedTimer = 0; }
        if (this._mediaTimer) { GLib.source_remove(this._mediaTimer); this._mediaTimer = 0; }
        if (this._animActors) for (let a of this._animActors) {
            if (a._gqsAnimDone) { GLib.source_remove(a._gqsAnimDone); a._gqsAnimDone = 0; }
        }
        for (let [obj, id] of this._signals) { try { obj.disconnect(id); } catch (e) { } }
        this._signals = [];
        for (let k in this._sources) GLib.source_remove(this._sources[k]);
        this._sources = {};
        if (this._sink && this._sinkSignals) for (let id of this._sinkSignals) { try { this._sink.disconnect(id); } catch (e) { } }
        if (this._source && this._sourceSignals) for (let id of this._sourceSignals) { try { this._source.disconnect(id); } catch (e) { } }
        if (this._mixer) { try { this._mixer.close(); } catch (e) { } }
        if (this._nmMon) { try { this._nmMon.force_exit(); } catch (e) { } }
        if (this._netTimer) { GLib.source_remove(this._netTimer); this._netTimer = 0; }
        if (this._screenProxy && this._screenSig) { try { this._screenProxy.disconnectSignal(this._screenSig); } catch (e) { } }
        if (this._kbdSub) { Gio.DBus.system.signal_unsubscribe(this._kbdSub); this._kbdSub = 0; }
        if (this._rgbWatch) { try { this._rgbWatch.force_exit(); } catch (e) { } this._rgbWatch = null; }
        if (this._kbdProxy) {
            try { this._kbdProxy.disconnectSignal(this._kbdSig1); this._kbdProxy.disconnectSignal(this._kbdSig2); } catch (e) { }
        }
        if (this._btWatch !== undefined) { Gio.bus_unwatch_name(this._btWatch); this._btWatch = undefined; }
        if (this._csdWatch) { Gio.bus_unwatch_name(this._csdWatch); this._csdWatch = 0; }
        if (this._sensorWatch) { Gio.bus_unwatch_name(this._sensorWatch); this._sensorWatch = 0; }
        if (this._btSub) { Gio.DBus.system.signal_unsubscribe(this._btSub); this._btSub = 0; }
        for (let entry of (this._notifications || []).slice())
            for (let id of [entry.destroyId, entry.updateId]) if (id) { try { entry.n.disconnect(id); } catch (e) { } }
        if (this._mprisSub) { Gio.DBus.session.signal_unsubscribe(this._mprisSub); this._mprisSub = 0; }
        if (this._players) for (let name of [...this._players.keys()]) this._removePlayer(name);
        if (this._inhibitCookie) this._setCaffeine(false);
        if (this._cameraMonitor) { try { this._cameraMonitor.cancel(); } catch (e) { } }
        if (this._settingsMonitor) { try { this._settingsMonitor.cancel(); } catch (e) { } }
        this._endPreview();
        if (this.settings) { try { this.settings.finalize(); } catch (e) { } }
        this.menu.destroy();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    ICON_DIR = metadata.path + '/icons';
    return new GnomeQuickSettingsApplet(metadata, orientation, panelHeight, instanceId);
}
