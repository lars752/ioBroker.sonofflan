'use strict';
/**
 * ioBroker.sonofflan – Sonoff/eWeLink-Geräte lokal (LAN) und über die Cloud steuern.
 * Basierend auf AlexxIT/SonoffLAN (MIT) – https://github.com/AlexxIT/SonoffLAN
 */
const fs = require('node:fs');
const path = require('node:path');
const utils = require('@iobroker/adapter-core');
const { CloudRegistry } = require('./lib/cloud');
const { LocalRegistry } = require('./lib/local');
const { decryptMsg } = require('./lib/crypto');
const { getSpec, setupDiy, isKnownUiid } = require('./lib/devices');
const { nextSequence, sleep, safeId } = require('./lib/util');

const LOOP_INTERVAL = 5000;
// Geräte, deren Sensorwerte lokal über sledOnline angestoßen werden (POW, TH, …)
const SLED_REFRESH_UIIDS = [15, 32, 181, 182, 190, 262, 277, 283];
// Diese Felder landen im Gerätecache (Datei im Instanz-Datenverzeichnis, nicht in Objekten)
const CACHE_KEYS = ['deviceid', 'apikey', 'devicekey', 'name', 'brandName', 'productModel', 'extra', 'tags', 'parentid', 'localtype', 'host'];

