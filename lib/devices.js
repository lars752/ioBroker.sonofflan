'use strict';
/**
 * Geräte-Spezifikationen: UIID → Datenpunkte (lesen/schreiben).
 * Portiert und vereinfacht aus AlexxIT/SonoffLAN (MIT), core/devices.py sowie
 * switch.py, light.py, cover.py, fan.py, sensor.py, binary_sensor.py, select.py.
 *
 * Jedes Feature:
 *   states: [{ id, common }]
 *   update(params, dev): { relId: value } | null
 *   write(relId, value, dev): Befehl | null
 *   poll?: { interval (s), params, via: 'cloud' | 'any', timeoutLan? }
 *
 * Befehl: { params, paramsLan?, cmdLan?, bulk?: 'switches'|'configure',
 *           cloudOnly?, queryCloud?, preOn? }
 */
const { conv } = require('./util');

// ---------------------------------------------------------------- Hilfen ----

const onoff = v => (v ? 'on' : 'off');
const isOn = v => v === 'on' || v === true || v === 1;
const num = v => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
};
const has = (p, k) => p && Object.prototype.hasOwnProperty.call(p, k);
const hex = (r, g, b) => `#${[r, g, b].map(x => Number(x || 0).toString(16).padStart(2, '0')).join('')}`;
const parseHex = s => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(s).trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

function channelName(dev, ch, fallback) {
    try {
        return dev.tags.ck_channel_name[String(ch)] || fallback;
    } catch {
        return fallback;
    }
}

const SENSOR_META = [
    [/^temperature|_temperature$|^temp/, { unit: '°C', role: 'value.temperature' }],
    [/^humidity/, { unit: '%', role: 'value.humidity' }],
    [/^power/, { unit: 'W', role: 'value.power' }],
    [/^current/, { unit: 'A', role: 'value.current' }],
    [/^voltage/, { unit: 'V', role: 'value.voltage' }],
    [/^energy/, { unit: 'kWh', role: 'value.energy.consumed' }],
    [/^battery$/, { unit: '%', role: 'value.battery' }],
    [/^rssi$/, { unit: 'dBm', role: 'value' }],
    [/^illuminance$/, { unit: 'lx', role: 'value.brightness' }],
    [/^co2$/, { unit: 'ppm', role: 'value.co2' }],
    [/^pm/, { unit: 'µg/m³', role: 'value' }],
    [/^pressure$/, { unit: 'hPa', role: 'value.pressure' }],
    [/^valve_opening$/, { unit: '%', role: 'value.valve' }],
];

function sensorCommon(id, name, extra = {}) {
    let meta = { role: 'value' };
    for (const [re, m] of SENSOR_META) {
        if (re.test(id)) {
            meta = m;
            break;
        }
    }
    return { name, type: 'number', read: true, write: false, ...meta, ...extra };
}

const C = {
    sw: name => ({ name, type: 'boolean', role: 'switch', read: true, write: true }),
    ind: (name, role = 'indicator') => ({ name, type: 'boolean', role, read: true, write: false }),
    btn: name => ({ name, type: 'boolean', role: 'button', read: false, write: true }),
    str: (name, write = false, states) => ({ name, type: 'string', role: write ? 'state' : 'text', read: true, write, ...(states ? { states } : {}) }),
    level: (name, role, min, max, unit, write = true) => ({ name, type: 'number', role, read: true, write, min, max, ...(unit ? { unit } : {}) }),
};

// --------------------------------------------------------------- Features ---

const F = {};

/** Einkanalschalter (param switch: on/off). */
F.switch = (opts = {}) => ({
    states: [{ id: 'switch', common: C.sw('Schalter') }],
    update: p => (has(p, 'switch') ? { switch: isOn(p.switch) } : null),
    write: (id, v) => {
        if (id !== 'switch') return null;
        const params = { switch: onoff(v) };
        if (opts.th) Object.assign(params, { mainSwitch: onoff(v), deviceType: 'normal' });
        return { params };
    },
});

/** Kanal eines Mehrfachschalters (param switches[outlet]). */
F.channel = (ch, opts = {}) => {
    const id = `channel${ch + 1}`;
    return {
        states: dev => [{ id, common: C.sw(channelName(dev, ch, `Kanal ${ch + 1}`)) }],
        update: p => {
            if (!p || !Array.isArray(p.switches)) return null;
            const s = p.switches.find(i => i.outlet === ch);
            return s ? { [id]: isOn(s.switch) } : null;
        },
        write: (rid, v, dev) => {
            if (rid !== id) return null;
            if (opts.zigbee) {
                // Zigbee-Schalter erwarten alle Kanäle in einer Nachricht
                const cur = (dev.params && dev.params.switches) || [];
                const switches = cur.length
                    ? cur.map(s => (s.outlet === ch ? { outlet: ch, switch: onoff(v) } : s))
                    : [{ outlet: ch, switch: onoff(v) }];
                return { params: { switches } };
            }
            if (opts.powr3) return { params: { switches: [{ outlet: 0, switch: onoff(v) }], operSide: 1 } };
            return { params: { switches: [{ outlet: ch, switch: onoff(v) }] }, bulk: 'switches' };
        },
    };
};

/** on/off-String-Parameter als Boolean-Schalter (z. B. sledOnline). */
F.toggle = (param, id, name) => ({
    states: [{ id, common: C.sw(name) }],
    update: p => (has(p, param) ? { [id]: isOn(p[param]) } : null),
    write: (rid, v) => (rid === id ? { params: { [param]: onoff(v) } } : null),
});

/** Boolean-Parameter. */
F.bool = (param, id, name, extra = {}) => ({
    states: [{ id, common: C.sw(name) }],
    update: p => (has(p, param) ? { [id]: !!p[param] } : null),
    write: (rid, v) => (rid === id ? { params: { [param]: !!v, ...extra } } : null),
});

/** 1/0-Parameter (nur über Cloud steuerbar). */
F.int = (param, id, name) => ({
    states: [{ id, common: C.sw(name) }],
    update: p => (has(p, param) ? { [id]: p[param] === 1 } : null),
    write: (rid, v) => (rid === id ? { params: { [param]: v ? 1 : 0 }, cloudOnly: true } : null),
});

/** Relais abgekoppelt (relaySeparations: [{ outlet, enable }]), nur lesen: detach bei einem Kanal, sonst detach1…n. */
F.detach = n => ({
    states: Array.from({ length: n }, (_, i) => ({ id: n === 1 ? 'detach' : `detach${i + 1}`, common: C.ind(`Relais ${n === 1 ? '' : `${i + 1} `}abgekoppelt (Taster entkoppelt)`.replace('  ', ' '), 'indicator') })),
    update: p => {
        if (!p || !Array.isArray(p.relaySeparations)) return null;
        const out = {};
        for (const r of p.relaySeparations) {
            if (!r || typeof r.outlet !== 'number' || r.outlet < 0 || r.outlet >= n) continue;
            out[n === 1 ? 'detach' : `detach${r.outlet + 1}`] = r.enable === 1 || r.enable === true || r.enable === 'on';
        }
        return Object.keys(out).length ? out : null;
    },
});

