'use strict';
/**
 * eWeLink LAN-Protokoll: mDNS-Discovery (_ewelink._tcp.local) und HTTP-Befehle
 * an http://<ip>:8081/zeroconf/<command>. Portiert aus AlexxIT/SonoffLAN (MIT),
 * core/ewelink/local.py.
 */
const EventEmitter = require('node:events');
const http = require('node:http');
const mdnsFactory = require('multicast-dns');
const { encryptPayload } = require('./crypto');
const { nextSequence, sleep } = require('./util');

const SERVICE = '_ewelink._tcp.local';

class LocalRegistry extends EventEmitter {
    /**
     * @param {{log: any, iface?: string, queryInterval?: number}} opts
     */
    constructor(opts) {
        super();
        this.log = opts.log;
        this.iface = opts.iface || undefined;
        this.queryInterval = (opts.queryInterval || 60) * 1000;
        this.mdns = null;
        this.online = false;
        this.queryTimer = null;
        this.aRecords = new Map(); // hostname -> ip
        this.services = new Map(); // instance -> {target, port}
        this.lastSeen = new Map(); // deviceid -> seq|data (Duplikatfilter)
        this.agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    }

    start() {
        const opts = { reuseAddr: true, loopback: false };
        if (this.iface) opts.interface = this.iface;
        try {
            this.mdns = mdnsFactory(opts);
        } catch (e) {
            this.log.error(`mDNS konnte nicht gestartet werden: ${e.message}`);
            return;
        }
        this.mdns.on('response', (resp, rinfo) => this._onResponse(resp, rinfo));
        this.mdns.on('error', e => this.log.warn(`mDNS Fehler: ${e.message}`));
        this.mdns.on('warning', e => this.log.debug(`mDNS Warnung: ${e.message}`));
        this.online = true;
        this.emit('connected', true);
        this.query();
        this.queryTimer = setInterval(() => this.query(), this.queryInterval);
    }

    query() {
        if (!this.mdns) return;
        try {
            this.mdns.query({ questions: [{ name: SERVICE, type: 'PTR' }] });
        } catch (e) {
            this.log.debug(`mDNS Query Fehler: ${e.message}`);
        }
    }

    async stop() {
        clearInterval(this.queryTimer);
        this.online = false;
        if (this.mdns) {
            try {
                this.mdns.destroy();
            } catch {
                /* egal */
            }
        }
        this.mdns = null;
        this.agent.destroy();
    }

    _onResponse(resp, rinfo) {
        const records = [...(resp.answers || []), ...(resp.additionals || [])];
        if (!records.some(r => r.name && r.name.toLowerCase().endsWith(SERVICE.toLowerCase()))) return;

        const txts = new Map();
        for (const r of records) {
            if (r.type === 'A' && r.data) this.aRecords.set(r.name.toLowerCase(), r.data);
            else if (r.type === 'SRV' && r.data) this.services.set(r.name, { target: r.data.target, port: r.data.port });
            else if (r.type === 'TXT') txts.set(r.name, r.data);
        }
        for (const [name, txt] of txts) {
            const instance = name.slice(0, name.length - SERVICE.length - 1);
            // eWeLink_1000xxxxxx bzw. eWelink_1000xxxxxx; ihost/zbbridgeu-… überspringen
            if (!instance.toLowerCase().startsWith('ewelink')) continue;
            const deviceid = instance.slice(8, 18);
            const data = parseTxt(txt);
            if (!data.id && !data.type) continue;

            let host = null;
            const srv = this.services.get(name);
            if (srv) {
                const ip = this.aRecords.get(String(srv.target).toLowerCase()) || (rinfo && rinfo.address);
                if (ip) host = srv.port ? `${ip}:${srv.port}` : ip;
            } else if (rinfo && rinfo.address) {
                host = `${rinfo.address}:8081`;
            }
            this._handleTxt(deviceid, host, data);
        }
    }

