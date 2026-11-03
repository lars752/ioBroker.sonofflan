'use strict';
/**
 * eWeLink Cloud (REST v2 + WebSocket). Portiert aus AlexxIT/SonoffLAN (MIT),
 * core/ewelink/cloud.py.
 * https://coolkit-technologies.github.io/eWeLink-API/#/en/PlatformOverview
 */
const EventEmitter = require('node:events');
const WebSocket = require('ws');
const { REGIONS } = require('./regions');
const { DEFAULT_APP_ID, sign } = require('./crypto');
const { nextSequence, sleep } = require('./util');

const API = {
    cn: 'https://cn-apia.coolkit.cn',
    as: 'https://as-apia.coolkit.cc',
    us: 'https://us-apia.coolkit.cc',
    eu: 'https://eu-apia.coolkit.cc',
};
const WS_DISPATCH = {
    cn: 'https://cn-dispa.coolkit.cn/dispatch/app',
    as: 'https://as-dispa.coolkit.cc/dispatch/app',
    us: 'https://us-dispa.coolkit.cc/dispatch/app',
    eu: 'https://eu-dispa.coolkit.cc/dispatch/app',
};
const DATA_ERROR = { 0: 'online', 503: 'offline', 504: 'timeout' };

class AuthError extends Error {}

class CloudRegistry extends EventEmitter {
    /**
     * @param {{log: any, appId?: string, appSecret?: string}} opts
     */
    constructor(opts) {
        super();
        this.log = opts.log;
        this.appId = opts.appId || DEFAULT_APP_ID;
        this.appSecret = opts.appSecret || undefined;
        this.auth = null;
        this.region = 'eu';
        this.online = null; // null = gestoppt, false = getrennt, true = verbunden
        this.ws = null;
        this.waiters = new Map();
        this.lastTs = 0;
        this.lastUiActive = 0;
        this.stopped = true;
        this.pingTimer = null;
        this.reconnectTimer = null;
        this.fails = 0;
        this.credentials = null;
    }

    get host() {
        return API[this.region] || API.eu;
    }

    get headers() {
        return { Authorization: `Bearer ${this.auth.at}`, 'X-CK-Appid': this.appId };
    }

    async _fetchJson(url, init = {}, timeoutMs = 10000) {
        const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        const txt = await r.text();
        try {
            return JSON.parse(txt);
        } catch {
            throw new Error(`HTTP ${r.status}: ${txt.slice(0, 200)}`);
        }
    }

    /** Login mit E-Mail/Telefon + Passwort. */
    async login(username, password, countryCode = '+49') {
        if (username === 'token') {
            const [region, token] = String(password).split(':');
            this.region = region;
            return this.loginToken(token);
        }
        const entry = REGIONS.find(r => r[0] === countryCode);
        this.region = entry ? entry[2] : 'eu';

        const payload = { password, countryCode };
        if (username.includes('@')) payload.email = username;
        else if (username.startsWith('+')) payload.phoneNumber = username;
        else payload.phoneNumber = `+${username}`;

        const data = JSON.stringify(payload);
        const headers = {
            Authorization: `Sign ${sign(Buffer.from(data, 'utf8'), this.appSecret)}`,
            'Content-Type': 'application/json',
            'X-CK-Appid': this.appId,
        };
        let resp = await this._fetchJson(`${this.host}/v2/user/login`, { method: 'POST', body: data, headers });
        if (resp.error === 10004 && resp.data && resp.data.region) {
            // falsche Standard-Region
            this.region = resp.data.region;
            resp = await this._fetchJson(`${this.host}/v2/user/login`, { method: 'POST', body: data, headers });
        }
        if (resp.error !== 0) throw new AuthError(`${resp.msg || 'Login fehlgeschlagen'} (Code ${resp.error})`);
        this.auth = resp.data;
        return true;
    }

    async loginToken(token) {
        const resp = await this._fetchJson(`${this.host}/v2/user/profile`, {
            headers: { Authorization: `Bearer ${token}`, 'X-CK-Appid': this.appId },
        });
        if (resp.error !== 0) throw new AuthError(resp.msg || 'Token ungültig');
        this.auth = resp.data;
        this.auth.at = token;
        return true;
    }