/** Taster / Aktion (Wert wird bei Schreiben gesendet). */
F.button = (param, value, id, name) => ({
    states: [{ id, common: C.btn(name) }],
    update: () => null,
    write: (rid, v) => (rid === id && v ? { params: { [param]: value } } : null),
});

/** Zahlensensor. */
F.sensor = (param, opts = {}) => {
    const id = opts.id || param;
    return {
        states: [{ id, common: sensorCommon(id, opts.name || id, opts.common) }],
        update: p => {
            if (!has(p, param)) return null;
            let v = num(p[param]);
            if (v === null) return null;
            if (opts.mult) v *= opts.mult;
            if (opts.round !== undefined) v = Math.round(v * 10 ** opts.round) / 10 ** opts.round;
            else if (opts.mult) v = Math.round(v * 1000) / 1000;
            return { [id]: v };
        },
    };
};
const S100 = (param, id) => F.sensor(param, { id, mult: 0.01, round: 2 });

/** Textsensor. */
F.text = (param, id, name) => ({
    states: [{ id, common: C.str(name || id) }],
    update: p => (has(p, param) ? { [id]: typeof p[param] === 'object' ? JSON.stringify(p[param]) : String(p[param]) } : null),
});

/** Binärsensor. */
F.binary = (param, id, name, test, role = 'sensor') => ({
    states: [{ id, common: C.ind(name, role) }],
    update: p => (has(p, param) ? { [id]: test(p[param]) } : null),
});

/** Temperatur/Feuchte TH-Geräte (currentTemperature oder temperature). */
F.thTemp = () => ({
    states: [{ id: 'temperature', common: sensorCommon('temperature', 'Temperatur') }],
    update: p => {
        const raw = has(p, 'currentTemperature') ? p.currentTemperature : p && p.temperature;
        const v = num(raw);
        // Nullwerte und unplausible Werte filtern
        if (v === null || v === 0 || v <= -270 || v >= 270) return null;
        return { temperature: Math.round(v * 10) / 10 };
    },
});
F.thHum = () => ({
    states: [{ id: 'humidity', common: sensorCommon('humidity', 'Luftfeuchte') }],
    update: p => {
        const raw = has(p, 'currentHumidity') ? p.currentHumidity : p && p.humidity;
        const v = num(raw);
        if (v === null || v === 0) return null;
        return { humidity: v };
    },
});

/** Einschaltverhalten pro Kanal (configure-Liste). */
F.startupCh = ch => {
    const id = `startup${ch + 1}`;
    return {
        states: [{ id, common: C.str(`Einschaltverhalten Kanal ${ch + 1}`, true, { off: 'aus', on: 'an', stay: 'letzter Zustand' }) }],
        update: p => {
            if (!p || !Array.isArray(p.configure)) return null;
            const i = p.configure.find(x => x && x.outlet === ch);
            return i ? { [id]: i.startup || 'stay' } : null;
        },
        write: (rid, v, dev) => {
            if (rid !== id || !['off', 'on', 'stay'].includes(v)) return null;
            const list = ((dev.params && dev.params.configure) || []).filter(x => x && typeof x === 'object').map(x => ({ ...x }));
            const item = list.find(x => x.outlet === ch);
            if (item) item.startup = v;
            else list.push({ outlet: ch, startup: v, enableDelay: 0, width: 1000 });
            return { params: { configure: list } };
        },
    };
};

/** Einschaltverhalten (param startup). */
F.startup = () => ({
    states: [{ id: 'startup', common: C.str('Einschaltverhalten', true, { off: 'aus', on: 'an', stay: 'letzter Zustand' }) }],
    update: p => (has(p, 'startup') ? { startup: String(p.startup) } : null),
    write: (rid, v) => (rid === 'startup' && ['off', 'on', 'stay'].includes(v) ? { params: { startup: v } } : null),
});

/** Impulsbetrieb (Inching). */
F.pulse = () => ({
    states: [
        { id: 'pulse', common: C.sw('Impulsbetrieb (Inching)') },
        { id: 'pulseWidth', common: C.level('Impulsdauer', 'level', 0.5, 36000, 's') },
    ],
    update: p => {
        const o = {};
        if (has(p, 'pulse')) o.pulse = isOn(p.pulse);
        if (has(p, 'pulseWidth')) o.pulseWidth = Number(p.pulseWidth) / 1000;
        return Object.keys(o).length ? o : null;
    },
    write: (rid, v) => {
        if (rid === 'pulse') return { params: { pulse: onoff(v) } };
        if (rid === 'pulseWidth') return { params: { pulse: 'on', pulseWidth: Math.round(Number(v) / 0.5) * 500 } };
        return null;
    },
});

/** Energie-Historie aus der Cloud (POW, POWR2, S40, DualR3, SPM, POWR3). */
const DECODERS = {
    pow: value => {
        const out = [];
        for (let i = 0; i + 5 < value.length; i += 6) {
            out.push(Math.round((parseInt(value.substr(i, 2), 16) + parseInt(value[i + 3], 10) * 0.1 + parseInt(value[i + 5], 10) * 0.01) * 100) / 100);
        }
        return out;
    },
    dualr3: value => {
        const out = [];
        for (let i = 0; i + 3 < value.length; i += 4) {
            out.push(Math.round((parseInt(value.substr(i, 2), 16) + parseInt(value.substr(i + 2, 2), 10) * 0.01) * 100) / 100);
        }
        return out;
    },
    powr3: value => {
        const out = [];
        for (let i = 0; i + 2 < value.length; i += 3) {
            out.push(Math.round((parseInt(value[i], 16) + parseInt(value.substr(i + 1, 2), 10) * 0.01) * 100) / 100);
        }
        return out;
    },
};

F.cloudEnergy = (param, id, getParams, decoder, via = 'cloud') => ({
    states: [
        { id, common: sensorCommon('energy', id === 'energy' ? 'Energie heute (Cloud)' : `${id} heute (Cloud)`) },
        { id: `${id}_history`, common: { ...C.str(`${id} Verlauf (JSON, neuester Wert zuerst)`), role: 'json' } },
    ],
    update: p => {
        if (!has(p, param) || typeof p[param] !== 'string') return null;
        const h = DECODERS[decoder](p[param]);
        if (!h.length || h.some(x => !Number.isFinite(x))) return null;
        return { [id]: h[0], [`${id}_history`]: JSON.stringify(h) };
    },
    poll: { key: id, interval: 3600, params: getParams, via, timeoutLan: 5 },
});

// ----------------------------------------------------------------- Licht ----

/**
 * Gemeinsamer Licht-Kanal: light.on, light.brightness (%), optional colorTemp (K),
 * rgb (#rrggbb), effect.
 */