class Sonofflan extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'sonofflan' });
        this.devices = new Map(); // deviceid -> dev
        this.unknownLan = new Set();
        this.lanSeen = {};
        this.stateCache = new Map();
        this.createdObjects = new Set();
        this.pendingBulk = new Map();
        this.loopTimer = null;
        this.pollTimer = null;
        this.cloud = null;
        this.local = null;
        this.unloading = false;
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // ------------------------------------------------------------- Start ----

    async onReady() {
        const cfg = this.config;
        this.mode = ['auto', 'cloud', 'local'].includes(cfg.mode) ? cfg.mode : 'auto';
        this.log.info(`SonoffLAN ${this.version} startet im Modus "${this.mode}"`);
        await this.ensureAdapterObjects();
        await this.setStateAsync('info.connection', false, true);

        const hasCreds = !!(cfg.username && cfg.password);
        if (this.mode !== 'local' && !hasCreds) {
            this.log.warn('Keine eWeLink-Zugangsdaten konfiguriert – Cloud wird nicht genutzt. Nur DIY-Geräte und Geräte mit hinterlegtem devicekey funktionieren.');
        }

        // 1. Geräte-Cache aus vorhandenen Objekten laden (Offline-/LAN-Betrieb)
        const cached = await this.loadCachedDevices();

        // 2. Geräteliste aus der Cloud holen
        let cloudDevices = null;
        if (hasCreds) {
            this.cloud = new CloudRegistry({ log: this.log, appId: cfg.appId || undefined, appSecret: cfg.appSecret || undefined });
            try {
                await this.cloud.login(cfg.username, cfg.password, cfg.countryCode || '+49');
                const homes = String(cfg.homes || '')
                    .split(',')
                    .map(s => s.trim())
                    .filter(Boolean);
                cloudDevices = await this.cloud.getDevices(homes);
                this.log.info(`Cloud: ${cloudDevices.length} Gerät(e) im Konto gefunden (Region ${this.cloud.region})`);
            } catch (e) {
                this.log.error(`Cloud-Geräteliste konnte nicht geladen werden: ${e.message} – verwende ${cached.length} zwischengespeicherte(s) Gerät(e)`);
            }
        }

        // 3. Geräte zusammenführen und einrichten
        const list = this.mergeDevices(cached, cloudDevices);
        await this.setupDevices(list);
        this.saveCache();

        // 4. Verbindungen starten
        if (this.cloud && this.mode !== 'local') {
            this.cloud.on('connected', v => this.onCloudConnected(v));
            this.cloud.on('update', msg => this.onCloudUpdate(msg).catch(e => this.log.warn(`Cloud-Update: ${e.message}`)));
            this.cloud.start({ username: cfg.username, password: cfg.password, countryCode: cfg.countryCode || '+49' });
        }
        if (this.mode !== 'cloud') {
            this.local = new LocalRegistry({ log: this.log, iface: cfg.mdnsInterface || undefined, queryInterval: 60 });
            this.local.on('update', msg => this.onLocalUpdate(msg).catch(e => this.log.warn(`LAN-Update: ${e.message}`)));
            this.local.start();
            this.loopTimer = setInterval(() => this.localLoop(), LOOP_INTERVAL);
        }
        this.pollTimer = setInterval(() => this.energyLoop(), 60000);
        this.firstPollTimer = setTimeout(() => this.energyLoop(), 20000);

        this.subscribeStates('*');
        this.updateConnection();
    }

    async ensureAdapterObjects() {
        await this.extendObjectAsync('info', { type: 'channel', common: { name: 'Information' }, native: {} });
        await this.extendObjectAsync('info.connection', {
            type: 'state',
            common: { name: 'Verbunden (Cloud oder LAN)', type: 'boolean', role: 'indicator.connected', read: true, write: false, def: false },
            native: {},
        });
        await this.extendObjectAsync('info.cloud', {
            type: 'state',
            common: { name: 'Cloud verbunden', type: 'boolean', role: 'indicator.connected', read: true, write: false, def: false },
            native: {},
        });
        await this.extendObjectAsync('info.lanDiscovered', {
            type: 'state',
            common: { name: 'Im LAN gefundene Geräte (JSON)', type: 'string', role: 'json', read: true, write: false, def: '{}' },
            native: {},
        });
    }

    get cacheFile() {
        const dir = utils.getAbsoluteInstanceDataDir(this);
        return path.join(dir, 'devices.json');
    }

    async loadCachedDevices() {
        try {
            const raw = await fs.promises.readFile(this.cacheFile, 'utf8');
            const list = JSON.parse(raw);
            if (Array.isArray(list)) {
                this.log.debug(`Gerätecache: ${list.length} Gerät(e) geladen`);
                return list.map(d => ({ ...d, params: {}, cached: true }));
            }
        } catch (e) {
            if (e.code !== 'ENOENT') this.log.warn(`Gerätecache konnte nicht gelesen werden: ${e.message}`);
        }
        return [];
    }

    /** Gerätecache verzögert schreiben (enthält devicekeys – bleibt lokal im Datenverzeichnis). */
    saveCache() {
        clearTimeout(this.cacheTimer);
        this.cacheTimer = setTimeout(async () => {
            try {
                const list = [];
                for (const dev of this.devices.values()) {
                    if (!dev.apikey && !dev.devicekey && !dev.host) continue;
                    const o = {};
                    for (const k of CACHE_KEYS) if (dev[k] !== undefined) o[k] = dev[k];
                    list.push(o);
                }
                await fs.promises.mkdir(path.dirname(this.cacheFile), { recursive: true });
                await fs.promises.writeFile(this.cacheFile, JSON.stringify(list, null, 1), { mode: 0o600 });
            } catch (e) {
                this.log.warn(`Gerätecache konnte nicht geschrieben werden: ${e.message}`);
            }
        }, 2000);
    }

    mergeDevices(cached, cloudDevices) {
        const map = new Map();
        for (const d of cached) map.set(d.deviceid, d);
        if (cloudDevices) {
            for (const d of cloudDevices) {
                const old = map.get(d.deviceid) || {};
                map.set(d.deviceid, { ...old, ...d, params: d.params || {}, cached: false, host: old.host });
            }
        }
        // manuelle Konfiguration (devicekey, host, uiid, Name)
        for (const m of this.config.devices || []) {
            if (!m || !m.deviceid) continue;
            const did = String(m.deviceid).trim();
            const d = map.get(did) || { deviceid: did, params: {}, manualOnly: true };
            if (m.devicekey) d.devicekey = String(m.devicekey).trim();
            if (m.host) d.host = String(m.host).trim();
            if (m.name) d.name = m.name;
            if (m.uiid) d.uiidOverride = Number(m.uiid);
            if (d.manualOnly && !d.extra) d.extra = { uiid: Number(m.uiid) || 0 };
            map.set(did, d);
        }
        return [...map.values()];
    }

    async setupDevices(list) {
        // Geräte ohne parent zuerst
        list.sort((a, b) => String((a.params && a.params.parentid) || a.parentid || '').localeCompare(String((b.params && b.params.parentid) || b.parentid || '')));
        for (const raw of list) {
            try {
                await this.setupDevice(raw);
            } catch (e) {
                this.log.warn(`${raw.deviceid}: Einrichtung fehlgeschlagen: ${e.stack || e.message}`);
            }
        }
    }

    async setupDevice(dev) {
        const did = dev.deviceid;
        dev.params = dev.params || {};
        dev.extra = dev.extra || { uiid: 0 };
        dev.name = dev.name || did;
        if (dev.host) {
            dev.local = false;
            dev.localfail = 0;
            dev.localping = 0;
            dev.localrecv = 0;
        }
        const parentid = dev.params.parentid || dev.parentid;
        if (parentid) {
            dev.parentid = parentid;
            const parent = this.devices.get(parentid);
            if (parent) dev.parent = parent;
        }
        dev.features = getSpec(dev, { uiid: dev.uiidOverride });
        dev.nextPoll = {};
        this.devices.set(did, dev);

        const uiid = dev.uiidOverride || dev.extra.uiid;
        if (uiid && !isKnownUiid(uiid)) {
            this.log.info(`${did} (${dev.name}): UIID ${uiid} ist nicht im Mapping – generische Datenpunkte + raw.command verfügbar`);
        }
        await this.createDeviceObjects(dev);
        if (Object.keys(dev.params).length) await this.applyParams(dev, dev.params, true);
        await this.updateAvailability(dev);
        this.log.debug(`${did} eingerichtet: UIID ${uiid}, ${dev.features.length} Feature(s)`);
    }

    // ---------------------------------------------------------- Objekte ----

    async createDeviceObjects(dev) {
        const did = safeId(dev.deviceid);
        const native = { deviceid: dev.deviceid, uiid: Number(dev.uiidOverride || dev.extra.uiid) || 0, model: dev.productModel || '' };
        await this.extendObjectAsync(did, {
            type: 'device',
            common: { name: dev.name, statusStates: { onlineId: `${this.namespace}.${did}.info.reachable` } },
            native,
        });

        const info = [
            ['name', { name: 'Name', type: 'string', role: 'info.name' }],
            ['model', { name: 'Modell', type: 'string', role: 'info.model' }],
            ['brand', { name: 'Hersteller', type: 'string', role: 'info.manufacturer' }],
            ['uiid', { name: 'UIID (Gerätetyp)', type: 'number', role: 'value' }],
            ['firmware', { name: 'Firmware', type: 'string', role: 'info.firmware' }],
            ['cloudOnline', { name: 'In der Cloud online', type: 'boolean', role: 'indicator.reachable' }],
            ['local', { name: 'Im LAN erreichbar', type: 'boolean', role: 'indicator.reachable' }],
            ['reachable', { name: 'Erreichbar', type: 'boolean', role: 'indicator.reachable' }],
            ['connection', { name: 'Verbindungsweg', type: 'string', role: 'text', states: { local: 'LAN', cloud: 'Cloud', offline: 'offline' } }],
            ['host', { name: 'LAN-Adresse', type: 'string', role: 'info.ip' }],
            ['lastUpdate', { name: 'Letzte Aktualisierung', type: 'number', role: 'value.time' }],
        ];
        await this.ensureChannel(`${did}.info`, 'Information');
        for (const [id, common] of info) await this.ensureState(`${did}.info.${id}`, { read: true, write: false, ...common });

        if (this.config.createRaw !== false) {
            await this.ensureChannel(`${did}.raw`, 'Rohdaten');
            await this.ensureState(`${did}.raw.params`, { name: 'Alle Parameter (JSON)', type: 'string', role: 'json', read: true, write: false });
            await this.ensureState(`${did}.raw.command`, {
                name: 'Befehl senden (JSON-Parameter, z. B. {"switch":"on"})',
                type: 'string',
                role: 'json',
                read: true,
                write: true,
            });
        }

        for (const f of dev.features) {
            const states = typeof f.states === 'function' ? f.states(dev) : f.states || [];
            for (const s of states) {
                const parts = s.id.split('.');
                if (parts.length > 1) await this.ensureChannel(`${did}.${parts.slice(0, -1).join('.')}`, parts[0]);
                await this.ensureState(`${did}.${s.id}`, s.common);
            }
        }

        await this.setCached(`${did}.info.name`, dev.name);
        await this.setCached(`${did}.info.model`, dev.productModel || '');
        await this.setCached(`${did}.info.brand`, dev.brandName || '');
        await this.setCached(`${did}.info.uiid`, Number(dev.extra.uiid) || 0);
        if (dev.host) await this.setCached(`${did}.info.host`, dev.host);
    }

    async ensureChannel(id, name) {
        if (this.createdObjects.has(id)) return;
        await this.extendObjectAsync(id, { type: 'channel', common: { name }, native: {} });
        this.createdObjects.add(id);
    }

    async ensureState(id, common) {
        if (this.createdObjects.has(id)) return;
        await this.extendObjectAsync(id, { type: 'state', common: { read: true, ...common }, native: {} });
        this.createdObjects.add(id);
    }

    async setCached(id, val) {
        if (val === undefined || (typeof val === 'number' && !Number.isFinite(val))) return;
        if (this.stateCache.get(id) === val) return;
        this.stateCache.set(id, val);
        await this.setStateAsync(id, val, true);
    }

    // ------------------------------------------------------- Status-Update --

    /** Parameter in Gerät übernehmen und Datenpunkte aktualisieren. */
    async applyParams(dev, params, initial = false) {
        if (!params || typeof params !== 'object') return;
        if (!initial) dev.params = { ...dev.params, ...params };
        const did = safeId(dev.deviceid);
        for (const f of dev.features) {
            if (initial && f.event) {
                // Ereignis-Features nur initialisieren (Duplikatschutz), nicht auslösen
                try {
                    f.update(params, dev);
                } catch {
                    /* egal */
                }
                continue;
            }
            let out;
            try {
                out = f.update(params, dev);
            } catch (e) {
                this.log.debug(`${dev.deviceid}: Update-Fehler: ${e.message}`);
                continue;
            }
            if (!out) continue;
            for (const [k, v] of Object.entries(out)) {
                if (v === undefined || v === null) continue;
                if (f.event) {
                    this.stateCache.delete(`${did}.${k}`);
                    await this.setStateAsync(`${did}.${k}`, v, true);
                } else {
                    await this.setCached(`${did}.${k}`, v);
                }
            }
        }
        if (params.fwVersion) await this.setCached(`${did}.info.firmware`, String(params.fwVersion));
        if (this.config.createRaw !== false) await this.setCached(`${did}.raw.params`, JSON.stringify(dev.params));
        if (!initial) await this.setStateAsync(`${did}.info.lastUpdate`, Date.now(), true);
    }

    async updateAvailability(dev) {
        const did = safeId(dev.deviceid);
        const local = !!dev.local && !!(this.local && this.local.online);
        const cloud = !!dev.online && !!(this.cloud && this.cloud.online);
        let viaParent = false;
        if (dev.parent && ['meter', 'rf'].includes(dev.parent.localtype)) viaParent = !!dev.parent.local;
        await this.setCached(`${did}.info.local`, local || viaParent);
        await this.setCached(`${did}.info.cloudOnline`, !!dev.online);
        await this.setCached(`${did}.info.reachable`, local || cloud || viaParent);
        await this.setCached(`${did}.info.connection`, local || viaParent ? 'local' : cloud ? 'cloud' : 'offline');
    }

    updateConnection() {
        const cloud = !!(this.cloud && this.cloud.online);
        const local = !!(this.local && this.local.online);
        this.setCached('info.cloud', cloud).catch(() => {});
        this.setCached('info.connection', cloud || local).catch(() => {});
    }

    // ------------------------------------------------------------- Cloud ----

    async onCloudConnected(online) {
        this.updateConnection();
        if (online) {
            this.log.info('Cloud verbunden');
            for (const dev of this.devices.values()) {
                await this.updateAvailability(dev);
            }
            if (this.cloudWasConnected) {
                // nach Reconnect aktuelle Zustände abfragen
                for (const dev of this.devices.values()) {
                    if (dev.online && dev.apikey && !dev.local) await this.cloud.send(dev, null, undefined, 0);
                }
            }
            this.cloudWasConnected = true;
        } else {
            for (const dev of this.devices.values()) await this.updateAvailability(dev);
        }
    }

    async onCloudUpdate(msg) {
        const dev = this.devices.get(msg.deviceid);
        // Gerät eines anderen Homes oder nur manuell konfiguriert
        if (!dev || dev.online === undefined) return;
        const params = msg.params || {};
        dev.cloudSeq = msg.sequence;
        this.log.debug(`${dev.deviceid} <= Cloud | ${JSON.stringify(params)}`);
        if ('online' in params) {
            dev.online = params.online;
            dev.localping = 0; // LAN sofort prüfen
            await this.updateAvailability(dev);
        } else if (dev.online === false && !(Object.keys(params).length === 1 && 'subDevRssi' in params)) {
            dev.online = true;
            await this.updateAvailability(dev);
        }
        await this.applyParams(dev, params);
    }

    // --------------------------------------------------------------- LAN ----

    async onLocalUpdate(msg) {
        const mainid = msg.deviceid;
        let dev = this.devices.get(mainid);
        let params = msg.params;

        if (msg.host && this.lanSeen[mainid] !== msg.host) {
            this.lanSeen[mainid] = msg.host;
            this.setCached('info.lanDiscovered', JSON.stringify(this.lanSeen)).catch(() => {});
        }

        if (!dev) {
            if (!params) {
                // verschlüsseltes Gerät ohne Schlüssel
                if (!this.unknownLan.has(mainid)) {
                    this.unknownLan.add(mainid);
                    this.log.info(
                        `LAN-Gerät ${mainid} (${msg.localtype}) unter ${msg.host || '?'} gefunden, aber kein devicekey bekannt. Mit eWeLink-Zugangsdaten oder manuellem devicekey konfigurieren.`,
                    );
                }
                return;
            }
            // neues DIY-Gerät
            const diy = setupDiy({ deviceid: mainid, localtype: msg.localtype, params, host: msg.host });
            this.log.info(`Neues DIY-Gerät ${mainid} (${diy.productModel}) unter ${msg.host} gefunden`);
            await this.setupDevice(diy);
            dev = this.devices.get(mainid);
            this.saveCache();
        } else if (!params) {
            if (!dev.devicekey) return;
            try {
                params = decryptMsg(msg, dev.devicekey);
            } catch (e) {
                this.log.debug(`${mainid}: Entschlüsselung fehlgeschlagen (${e.message}) – devicekey korrekt?`);
                return;
            }
        } else if (dev.devicekey) {
            // unverschlüsselt trotz devicekey: DIY-Gerät noch im Konto
            delete dev.devicekey;
        }

        const realid = msg.subdevid && msg.subdevid !== mainid ? msg.subdevid : mainid;
        const target = this.devices.get(realid) || dev;
        this.log.debug(`${realid} <= LAN | ${msg.host || '^^^'} | ${JSON.stringify(params)} | ${msg.seq}`);

        if (msg.host && dev.host !== msg.host) {
            dev.host = msg.host;
            dev.localtype = msg.localtype;
            await this.setCached(`${safeId(mainid)}.info.host`, msg.host);
            this.saveCache();
        }
        if (msg.localtype && !dev.localtype) dev.localtype = msg.localtype;

        const wasLocal = dev.local;
        const now = Date.now();
        dev.local = true;
        dev.localfail = 0;
        dev.localping = now + 59000;
        dev.localrecv = now;
        if (!wasLocal) await this.updateAvailability(dev);

        await this.applyParams(target, params);
        if (target !== dev) await this.updateAvailability(target);
    }

    async localLoop() {
        if (!this.local || !this.local.online) return;
        const now = Date.now();
        for (const dev of this.devices.values()) {
            try {
                if (dev.local !== undefined && dev.host) this.updateLocal(dev, now);
                else if (dev.parent && dev.parent.localtype === 'meter') this.updateLocalChild(dev.parent, dev);
            } catch (e) {
                this.log.debug(`localLoop: ${e.message}`);
            }
        }
    }

    updateLocal(dev, now) {
        if (dev.localBusy) return;
        // 1. Sensorwerte anstoßen (POW/TH), wenn > 4 s keine Daten
        if (this.config.sensorRefresh !== false && now >= dev.localrecv + 4000 && dev.localfail < 3 && dev.local) {
            const uiid = dev.extra.uiid;
            if (SLED_REFRESH_UIIDS.includes(uiid) && dev.params.sledOnline) {
                this.sendLocal(dev, 'sledOnline', { sledOnline: dev.params.sledOnline });
                return;
            }
            if (uiid === 126) {
                this.sendLocal(dev, 'statistics');
                return;
            }
        }
        // 2. Erreichbarkeit prüfen
        if (now >= dev.localping) this.sendLocal(dev);
    }

    updateLocalChild(parent, dev) {
        if (!parent.local || parent.localfail >= 3) return;
        const outlet = dev.activeOutlet || 0;
        dev.activeOutlet = outlet < 3 ? outlet + 1 : 0;
        this.sendLocal(parent, 'uiActive', { subDevId: dev.deviceid, uiActive: { outlet, time: 60 } });
    }

    async sendLocal(dev, command, params) {
        dev.localBusy = true;
        let ok;
        try {
            ok = await this.local.send(dev, params, command);
        } finally {
            dev.localBusy = false;
        }
        if (ok === 'online') {
            dev.localfail = 0;
            dev.localping = Date.now() + 59000;
            if (!dev.local) {
                dev.local = true;
                this.log.debug(`${dev.deviceid}: LAN online`);
                await this.updateAvailability(dev);
                await this.updateChildrenAvailability(dev);
            }
            return;
        }
        dev.localfail = (dev.localfail || 0) + 1;
        // Befehle (sledOnline/statistics) setzen das Gerät nicht offline
        if (command || dev.localfail < 3) return;
        if (dev.local) {
            dev.local = false;
            this.log.debug(`${dev.deviceid}: LAN offline (${ok})`);
            await this.updateAvailability(dev);
            await this.updateChildrenAvailability(dev);
        }
        dev.localping = Date.now() + 59000;
    }

    async updateChildrenAvailability(parent) {
        for (const d of this.devices.values()) if (d.parent === parent) await this.updateAvailability(d);
    }

    // ------------------------------------------------------- Energie-Poll ---

    async energyLoop() {
        if (this.unloading || this.energyRunning) return;
        this.energyRunning = true;
        try {
            await this._energyLoop();
        } finally {
            this.energyRunning = false;
        }
    }

    async _energyLoop() {
        const now = Date.now();
        for (const dev of this.devices.values()) {
            for (const f of dev.features) {
                if (!f.poll) continue;
                const p = f.poll;
                const interval = (Number(this.config.energyInterval) || p.interval) * 1000;
                if (dev.nextPoll[p.key] && now < dev.nextPoll[p.key]) continue;
                let ok = null;
                if (p.via === 'cloud') {
                    if (this.canCloud(dev)) ok = await this.cloud.send(dev, p.params, undefined, 5);
                } else if (this.canLocal(dev) || this.canCloud(dev)) {
                    ok = await this.sendCommand(dev, { params: p.params, queryCloud: false, timeoutLan: p.timeoutLan });
                }
                dev.nextPoll[p.key] = now + (ok === 'online' ? interval : 5 * 60000);
                if (this.unloading) return;
                await sleep(500);
            }
        }
    }

    // ----------------------------------------------------------- Senden -----

    canCloud(dev) {
        return !!(this.cloud && this.cloud.online && dev.online && dev.apikey);
    }

    canLocal(dev) {
        if (!this.local || !this.local.online) return false;
        if (dev.parent && ['meter', 'rf'].includes(dev.parent.localtype)) return !!dev.parent.local;
        return !!dev.local;
    }

    /**
     * Befehl über LAN (bevorzugt, 1 s Timeout) oder Cloud senden.
     * @returns {Promise<string>}
     */
    async sendCommand(dev, cmd) {
        const { params, cmdLan, cloudOnly, preOn } = cmd;
        let paramsLan = cmd.paramsLan;
        const queryCloud = cmd.queryCloud !== false;

        if (preOn) await this.sendCommand(dev, { params: preOn, queryCloud: false });

        const seq = nextSequence();
        let main = dev;
        if (dev.parent) {
            main = dev.parent;
            if (paramsLan == null && params) paramsLan = { ...params };
            if (paramsLan) paramsLan = { ...paramsLan, subDevId: dev.deviceid };
        }
        const canLocal = !cloudOnly && this.canLocal(dev);
        const canCloud = this.canCloud(dev);
        let ok = 'offline';

        if (canLocal && canCloud) {
            ok = await this.local.send(main, paramsLan || params, cmdLan, seq, cmd.timeoutLan || 1);
            if (ok !== 'online') {
                ok = await this.cloud.send(dev, params, seq);
                if (ok !== 'online') main.localping = 0;
                else if (queryCloud && params) await this.cloud.send(dev, null, undefined, 0);
            }
        } else if (canLocal) {
            ok = await this.local.send(main, paramsLan || params, cmdLan, seq, cmd.timeoutLan || 5);
            if (ok !== 'online') main.localping = 0;
        } else if (canCloud) {
            ok = await this.cloud.send(dev, params, seq);
            if (ok === 'online' && queryCloud && params) await this.cloud.send(dev, null, undefined, 0);
        } else {
            this.log.warn(`${dev.deviceid} (${dev.name}): weder per LAN noch per Cloud erreichbar – Befehl verworfen`);
            return 'offline';
        }
        if (ok !== 'online') this.log.warn(`${dev.deviceid} (${dev.name}): Befehl ${JSON.stringify(params)} fehlgeschlagen (${ok})`);
        return ok;
    }

    /** Mehrere Kanalbefehle innerhalb von 100 ms bündeln. */
    sendBulk(dev, params) {
        let pend = this.pendingBulk.get(dev.deviceid);
        if (!pend) {
            pend = { switches: [] };
            this.pendingBulk.set(dev.deviceid, pend);
            setTimeout(() => {
                this.pendingBulk.delete(dev.deviceid);
                this.sendCommand(dev, { params: { switches: pend.switches } }).catch(e => this.log.warn(e.message));
            }, 100);
        }
        for (const n of params.switches) {
            const old = pend.switches.find(s => s.outlet === n.outlet);
            if (old) old.switch = n.switch;
            else pend.switches.push({ ...n });
        }
    }

    async onStateChange(id, state) {
        if (!state || state.ack || this.unloading) return;
        const rel = id.slice(this.namespace.length + 1);
        const dot = rel.indexOf('.');
        if (dot < 0) return;
        const did = rel.slice(0, dot);
        const sid = rel.slice(dot + 1);
        const dev = this.devices.get(did);
        if (!dev) return;

        if (sid === 'raw.command') {
            let params;
            try {
                params = JSON.parse(String(state.val));
            } catch {
                this.log.warn(`${did}: raw.command ist kein gültiges JSON`);
                return;
            }
            if (!params || typeof params !== 'object' || Array.isArray(params)) {
                this.log.warn(`${did}: raw.command muss ein JSON-Objekt sein`);
                return;
            }
            const ok = await this.sendCommand(dev, { params });
            if (ok === 'online') await this.setStateAsync(id, state.val, true);
            return;
        }

        for (const f of dev.features) {
            let cmd = f.write ? f.write(sid, state.val, dev) : null;
            if (!cmd && f.writeValue) cmd = f.writeValue(sid, state.val, dev);
            if (!cmd) continue;
            this.log.debug(`${did}: ${sid} = ${JSON.stringify(state.val)} -> ${JSON.stringify(cmd.params)}`);
            if (cmd.bulk === 'switches') {
                this.sendBulk(dev, cmd.params);
                return;
            }
            const ok = await this.sendCommand(dev, cmd);
            // Taster sofort zurücksetzen
            const obj = await this.getObjectAsync(id);
            if (obj && obj.common && obj.common.role && obj.common.role.startsWith('button')) {
                await this.setStateAsync(id, false, true);
            } else if (ok === 'online' && cmd.ackOnSuccess) {
                await this.setStateAsync(id, state.val, true);
            }
            return;
        }
        this.log.debug(`${did}: ${sid} ist nicht schreibbar`);
    }

    // --------------------------------------------------------- Messages -----

    async onMessage(obj) {
        if (!obj || !obj.command) return;
        if (obj.command === 'testLogin') {
            const m = obj.message || {};
            const c = new CloudRegistry({ log: this.log, appId: m.appId || this.config.appId || undefined, appSecret: m.appSecret || this.config.appSecret || undefined });
            let result;
            try {
                await c.login(m.username || this.config.username, m.password || this.config.password, m.countryCode || this.config.countryCode || '+49');
                const devs = await c.getDevices();
                result = { result: `Login OK (Region ${c.region}) – ${devs.length} Gerät(e): ${devs.map(d => d.name).join(', ')}` };
            } catch (e) {
                result = { error: `Login fehlgeschlagen: ${e.message}` };
            }
            if (obj.callback) this.sendTo(obj.from, obj.command, result, obj.callback);
        }
    }

    // ------------------------------------------------------------ Ende ------

    async onUnload(callback) {
        this.unloading = true;
        try {
            clearInterval(this.loopTimer);
            clearInterval(this.pollTimer);
            clearTimeout(this.cacheTimer);
            clearTimeout(this.firstPollTimer);
            if (this.cloud) await this.cloud.stop();
            if (this.local) await this.local.stop();
            await this.setStateAsync('info.connection', false, true);
        } catch {
            /* egal */
        }
        callback();
    }
}

if (require.main !== module) {
    module.exports = options => new Sonofflan(options);
} else {
    new Sonofflan();
}