    _handleTxt(deviceid, host, data) {
        let raw = '';
        for (let i = 1; i <= 4; i++) if (data[`data${i}`]) raw += data[`data${i}`];

        // identische Wiederholungen (mDNS-Echos) verwerfen
        const key = `${data.seq}|${raw}|${host}`;
        if (this.lastSeen.get(deviceid) === key) return;
        this.lastSeen.set(deviceid, key);

        const msg = { deviceid, subdevid: data.id, localtype: data.type, seq: data.seq };
        if (host) msg.host = host;
        if (data.encrypt === 'true') {
            msg.data = raw;
            msg.iv = data.iv;
        } else if (raw) {
            try {
                msg.params = JSON.parse(raw);
            } catch (e) {
                this.log.debug(`${deviceid} <= mDNS: ungültiges JSON: ${raw}`);
                return;
            }
        }
        this.emit('update', msg);
    }

    /**
     * LAN-Befehl senden.
     * @returns {Promise<string>} 'online' | 'error' | 'timeout' | 'E#CON' | 'E#CRE' | …
     */
    async send(device, params, command, sequence, timeout = 5, retries = 10) {
        if (!device.host) return 'E#NOHOST';
        if (!command) command = params && Object.keys(params).length ? Object.keys(params)[0] : 'getState';

        let payload = {
            sequence: sequence || nextSequence(),
            deviceid: device.deviceid,
            selfApikey: '123',
            data: params || {},
        };
        if (device.devicekey) payload = encryptPayload(payload, device.devicekey);

        let host = device.host;
        if (!host.includes(':')) host += ':8081';
        const log = `${device.deviceid} => LAN | ${host} | ${command} ${JSON.stringify(params || {})}`;

        let res;
        try {
            res = await this._post(`http://${host}/zeroconf/${command}`, payload, timeout * 1000);
        } catch (e) {
            if (e.code === 'ETIMEDOUT') {
                this.log.debug(`${log} !! Timeout`);
                return 'timeout';
            }
            if (e.code === 'ECONNRESET') {
                // Gerätewebserver verarbeitet nur eine Anfrage gleichzeitig
                if (retries > 0) {
                    await sleep(100);
                    return this.send(device, params, command, payload.sequence, timeout, retries - 1);
                }
                return 'E#CRE';
            }
            this.log.debug(`${log} !! ${e.code || e.message}`);
            return e.code === 'ECONNREFUSED' || e.code === 'EHOSTUNREACH' ? 'E#CON' : 'E#COE';
        }

        let resp;
        try {
            resp = JSON.parse(res);
        } catch (e) {
            // manche Geräte unterstützen getState nicht
            if (command === 'getState') return 'online';
            this.log.debug(`${log} !! ungültige Antwort: ${res.slice(0, 100)}`);
            return 'error';
        }
        this.log.debug(`${log} <= ${JSON.stringify(resp)}`);
        if (resp.error === 0) {
            if (resp.iv) {
                const msg = {
                    deviceid: device.deviceid,
                    localtype: device.localtype,
                    seq: resp.seq,
                    data: resp.data,
                    iv: resp.iv,
                };
                if (params && params.subDevId) msg.subdevid = params.subDevId;
                this.emit('update', msg);
            } else if (resp.data && typeof resp.data === 'object' && Object.keys(resp.data).length) {
                // DIY-Geräte antworten unverschlüsselt
                this.emit('update', { deviceid: device.deviceid, localtype: device.localtype, seq: resp.seq, params: resp.data });
            }
            return 'online';
        }
        return command === 'getState' ? 'online' : 'error';
    }

    _post(url, body, timeoutMs) {
        return new Promise((resolve, reject) => {
            const data = Buffer.from(JSON.stringify(body), 'utf8');
            const req = http.request(
                url,
                {
                    method: 'POST',
                    agent: this.agent,
                    headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, Connection: 'close' },
                },
                res => {
                    const chunks = [];
                    res.on('data', c => chunks.push(c));
                    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                    res.on('error', reject);
                },
            );
            req.setTimeout(timeoutMs, () => {
                const e = new Error('Timeout');
                e.code = 'ETIMEDOUT';
                req.destroy(e);
            });
            req.on('error', reject);
            req.end(data);
        });
    }
}

function parseTxt(txt) {
    const out = {};
    const arr = Array.isArray(txt) ? txt : [txt];
    for (const item of arr) {
        const s = Buffer.isBuffer(item) ? item.toString('utf8') : String(item);
        const i = s.indexOf('=');
        if (i > 0) out[s.slice(0, i)] = s.slice(i + 1);
    }
    return out;
}

module.exports = { LocalRegistry, parseTxt };