function lightStates({ ct, rgb, effects }) {
    const st = [
        { id: 'light.on', common: { ...C.sw('Licht an/aus'), role: 'switch.light' } },
        { id: 'light.brightness', common: C.level('Helligkeit', 'level.dimmer', 0, 100, '%') },
    ];
    if (ct) st.push({ id: 'light.colorTemp', common: C.level('Farbtemperatur', 'level.color.temperature', ct[0], ct[1], 'K') });
    if (rgb) st.push({ id: 'light.rgb', common: { ...C.str('Farbe (#RRGGBB)', true), role: 'level.color.rgb' } });
    if (effects) {
        const states = {};
        for (const e of effects) states[e] = e;
        st.push({ id: 'light.effect', common: C.str('Effekt / Modus', true, states) });
    }
    return st;
}

/** Befehl mit Helligkeit/Farbe: erst einschalten falls aus, LAN über /zeroconf/dimmable. */
function dimmable(params, dev, param = 'switch') {
    return {
        params,
        paramsLan: { cmd: 'dimmable', ...params },
        cmdLan: 'dimmable',
        preOn: !isOn(dev.params && dev.params[param]) ? { [param]: 'on' } : null,
    };
}

/** Dimmer KING-M4 (bright 10–100). */
F.lightDimmer = () => ({
    states: lightStates({}),
    update: p => {
        const o = {};
        if (has(p, 'switch')) o['light.on'] = isOn(p.switch);
        if (has(p, 'bright')) o['light.brightness'] = conv(p.bright, 10, 100, 1, 100);
        return o;
    },
    write: (id, v, dev) => {
        if (id === 'light.on') return { params: { switch: onoff(v) } };
        if (id === 'light.brightness') {
            if (!v) return { params: { switch: 'off' } };
            return dimmable({ bright: conv(v, 1, 100, 10, 100) }, dev);
        }
        return null;
    },
});

/** Sonoff D1 (brightness 0–100, mode 0, switch on). */
F.lightD1 = () => ({
    states: lightStates({}),
    update: p => {
        const o = {};
        if (has(p, 'switch')) o['light.on'] = isOn(p.switch);
        if (has(p, 'brightness')) o['light.brightness'] = Number(p.brightness);
        return o;
    },
    write: (id, v, dev) => {
        if (id === 'light.on') return { params: { switch: onoff(v) } };
        if (id === 'light.brightness') {
            if (!v) return { params: { switch: 'off' } };
            return dimmable({ brightness: conv(v, 1, 100, 0, 100), mode: 0, switch: 'on' }, dev);
        }
        return null;
    },
});

/** Mückenlampe UIID 57 (state + channel0 25–255). */
F.light57 = () => ({
    states: lightStates({}),
    update: p => {
        const o = {};
        if (has(p, 'state')) o['light.on'] = isOn(p.state);
        if (has(p, 'channel0')) o['light.brightness'] = conv(parseInt(p.channel0, 10), 25, 255, 1, 100);
        return o;
    },
    write: (id, v, dev) => {
        if (id === 'light.on') return { params: { state: onoff(v) } };
        if (id === 'light.brightness') {
            if (!v) return { params: { state: 'off' } };
            return dimmable({ channel0: String(conv(v, 1, 100, 25, 255)) }, dev, 'state');
        }
        return null;
    },
});

const L1_MODES = {
    Colorful: 1, 'Colorful Gradient': 2, 'Colorful Breath': 3, 'DIY Gradient': 4, 'DIY Pulse': 5, 'DIY Breath': 6,
    'DIY Strobe': 7, 'RGB Gradient': 8, 'RGB Pulse': 9, 'RGB Breath': 10, 'RGB Strobe': 11, Music: 12,
};

/** LED-Streifen L1/L2/L3 (bright 1–100, colorR/G/B, mode). */
F.lightL1 = () => ({
    states: lightStates({ rgb: true, effects: Object.keys(L1_MODES) }),
    update: p => {
        const o = {};
        if (has(p, 'switch')) o['light.on'] = isOn(p.switch);
        if (has(p, 'bright')) o['light.brightness'] = Number(p.bright);
        if (has(p, 'colorR') && has(p, 'colorG') && has(p, 'colorB')) o['light.rgb'] = hex(p.colorR, p.colorG, p.colorB);
        if (has(p, 'mode')) {
            const e = Object.keys(L1_MODES).find(k => L1_MODES[k] === p.mode);
            if (e) o['light.effect'] = e;
        }
        return o;
    },
    write: (id, v, dev) => {
        if (id === 'light.on') return { params: { switch: onoff(v) } };
        if (id === 'light.brightness') {
            if (!v) return { params: { switch: 'off' } };
            return dimmable({ mode: 1, bright: conv(v, 1, 100, 1, 100) }, dev);
        }
        if (id === 'light.rgb') {
            const c = parseHex(v);
            if (!c) return null;
            return dimmable({ mode: 1, colorR: c[0], colorG: c[1], colorB: c[2], light_type: 1 }, dev);
        }
        if (id === 'light.effect' && L1_MODES[v]) return dimmable({ mode: L1_MODES[v], switch: 'on' }, dev);
        return null;
    },
});

const B02_MODES = {
    nightLight: { br: 5, ct: 0 },
    read: { br: 50, ct: 0 },
    computer: { br: 20, ct: 255 },
    bright: { br: 100, ct: 255 },
};
const B05_MODES = {
    bright: { r: 255, g: 255, b: 255, br: 100 },
    goodNight: { r: 254, g: 254, b: 126, br: 25 },
    read: { r: 255, g: 255, b: 255, br: 60 },
    nightLight: { r: 255, g: 242, b: 226, br: 5 },
    party: { r: 254, g: 132, b: 0, br: 45, tf: 1, sp: 1 },
    leisure: { r: 0, g: 40, b: 254, br: 55, tf: 1, sp: 1 },
    soft: { r: 38, g: 254, b: 0, br: 20, tf: 1, sp: 1 },
    colorful: { r: 255, g: 0, b: 0, br: 100, tf: 1, sp: 1 },
};

