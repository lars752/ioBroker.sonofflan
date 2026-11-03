'use strict';
// Minimaler Ersatz für @iobroker/adapter-core zum Testen außerhalb von ioBroker.
const EventEmitter = require('node:events');
const os = require('node:os');
const path = require('node:path');

class Adapter extends EventEmitter {
    constructor(opts) {
        super();
        this.name = opts.name;
        this.namespace = `${opts.name}.0`;
        this.version = 'test';
        this.config = opts.config || {};
        this.objects = {};
        this.states = {};
        this.logs = [];
        const mk = lvl => msg => {
            this.logs.push([lvl, msg]);
            if (process.env.VERBOSE || lvl === 'error') console.log(`  [${lvl}] ${msg}`);
        };
        this.log = { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') };
    }
    full(id) { return id.startsWith(this.namespace) ? id : `${this.namespace}.${id}`; }
    async extendObjectAsync(id, obj) {
        const f = this.full(id);
        const old = this.objects[f] || {};
        this.objects[f] = { ...old, ...obj, common: { ...(old.common || {}), ...(obj.common || {}) }, native: { ...(old.native || {}), ...(obj.native || {}) } };
    }
    async getObjectAsync(id) { return this.objects[this.full(id)] || null; }
    async setStateAsync(id, val, ack) {
        const f = this.full(id);
        if (!this.objects[f] && !process.env.NOCHECK) throw new Error(`setState ohne Objekt: ${f}`);
        this.states[f] = { val, ack: !!ack };
        if (!ack) setImmediate(() => this.emit('stateChange', f, { val, ack: false }));
    }
    subscribeStates() {}
    sendTo(from, cmd, msg, cb) { if (cb) cb(msg); }
    val(id) { const s = this.states[this.full(id)]; return s ? s.val : undefined; }
}

module.exports = {
    Adapter,
    getAbsoluteInstanceDataDir: a => path.join(os.tmpdir(), `iob-test-${a.namespace}-${process.pid}`),
};