    async getHomes() {
        const resp = await this._fetchJson(`${this.host}/v2/family`, { headers: this.headers });
        if (resp.error !== 0) throw new Error(resp.msg);
        const out = {};
        for (const h of resp.data.familyList || []) out[h.id] = h.name;
        return out;
    }

    /** Alle Geräte (ohne Gruppen) aller bzw. der gewählten Homes. */
    async getDevices(homes) {
        const devices = [];
        const list = homes && homes.length ? homes : [null];
        for (const home of list) {
            const qs = new URLSearchParams({ num: '0' });
            if (home) qs.set('familyid', home);
            const resp = await this._fetchJson(`${this.host}/v2/device/thing?${qs}`, { headers: this.headers });
            if (resp.error !== 0) throw new Error(resp.msg);
            for (const i of resp.data.thingList || []) {
                if (i.itemData && i.itemData.deviceid && !devices.some(d => d.deviceid === i.itemData.deviceid)) {
                    devices.push(i.itemData);
                }
            }
        }
        return devices;
    }

    /**
     * Befehl über WebSocket senden. Ohne params: Statusabfrage.
     * @returns {Promise<string>} 'online' | 'timeout' | 'offline' | 'E#…'
     */
    async send(device, params, sequence, timeout = 5) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.auth) return 'offline';

        if (params && 'uiActive' in params) {
            let d;
            while ((d = this.lastUiActive + 1000 - Date.now()) > 0) await sleep(d);
            this.lastUiActive = Date.now();
        }
        // Cloud vor zu vielen Nachrichten schützen
        let delay;
        while ((delay = this.lastTs + 100 - Date.now()) > 0) await sleep(delay);
        this.lastTs = Date.now();

        sequence = sequence || nextSequence();
        const payload = {
            action: params ? 'update' : 'query',
            apikey: device.apikey,
            selfApikey: this.auth.user.apikey,
            deviceid: device.deviceid,
            params: params || [],
            userAgent: 'app',
            sequence,
        };
        this.log.debug(`${device.deviceid} => Cloud | ${JSON.stringify(params || {})} | ${sequence}`);
        try {
            const p = timeout ? this._waitResponse(sequence, timeout) : null;
            this.ws.send(JSON.stringify(payload));
            return p ? await p : 'online';
        } catch (e) {
            this.log.warn(`${device.deviceid} => Cloud Fehler: ${e.message}`);
            return 'E#???';
        }
    }

    /** Direkte HTTP-Statusänderung (Fallback ohne WebSocket). */
    async setDeviceHttp(device, params) {
        const resp = await this._fetchJson(`${this.host}/v2/device/thing/status`, {
            method: 'POST',
            headers: { ...this.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 1, id: device.deviceid, params }),
        });
        return resp.error === 0 ? 'online' : `E#${resp.error}`;
    }

    _waitResponse(sequence, timeout) {
        return new Promise(resolve => {
            const t = setTimeout(() => {
                this.waiters.delete(sequence);
                resolve('timeout');
            }, timeout * 1000);
            this.waiters.set(sequence, err => {
                clearTimeout(t);
                this.waiters.delete(sequence);
                resolve(err in DATA_ERROR ? DATA_ERROR[err] : err === undefined || err === null ? 'online' : `E#${err}`);
            });
        });
    }

    _setOnline(value) {
        if (this.online === value) return;
        this.online = value;
        this.emit('connected', value);
    }

    /** Startet Login + WebSocket-Schleife mit exponentiellem Backoff. */
    start(credentials) {
        this.credentials = credentials;
        this.stopped = false;
        this.fails = 0;
        this._loop();
    }

    async _loop() {
        if (this.stopped) return;
        if (this.fails) {
            this._setOnline(false);
            // 15s 30s 1m 2m … max ~64 min
            const delay = 15 * 2 ** Math.min(this.fails - 1, 8);
            this.log.info(`Cloud: neuer Verbindungsversuch in ${delay} s`);
            this.reconnectTimer = setTimeout(() => this._connectCycle(), delay * 1000);
        } else {
            this._connectCycle();
        }
    }

    async _connectCycle() {
        if (this.stopped) return;
        try {
            if (!this.auth) {
                const c = this.credentials;
                await this.login(c.username, c.password, c.countryCode);
            }
            await this._connectWs();
            this.fails = 0;
            this._setOnline(true);
        } catch (e) {
            this.fails++;
            if (e instanceof AuthError) {
                this.log.error(`Cloud-Login fehlgeschlagen: ${e.message}`);
                this.auth = null;
            } else {
                this.log.warn(`Cloud-Verbindung fehlgeschlagen: ${e.message}`);
            }
            this._loop();
        }
    }

    _connectWs() {
        return new Promise((resolve, reject) => {
            this._fetchJson(WS_DISPATCH[this.region] || WS_DISPATCH.eu, { headers: this.headers })
                .then(resp => {
                    if (!resp.domain) throw new Error(`Dispatch ohne Domain: ${JSON.stringify(resp)}`);
                    const ws = new WebSocket(`wss://${resp.domain}:${resp.port}/api/ws`, { handshakeTimeout: 10000 });
                    let handshaked = false;
                    ws.on('open', () => {
                        const ts = Date.now() / 1000;
                        ws.send(
                            JSON.stringify({
                                action: 'userOnline',
                                at: this.auth.at,
                                apikey: this.auth.user.apikey,
                                appid: this.appId,
                                nonce: String(Math.floor(ts / 100)),
                                ts: Math.floor(ts),
                                userAgent: 'app',
                                sequence: String(Math.floor(ts * 1000)),
                                version: 8,
                            }),
                        );
                    });
                    ws.on('message', raw => {
                        const txt = raw.toString();
                        if (txt === 'pong') return;
                        let msg;
                        try {
                            msg = JSON.parse(txt);
                        } catch {
                            return;
                        }
                        if (!handshaked) {
                            handshaked = true;
                            const err = msg.error || 0;
                            if (err !== 0) {
                                ws.terminate();
                                if (err === 406) {
                                    reject(
                                        new Error(
                                            'Authentifizierung abgelehnt (406) – das Konto ist vermutlich an anderer Stelle mit derselben App-ID angemeldet. Für den Adapter ein eigenes eWeLink-Konto mit geteilten Geräten verwenden.',
                                        ),
                                    );
                                    this.auth = null;
                                } else {
                                    // z. B. abgelaufener Token → beim nächsten Versuch neu anmelden
                                    this.auth = null;
                                    reject(new Error(`Handshake-Fehler: ${JSON.stringify(msg)}`));
                                }
                                return;
                            }
                            this.ws = ws;
                            const hb = msg.config && msg.config.hb ? Number(msg.config.hbInterval) || 90 : 90;
                            clearInterval(this.pingTimer);
                            this.pingTimer = setInterval(() => {
                                if (ws.readyState === WebSocket.OPEN) ws.send('ping');
                            }, hb * 1000);
                            resolve();
                            return;
                        }
                        this._processMsg(msg);
                    });
                    ws.on('error', e => {
                        if (!handshaked) reject(e);
                        else this.log.debug(`Cloud WS Fehler: ${e.message}`);
                    });
                    ws.on('close', () => {
                        clearInterval(this.pingTimer);
                        if (this.ws === ws) this.ws = null;
                        if (!handshaked) {
                            reject(new Error('WebSocket vor Handshake geschlossen'));
                            return;
                        }
                        if (!this.stopped) {
                            this.log.info('Cloud-WebSocket getrennt – verbinde neu');
                            this.fails = 1;
                            this._loop();
                        }
                    });
                })
                .catch(reject);
        });
    }

    _processMsg(data) {
        if (!('action' in data)) {
            // Antwort auf eigenen Befehl
            if (data.sequence && this.waiters.has(data.sequence)) this.waiters.get(data.sequence)(data.error);
            if (data.params) this.emit('update', data);
            else if (data.config) {
                data.params = data.config;
                delete data.config;
                this.emit('update', data);
            } else if (data.error) this.log.warn(`Cloud-Fehler: ${JSON.stringify(data)}`);
            return;
        }
        if (data.action === 'update' || data.action === 'sysmsg') {
            if (data.deviceid && data.params) this.emit('update', data);
        }
        // reportSubDevice, notify, subDevice: ohne Nutzen – ignorieren
    }

    async stop() {
        this.stopped = true;
        clearTimeout(this.reconnectTimer);
        clearInterval(this.pingTimer);
        if (this.ws) {
            try {
                this.ws.terminate();
            } catch {
                /* egal */
            }
        }
        this.ws = null;
        for (const w of this.waiters.values()) w(504);
        this._setOnline(null);
    }
}

module.exports = { CloudRegistry, AuthError };