/** Birnen B02 (CCT) und B05-B (RGB+CCT): ltype white/color mit br/ct bzw. r/g/b. */
F.lightB0x = (opts = {}) => {
    const color = !!opts.color;
    const minCt = opts.minCt !== undefined ? opts.minCt : 0;
    const maxCt = opts.maxCt !== undefined ? opts.maxCt : 255;
    const modes = color ? B05_MODES : B02_MODES;
    const kRange = dev => {
        if (color) return [2000, 6500];
        if (dev.productModel === 'B02-F-ST64') return [1800, 5000];
        if (dev.productModel === 'QMS-2C-CW') return [2700, 6500];
        return [2200, 6500];
    };
    const cur = dev => {
        const p = dev.params || {};
        const lt = p.ltype;
        return { ltype: lt, state: (lt && (p[lt] || modes[lt])) || {} };
    };
    return {
        states: dev => lightStates({ ct: kRange(dev), rgb: color, effects: Object.keys(modes) }),
        update: (p, dev) => {
            const o = {};
            if (has(p, 'switch')) o['light.on'] = isOn(p.switch);
            if (!has(p, 'ltype')) return o;
            const lt = p.ltype;
            if (modes[lt]) o['light.effect'] = lt;
            const st = p[lt] || (color ? modes[lt] : null) || {};
            if (has(st, 'br')) o['light.brightness'] = conv(st.br, 1, 100, 1, 100);
            if (has(st, 'ct')) {
                const [k1, k2] = kRange(dev);
                o['light.colorTemp'] = conv(st.ct, minCt, maxCt, k1, k2);
            }
            if (color && (has(st, 'r') || has(st, 'g') || has(st, 'b'))) o['light.rgb'] = hex(st.r, st.g, st.b);
            return o;
        },
        write: (id, v, dev) => {
            const [k1, k2] = kRange(dev);
            const c = cur(dev);
            const curBr = c.state.br || 100;
            const curCt = has(c.state, 'ct') ? c.state.ct : Math.round((minCt + maxCt) / 2);
            if (id === 'light.on') return { params: { switch: onoff(v) } };
            if (id === 'light.colorTemp') {
                return dimmable({ ltype: 'white', white: { br: curBr, ct: conv(v, k1, k2, minCt, maxCt) } }, dev);
            }
            if (id === 'light.rgb' && color) {
                const rgb = parseHex(v);
                if (!rgb) return null;
                return dimmable({ ltype: 'color', color: { br: curBr, r: rgb[0], g: rgb[1], b: rgb[2] } }, dev);
            }
            if (id === 'light.brightness') {
                if (!v) return { params: { switch: 'off' } };
                const br = conv(v, 1, 100, 1, 100);
                if (color && c.ltype && c.ltype !== 'white') {
                    const s = c.state;
                    return dimmable({ ltype: 'color', color: { br, r: s.r || 255, g: s.g || 255, b: s.b || 255 } }, dev);
                }
                return dimmable({ ltype: 'white', white: { br, ct: curCt } }, dev);
            }
            if (id === 'light.effect' && modes[v]) return dimmable({ ltype: v, [v]: modes[v] }, dev);
            return null;
        },
    };
};

/** Zigbee CCT-Lampe (brightness 0–100, colorTemp 0–100 → 2200–4000 K). */
F.lightZbCT = () => ({
    states: lightStates({ ct: [2200, 4000] }),
    update: p => {
        const o = {};
        if (has(p, 'switch')) o['light.on'] = isOn(p.switch);
        if (has(p, 'brightness')) o['light.brightness'] = Number(p.brightness);
        if (has(p, 'colorTemp')) o['light.colorTemp'] = conv(p.colorTemp, 0, 100, 2200, 4000);
        return o;
    },
    write: (id, v) => {
        if (id === 'light.on') return { params: { switch: onoff(v) } };
        if (id === 'light.brightness') return v ? { params: { switch: 'on', brightness: conv(v, 1, 100, 0, 100) } } : { params: { switch: 'off' } };
        if (id === 'light.colorTemp') return { params: { switch: 'on', colorTemp: conv(v, 2200, 4000, 0, 100) } };
        return null;
    },
});

/** Zigbee RGB+CCT-Lampe (colorMode cct/rgb, hue/saturation). */
F.lightZbColor = () => ({
    states: [
        ...lightStates({ ct: [2000, 6500] }),
        { id: 'light.hue', common: C.level('Farbton', 'level.color.hue', 0, 360, '°') },
        { id: 'light.saturation', common: C.level('Sättigung', 'level.color.saturation', 0, 100, '%') },
        { id: 'light.colorMode', common: C.str('Farbmodus', false, { cct: 'Weiß', rgb: 'Farbe' }) },
    ],
    update: p => {
        const o = {};
        if (has(p, 'switch')) o['light.on'] = isOn(p.switch);
        if (has(p, 'colorMode')) o['light.colorMode'] = p.colorMode;
        if (has(p, 'colorTemp')) o['light.colorTemp'] = conv(p.colorTemp, 0, 100, 2000, 6500);
        const mode = p && p.colorMode;
        if (mode && has(p, `${mode}Brightness`)) o['light.brightness'] = Number(p[`${mode}Brightness`]);
        if (has(p, 'hue')) o['light.hue'] = Number(p.hue);
        if (has(p, 'saturation')) o['light.saturation'] = Number(p.saturation);
        return o;
    },
    write: (id, v, dev) => {
        const p = dev.params || {};
        if (id === 'light.on') return { params: { switch: onoff(v) } };
        if (id === 'light.colorTemp') return { params: { switch: 'on', colorMode: 'cct', colorTemp: conv(v, 2000, 6500, 0, 100) } };
        if (id === 'light.hue') return { params: { switch: 'on', colorMode: 'rgb', hue: Number(v), saturation: p.saturation ?? 100 } };
        if (id === 'light.saturation') return { params: { switch: 'on', colorMode: 'rgb', hue: p.hue ?? 0, saturation: Number(v) } };
        if (id === 'light.brightness') {
            if (!v) return { params: { switch: 'off' } };
            const mode = p.colorMode === 'rgb' ? 'rgb' : 'cct';
            return { params: { switch: 'on', colorMode: mode, [`${mode}Brightness`]: conv(v, 1, 100, 1, 100) } };
        }
        return null;
    },
});

/** iFan-Licht (Ausgang 0 bzw. LAN "light"). */
F.fanLight = () => ({
    states: [{ id: 'light.on', common: { ...C.sw('Licht an/aus'), role: 'switch.light' } }],
    update: p => {
        if (p && Array.isArray(p.switches)) {
            const s = p.switches.find(i => i.outlet === 0);
            return s ? { 'light.on': isOn(s.switch) } : null;
        }
        return has(p, 'light') ? { 'light.on': isOn(p.light) } : null;
    },
    write: (id, v, dev) => {
        if (id !== 'light.on') return null;
        const params = { switches: [{ outlet: 0, switch: onoff(v) }] };
        return { params, paramsLan: dev.localtype === 'fan_light' ? { light: onoff(v) } : undefined };
    },
});

// ------------------------------------------------------------------ Lüfter --

/** iFan02/03/04: Stufe 0–3. */
F.fan = () => ({
    states: [
        { id: 'fan.on', common: C.sw('Lüfter an/aus') },
        { id: 'fan.speed', common: { ...C.level('Lüfterstufe', 'level.mode.fan', 0, 3), states: { 0: 'aus', 1: 'niedrig', 2: 'mittel', 3: 'hoch' } } },
    ],
    update: p => {
        let speed = null;
        if (p && Array.isArray(p.switches)) {
            const s = {};
            for (const i of p.switches) s[i.outlet] = i.switch;
            if (s[1] === undefined) return null;
            if (s[1] === 'off') speed = 0;
            else if (s[2] === 'off' && s[3] === 'off') speed = 1;
            else if (s[2] === 'on' && s[3] === 'off') speed = 2;
            else if (s[2] === 'off' && s[3] === 'on') speed = 3;
        } else if (has(p, 'fan')) {
            speed = p.fan === 'off' ? 0 : Number(p.speed) || 1;
        }
        return speed === null ? null : { 'fan.speed': speed, 'fan.on': speed > 0 };
    },
    write: (id, v, dev) => {
        let speed;
        if (id === 'fan.on') speed = v ? null : 0;
        else if (id === 'fan.speed') speed = Math.max(0, Math.min(3, Math.round(Number(v))));
        else return null;
        let sw;
        let lan;
        if (speed === null) {
            sw = { 1: 'on' };
            lan = { fan: 'on' };
        } else if (speed === 3) {
            sw = { 1: 'on', 2: 'off', 3: 'on' };
            lan = { fan: 'on', speed: 3 };
        } else if (speed === 2) {
            sw = { 1: 'on', 2: 'on', 3: 'off' };
            lan = { fan: 'on', speed: 2 };
        } else if (speed === 1) {
            sw = { 1: 'on', 2: 'off', 3: 'off' };
            lan = { fan: 'on', speed: 1 };
        } else {
            sw = { 1: 'off' };
            lan = { fan: 'off' };
        }
        const switches = Object.entries(sw).map(([k, s]) => ({ outlet: Number(k), switch: s }));
        return { params: { switches }, paramsLan: dev.localtype === 'fan_light' ? lan : undefined };
    },
});

/** Ventilator UIID 17. */
F.fan17 = () => ({
    states: [
        { id: 'fan.on', common: C.sw('Lüfter an/aus') },
        { id: 'fan.speed', common: C.str('Stufe', true, { slow: 'langsam', moderate: 'mittel', fast: 'schnell' }) },
        { id: 'fan.mode', common: C.str('Modus', true, { normal: 'normal', natural: 'natürlich', sleep: 'Schlaf' }) },
        { id: 'fan.oscillate', common: C.sw('Schwenken') },
    ],
    update: p => {
        const o = {};
        if (has(p, 'fan')) o['fan.on'] = isOn(p.fan);
        if (has(p, 'speed')) o['fan.speed'] = String(p.speed);
        if (has(p, 'mode')) o['fan.mode'] = String(p.mode);
        if (has(p, 'shake')) o['fan.oscillate'] = isOn(p.shake);
        return o;
    },
    write: (id, v) => {
        if (id === 'fan.on') return { params: { fan: onoff(v) } };
        if (id === 'fan.speed') return { params: { fan: 'on', speed: v } };
        if (id === 'fan.mode') return { params: { mode: v } };
        if (id === 'fan.oscillate') return { params: { shake: onoff(v) } };
        return null;
    },
});

// ------------------------------------------------------- Rollläden / Tore --

function coverStates(withPosition = true) {
    const st = [
        { id: 'cover.open', common: { ...C.btn('Öffnen'), role: 'button.open.blind' } },
        { id: 'cover.close', common: { ...C.btn('Schließen'), role: 'button.close.blind' } },
        { id: 'cover.stop', common: { ...C.btn('Stopp'), role: 'button.stop.blind' } },
        { id: 'cover.state', common: C.str('Zustand', false, { opening: 'öffnet', closing: 'schließt', moving: 'fährt', stopped: 'steht', open: 'offen', closed: 'geschlossen' }) },
    ];
    if (withPosition) st.unshift({ id: 'cover.position', common: C.level('Position (0 = zu, 100 = offen)', 'level.blind', 0, 100, '%') });
    return st;
}

/** Klassisch: switch on/off/pause, setclose (umgekehrt: 100 = zu). */
F.cover = (opts = {}) => ({
    states: coverStates(!opts.noPosition),
    update: p => {
        const o = {};
        const keys = Object.keys(p || {});
        if (keys.length === 1 && has(p, 'switch')) {
            o['cover.state'] = p.switch === 'on' ? 'opening' : p.switch === 'off' ? 'closing' : 'stopped';
        } else if (has(p, 'setclose') && !opts.noPosition) {
            if (keys.length === 1) {
                // Fahrbefehl auf Zielposition (z. B. aus der App) – Position folgt bei Ankunft
                o['cover.state'] = 'moving';
            } else {
                const pos = 100 - Number(p.setclose);
                o['cover.position'] = pos;
                o['cover.state'] = pos === 0 ? 'closed' : 'stopped';
            }
        }
        if (has(p, 'doorState')) o['cover.state'] = p.doorState === 0 ? 'closed' : 'open';
        return o;
    },
    write: id => {
        if (id === 'cover.open') return { params: { switch: 'on' }, queryCloud: false };
        if (id === 'cover.close') return { params: { switch: 'off' }, queryCloud: false };
        if (id === 'cover.stop') return { params: { switch: 'pause' }, queryCloud: false };
        return null;
    },
    writeValue: (id, v) => (id === 'cover.position' && !opts.noPosition ? { params: { setclose: 100 - Math.round(Number(v)) }, queryCloud: false } : null),
});

/** DualR3 im Motormodus (currLocation, motorTurn, location). */
F.coverDualR3 = () => ({
    states: coverStates(true),
    update: p => {
        const o = {};
        if (has(p, 'currLocation')) o['cover.position'] = Number(p.currLocation);
        if (has(p, 'motorTurn')) o['cover.state'] = ['stopped', 'opening', 'closing'][p.motorTurn] || 'stopped';
        return o;
    },
    write: id => {
        if (id === 'cover.open') return { params: { motorTurn: 1 } };
        if (id === 'cover.close') return { params: { motorTurn: 2 } };
        if (id === 'cover.stop') return { params: { motorTurn: 0 } };
        return null;
    },
    writeValue: (id, v) => (id === 'cover.position' ? { params: { location: Math.round(Number(v)) } } : null),
});

/** Zigbee-Vorhang (curPercent, curtainAction, openPercent). */
F.coverZigbee = () => ({
    states: coverStates(true),
    update: p => (has(p, 'curPercent') ? { 'cover.position': 100 - Number(p.curPercent) } : null),
    write: id => {
        if (id === 'cover.open') return { params: { curtainAction: 'open' } };
        if (id === 'cover.close') return { params: { curtainAction: 'close' } };
        if (id === 'cover.stop') return { params: { curtainAction: 'pause' } };
        return null;
    },
    writeValue: (id, v) => (id === 'cover.position' ? { params: { openPercent: 100 - Math.round(Number(v)) } } : null),
});

/** Garagentor/Tor (op 1 öffnen, 2 stopp, 3 schließen; per 0/100). */
F.coverOP = () => ({
    states: coverStates(false),
    update: p => {
        if (has(p, 'per')) return { 'cover.state': Number(p.per) === 0 ? 'closed' : 'open' };
        if (has(p, 'op')) return { 'cover.state': p.op === 1 ? 'opening' : p.op === 3 ? 'closing' : 'stopped' };
        return null;
    },
    write: id => {
        if (id === 'cover.open') return { params: { op: 1 } };
        if (id === 'cover.close') return { params: { op: 3 } };
        if (id === 'cover.stop') return { params: { op: 2 } };
        return null;
    },
});

/** TX Ultimate T5 Vorhangmodus (electromotor, percentageControl). */
F.coverT5 = () => ({
    states: coverStates(true),
    update: p => {
        const o = {};
        if (has(p, 'percentageControl') && p.calibState === true) o['cover.position'] = 100 - Number(p.percentageControl);
        if (has(p, 'electromotor')) o['cover.state'] = { 0: 'opening', 1: 'stopped', 2: 'closing' }[p.electromotor] || 'stopped';
        return o;
    },
    write: id => {
        if (id === 'cover.open') return { params: { electromotor: 0 } };
        if (id === 'cover.close') return { params: { electromotor: 2 } };
        if (id === 'cover.stop') return { params: { electromotor: 1 } };
        return null;
    },
    writeValue: (id, v) => (id === 'cover.position' ? { params: { percentageControl: 100 - Math.round(Number(v)) } } : null),
});

// --------------------------------------------------------------- Ereignisse --

const BUTTON_STATES = ['single', 'double', 'hold', 'triple'];
const DEDUPE_MS = 1500;

/** Tastenereignis (key + outlet), mit Schutz gegen Wiederholung nach Reconnect. */
F.key = (opts = {}) => {
    let lastTrig = null;
    let lastSig = null;
    let lastSigAt = 0;
    return {
        states: [{ id: 'action', common: { ...C.str('Letzte Tastenaktion'), role: 'text' } }],
        event: true,
        update: p => {
            let src = p;
            if (opts.localKey) {
                // Cloud sendet nur { localKeyPass }, LAN den ganzen Zustand samt localKeyPass: beides gilt als Tastendruck.
                if (!p || !has(p, 'localKeyPass') || !p.localKeyPass || typeof p.localKeyPass !== 'object') return null;
                src = p.localKeyPass;
                // LAN und Cloud melden denselben Druck kurz nacheinander: Wiederholung innerhalb des Fensters ignorieren
                const sig = `${src.outlet}:${src.key}`;
                const t = (opts.now || Date.now)();
                if (sig === lastSig && t - lastSigAt < DEDUPE_MS) return null;
                lastSig = sig;
                lastSigAt = t;
            } else if (opts.trig) {
                const t = p && (p.trigTime || p.actionTime);
                if (!t || t === lastTrig) return null;
                if (lastTrig === null) {
                    lastTrig = t; // erster Wert nach Start = alter Stand
                    return null;
                }
                lastTrig = t;
            } else if (opts.single && (!p || Object.keys(p).length !== 1)) {
                return null;
            }
            if (!src || !has(src, 'key')) return null;
            const k = BUTTON_STATES[src.key] || String(src.key);
            const val = src.outlet !== undefined && src.outlet !== null ? `button_${src.outlet + 1}_${k}` : k;
            return { action: val };
        },
    };
};

// -------------------------------------------------------------- Bausteine ---

const LED = () => F.toggle('sledOnline', 'led', 'Status-LED');
const RSSI = () => F.sensor('rssi', { id: 'rssi', name: 'WLAN-Signal' });
const ZRSSI = () => F.sensor('subDevRssi', { id: 'rssi', name: 'Zigbee-Signal' });
const BATT = () => F.sensor('battery', { id: 'battery', name: 'Batterie' });
const CH = n => Array.from({ length: n }, (_, i) => F.channel(i));
const SU = n => Array.from({ length: n }, (_, i) => F.startupCh(i));

const SPEC_SWITCH = () => [F.switch(), LED(), RSSI(), F.pulse()];
const SPEC_CH = n => () => [...CH(n), LED(), RSSI()];
const ENERGY_DMWY = keys => keys.map(k => F.sensor(`${k}Kwh`, { id: `energy_${k}`, mult: 0.01, round: 2, name: `Energie ${k}` }));
const PWR100 = () => [S100('power', 'power'), S100('current', 'current'), S100('voltage', 'voltage')];
const PER_CH = n =>
    Array.from({ length: n }, (_, i) => [
        S100(`current_0${i}`, `current_${i + 1}`),
        S100(`voltage_0${i}`, `voltage_${i + 1}`),
        S100(`actPow_0${i}`, `power_${i + 1}`),
        F.cloudEnergy(`kwhHistories_0${i}`, `energy_${i + 1}`, { [`getKwh_0${i}`]: 2 }, 'dualr3'),
    ]).flat();
const TX_ULTIMATE = () => [F.button('soundAction', 1, 'sound_alarm', 'Ton: Alarm'), F.button('soundAction', 2, 'sound_bell', 'Ton: Klingel')];
const TH16 = () => [F.switch({ th: true }), F.thTemp(), F.thHum(), LED(), RSSI()];
const ZTH100 = () => [S100('temperature', 'temperature'), S100('humidity', 'humidity'), BATT(), ZRSSI()];
const POW_ENERGY = () => F.cloudEnergy('hundredDaysKwhData', 'energy', { hundredDaysKwh: 'get' }, 'pow');
const NSP = () => [F.thTemp(), F.bool('openLED', 'screen', 'Bildschirm'), F.button('reboot', true, 'reboot', 'Neustart')];
const TRVZB = () => [
    F.sensor('temperature', { id: 'temperature', mult: 0.1, round: 1, name: 'Temperatur' }),
    F.sensor('curTargetTemp', { id: 'target_temperature', mult: 0.1, round: 1, name: 'Aktuelle Solltemperatur' }),
    F.sensor('manTargetTemp', { id: 'manual_target_temperature', mult: 0.1, round: 1, name: 'Manuelle Solltemperatur' }),
    F.sensor('openPercent', { id: 'valve_opening', name: 'Ventilöffnung' }),
    F.text('workMode', 'work_mode', 'Betriebsart'),
    F.text('workState', 'work_state', 'Betriebszustand'),
    F.bool('childLock', 'child_lock', 'Kindersicherung'),
    F.bool('windowSwitch', 'window_switch', 'Fenstererkennung'),
    BATT(),
    ZRSSI(),
];

const DEVICES = {
    1: SPEC_SWITCH,
    2: SPEC_CH(2),
    3: SPEC_CH(3),
    4: SPEC_CH(4),
    5: () => [F.switch(), LED(), RSSI(), F.sensor('power', { id: 'power' }), POW_ENERGY()],
    6: SPEC_SWITCH,
    7: SPEC_CH(2),
    8: SPEC_CH(3),
    9: SPEC_CH(4),
    11: () => [F.cover(), LED(), RSSI()],
    14: SPEC_SWITCH,
    15: TH16,
    17: () => [F.fan17(), LED(), RSSI()],
    18: () => ['temperature', 'humidity', 'dusty', 'light', 'noise'].map(p => F.sensor(p)),
    22: () => [F.toggle('state', 'switch', 'Licht an/aus'), RSSI()],
    25: () => [F.toggle('switch', 'switch', 'Diffusor an/aus'), F.toggle('lightswitch', 'light_on', 'Licht an/aus'), F.binary('water', 'water', 'Wasser', v => v === 1), RSSI()],
    28: () => [LED(), RSSI(), F.text('rfList', 'rf_list', 'RF-Codes')],
    29: SPEC_CH(2),
    30: SPEC_CH(3),
    31: SPEC_CH(4),
    32: () => [F.switch(), LED(), RSSI(), F.pulse(), F.sensor('current', { id: 'current' }), F.sensor('power', { id: 'power' }), F.sensor('voltage', { id: 'voltage' }), POW_ENERGY(), F.startup()],
    33: () => [F.lightL1(), RSSI()],
    34: () => [F.fan(), F.fanLight(), LED(), RSSI()],
    36: () => [F.lightDimmer(), RSSI()],
    44: () => [F.lightD1(), RSSI()],
    57: () => [F.light57(), RSSI()],
    59: () => [F.lightL1(), RSSI()],
    66: () => [RSSI(), LED()],
    67: () => [F.coverOP()],
    77: SPEC_CH(1),
    78: SPEC_CH(1),
    81: SPEC_CH(1),
    82: SPEC_CH(2),
    83: SPEC_CH(3),
    84: SPEC_CH(4),
    91: () => [F.coverOP()],
    102: () => [F.binary('switch', 'open', 'Tür/Fenster offen', isOn, 'sensor.door'), F.sensor('battery', { id: 'battery_voltage', name: 'Batteriespannung', common: { unit: 'V', role: 'value.voltage' } }), RSSI()],
    103: () => [F.lightB0x(), RSSI()],
    104: () => [F.lightB0x({ color: true }), RSSI()],
    107: SPEC_CH(1),
    126: dev =>
        dev.params && dev.params.workMode === 2
            ? [F.coverDualR3(), ...SU(2), RSSI()]
            : [...CH(2), ...SU(2), RSSI(), ...PER_CH(2)],
    127: () => [F.toggle('switch', 'switch', 'Thermostat an/aus'), F.sensor('temperature', { id: 'temperature' }), F.sensor('targetTemp', { id: 'target_temperature' })],
    128: () => [LED()],
    130: () => [...CH(4), ...SU(4), ...PER_CH(4)],
    133: () => [...CH(2), F.sensor('tempCorrection', { id: 'temperature_correction' }), F.sensor('temperature', { id: 'temperature_outdoor' })],
    135: () => [F.lightB0x(), RSSI()],
    136: () => [F.lightB0x({ color: true, minCt: 0, maxCt: 100 }), RSSI()],
    137: () => [F.lightL1(), RSSI()],
    138: () => [...CH(1), ...SU(1), LED(), RSSI(), F.int('relaySeparation', 'detach', 'Relais entkoppelt'), F.key({ single: true })],
    154: () => [F.binary('switch', 'open', 'Tür/Fenster offen', isOn, 'sensor.door'), BATT(), RSSI()],
    160: () => [...CH(1), LED(), RSSI(), F.detach(1), F.key({ localKey: true })],
    161: () => [...CH(2), LED(), RSSI(), F.detach(2), F.key({ localKey: true })],
    162: () => [...CH(3), LED(), RSSI(), F.detach(3), F.key({ localKey: true })],
    165: dev => (dev.params && dev.params.workMode === 2 ? [F.coverDualR3(), ...SU(2), RSSI()] : [...CH(2), ...SU(2), RSSI()]),
    168: () => [RSSI()],
    173: () => [F.lightL1(), RSSI()],
    174: () => [F.key({ trig: true })],
    177: () => [F.key({ trig: true })],
    181: () => [F.switch({ th: true }), F.thTemp(), F.thHum(), F.int('autoControlEnabled', 'auto_mode', 'Automatik'), LED(), RSSI()],
    182: () => [...CH(1), LED(), RSSI(), F.sensor('current', { id: 'current' }), F.sensor('power', { id: 'power' }), F.sensor('voltage', { id: 'voltage' }), POW_ENERGY()],
    190: dev => {
        const list = [
            F.channel(0, { powr3: true }),
            ...SU(1),
            LED(),
            RSSI(),
            ...PWR100(),
            ...ENERGY_DMWY(['day', 'month']),
            F.cloudEnergy('hoursKwhData', 'energy_hours', { getHoursKwh: { start: 0, end: 24 * 30 - 1 } }, 'powr3', 'any'),
        ];
        if (dev.params && 'supplyPower' in dev.params) {
            list.push(
                S100('supplyCurrent', 'current_supply'),
                S100('supplyPower', 'power_supply'),
                F.sensor('dayPowerSupply', { id: 'energy_day_supply', mult: 0.01, round: 2 }),
                F.sensor('monthPowerSupply', { id: 'energy_month_supply', mult: 0.01, round: 2 }),
            );
        }
        return list;
    },
    195: NSP,
    209: () => [...CH(1), ...SU(1), ...TX_ULTIMATE()],
    210: () => [...CH(2), ...SU(2), ...TX_ULTIMATE()],
    211: () => [...CH(3), ...SU(3), F.coverT5(), ...TX_ULTIMATE()],
    212: () => [...CH(4), ...SU(4), ...TX_ULTIMATE()],
    216: () => [F.cover({ noPosition: true }), RSSI()],
    225: () => [
        F.bool('switch', 'switch', 'Schalter'),
        F.button('restart', true, 'restart', 'Neustart'),
        F.button('forceShutdown', true, 'shutdown', 'Zwangsabschaltung'),
        F.bool('childLock', 'child_lock', 'Kindersicherung'),
        LED(),
        RSSI(),
        F.startup(),
    ],
    226: () => [
        F.bool('switch', 'switch', 'Schalter'),
        LED(),
        RSSI(),
        F.sensor('phase_0_c', { id: 'current' }),
        F.sensor('phase_0_p', { id: 'power' }),
        F.sensor('phase_0_v', { id: 'voltage' }),
        F.sensor('totalPower', { id: 'energy_total' }),
    ],
    228: NSP,
    242: () => [BATT(), ZRSSI()],
    243: () => [LED()],
    258: () => [F.cover(), LED(), RSSI()],
    262: () => [...CH(4), LED(), RSSI(), ...PWR100()],
    266: () => [RSSI(), F.sensor('co2'), F.sensor('pm10'), F.sensor('pm2_5', { id: 'pm25' }), F.sensor('temperature'), F.sensor('humidity')],
    268: () => [...CH(1), LED(), RSSI()],
    275: () => [...CH(2), ...SU(2), LED(), RSSI(), F.detach(2), F.key({ localKey: true })],
    276: () => [...CH(1), ...PWR100(), ...ENERGY_DMWY(['day', 'week', 'month', 'year']), LED(), RSSI()],
    277: () => [F.lightDimmer(), ...PWR100(), LED(), RSSI()],
    278: SPEC_CH(2),
    283: () => [...CH(1), ...PWR100(), ...ENERGY_DMWY(['day', 'month']), LED(), RSSI()],
    1000: () => [F.key({ trig: true }), BATT()],
    1256: () => [F.switch()],
    1257: () => [F.lightD1()],
    1258: () => [F.lightZbCT()],
    1514: () => [F.coverZigbee(), F.sensor('battery', { id: 'battery', mult: 2 })],
    1770: () => [S100('temperature', 'temperature'), S100('humidity', 'humidity'), BATT()],
    1771: () => [S100('temperature', 'temperature'), S100('humidity', 'humidity'), BATT()],
    2026: () => [F.binary('motion', 'motion', 'Bewegung', v => v === 1, 'sensor.motion'), BATT()],
    3026: () => [F.binary('lock', 'open', 'Tür/Fenster offen', v => v === 1, 'sensor.door'), BATT()],
    3258: () => [F.lightZbColor()],
    4026: () => [F.binary('water', 'water', 'Wasser erkannt', v => v === 1, 'sensor.alarm.flood'), BATT()],
    4256: () => [0, 1, 2, 3].map(i => F.channel(i, { zigbee: true })),
    7000: () => [F.key({ trig: true }), BATT()],
    7002: () => [F.binary('motion', 'motion', 'Bewegung', v => v === 1, 'sensor.motion'), F.binary('brState', 'bright', 'Hell', v => v === 'brighter'), BATT(), ZRSSI()],
    7003: () => [F.binary('lock', 'open', 'Tür/Fenster offen', v => v === 1, 'sensor.door'), BATT(), ZRSSI()],
    7004: () => [F.switch(), ZRSSI()],
    7006: () => [F.coverZigbee(), BATT()],
    7009: () => [F.lightZbColor()],
    7010: () => [F.switch(), ZRSSI()],
    7014: ZTH100,
    7016: () => [F.binary('human', 'occupancy', 'Anwesenheit', v => v === 1, 'sensor.motion'), F.binary('brState', 'bright', 'Hell', v => v === 'brighter'), ZRSSI()],
    7017: TRVZB,
    7019: () => [F.binary('water', 'water', 'Wasser erkannt', v => v === 1, 'sensor.alarm.flood'), BATT()],
    7027: () => [F.bool('switch', 'switch', 'Ventil'), BATT(), ZRSSI()],
    7029: () => [...CH(2), F.key({ localKey: true })],
    7032: () => [...CH(1), ...PWR100(), ...ENERGY_DMWY(['day', 'month'])],
    7033: () => [F.sensor('temperature'), F.sensor('humidity'), BATT(), ZRSSI()],
    7034: () => [F.cover(), LED(), RSSI()],
    7038: () => [BATT(), ZRSSI(), F.sensor('remoteTemperature', { id: 'remote_temperature', mult: 0.01, round: 2 })],
    7039: () => [F.key({ trig: true }), BATT(), ZRSSI()],
    7047: () => [F.bool('switch_00', 'switch', 'Ventil'), BATT(), ZRSSI()],
    7048: () => [
        F.bool('switch_00', 'valve_a', 'Ventil A', { controlMode: 'manual' }),
        F.bool('switch_01', 'valve_b', 'Ventil B', { controlMode: 'manual' }),
        F.sensor('todayWaterUsage', { id: 'water_today', common: { unit: 'L' } }),
        BATT(),
        ZRSSI(),
    ],
    7049: TRVZB,
    7051: () => [F.binary('human', 'occupancy', 'Anwesenheit', v => v === 1, 'sensor.motion'), F.sensor('illumination', { id: 'illuminance' })],
    7052: ZTH100,
    7054: () => [...CH(1), ...PWR100(), ...ENERGY_DMWY(['day', 'month']), ZRSSI()],
    7055: () => [F.binary('human', 'occupancy', 'Anwesenheit', v => v === 1, 'sensor.motion'), F.sensor('illumination', { id: 'illuminance' }), BATT(), ZRSSI()],
    7056: () => [F.text('alarmType', 'alarm_status', 'Alarmstatus'), F.binary('powerExternalState', 'external_power', 'Netzbetrieb', isOn), BATT(), ZRSSI()],
    7057: () => [S100('temperature', 'temperature'), S100('humidity', 'humidity'), S100('pressure', 'pressure'), BATT(), ZRSSI()],
};

/** DIY-Typen (mDNS "type") → UIID. */
const DIY = {
    plug: [1, null, 'Single Channel DIY'],
    strip: [4, null, 'Multi Channel DIY'],
    diy_plug: [1, 'SONOFF', 'MINI DIY'],
    enhanced_plug: [5, 'SONOFF', 'POW DIY'],
    th_plug: [15, 'SONOFF', 'TH DIY'],
    rf: [28, 'SONOFF', 'RFBridge DIY'],
    fan_light: [34, 'SONOFF', 'iFan DIY'],
    light: [44, 'SONOFF', 'D1 DIY'],
    diylight: [44, 'SONOFF', 'D1 DIY'],
    diy_light: [136, 'SONOFF', 'B0x-BL DIY'],
    switch_radar: [77, 'SONOFF', 'Micro DIY'],
    multifun_switch: [126, 'SONOFF', 'DualR3 DIY'],
};

function setupDiy(dev) {
    const d = DIY[dev.localtype];
    if (d) {
        let [uiid, brand, model] = d;
        if (dev.localtype === 'diy_plug' && dev.params && 'switches' in dev.params) {
            uiid = 77;
            model = 'MINI R3 DIY';
        }
        dev.name = model;
        dev.brandName = brand;
        dev.extra = { uiid };
        dev.productModel = model;
    } else {
        dev.name = 'Unknown DIY';
        dev.extra = { uiid: 0 };
        dev.productModel = dev.localtype;
    }
    return dev;
}

/**
 * Feature-Liste für ein Gerät.
 * @param {object} dev Gerät (extra.uiid, params, …)
 * @param {object} [override] { uiid?: number, asLight?: boolean }
 */
function getSpec(dev, override = {}) {
    const uiid = override.uiid || (dev.extra && dev.extra.uiid) || 0;
    const p = dev.params || {};
    let list;
    if (DEVICES[uiid]) list = DEVICES[uiid](dev);
    else if ('switch' in p) list = SPEC_SWITCH();
    else if ('switches' in p) list = SPEC_CH(Array.isArray(p.switches) ? Math.min(p.switches.length, 4) || 4 : 4)();
    else list = [];
    // RSSI generisch ergänzen, falls vorhanden aber nicht spezifiziert
    const hasRssi = list.some(f => {
        const st = typeof f.states === 'function' ? f.states(dev) : f.states;
        return (st || []).some(s => s.id === 'rssi');
    });
    if ('rssi' in p && !hasRssi) list.push(RSSI());
    return list;
}

function isKnownUiid(uiid) {
    return !!DEVICES[uiid];
}

module.exports = { getSpec, setupDiy, isKnownUiid, DECODERS, F };
