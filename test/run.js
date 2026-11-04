'use strict';
/* Selbsttests: node test/run.js  (VERBOSE=1 für Logausgabe) */
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const Module = require('node:module');

// adapter-core durch Mock ersetzen
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === '@iobroker/adapter-core') return path.join(__dirname, 'mock-adapter-core.js');
    return origResolve.call(this, req, ...rest);
};

const crypto = require('../lib/crypto');
const { getSpec, setupDiy, DECODERS, F } = require('../lib/devices');
const { CloudRegistry } = require('../lib/cloud');
const { parseTxt } = require('../lib/local');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------- Krypto ----
test('Signatur entspricht Referenz aus SonoffLAN (Python)', () => {
    const msg = '{"password": "x", "countryCode": "+49", "email": "a@b.c"}';
    assert.equal(crypto.sign(Buffer.from(msg)), '5w47TvNANVkvTcscK8PeonnTBLsCwfq1VNd/SVuRNt4=');
});
test('AES-Roundtrip + RF-Bridge-Fix', () => {
    const p = crypto.encryptPayload({ sequence: '1', deviceid: 'x', data: { switch: 'on', a: [1, 2] } }, 'key123');
    assert.equal(p.encrypt, true);
    assert.deepEqual(crypto.decryptMsg(p, 'key123'), { switch: 'on', a: [1, 2] });
    assert.deepEqual(crypto.decryptMsg({ data: '' }, 'k'), {});
});
test('mDNS-TXT parsen', () => {
    const t = parseTxt([Buffer.from('id=1000abcdef'), Buffer.from('type=plug'), Buffer.from('data1={"switch":"on"}')]);
    assert.equal(t.id, '1000abcdef');
    assert.equal(t.data1, '{"switch":"on"}');
});

// ------------------------------------------------------------ Mapping ----
const feat = (uiid, params = {}, extra = {}) => {
    const dev = { deviceid: 'd', extra: { uiid }, params, ...extra };
    return { dev, features: getSpec(dev) };
};
const write = (fs, dev, id, v) => {
    for (const f of fs) {
        const c = (f.write && f.write(id, v, dev)) || (f.writeValue && f.writeValue(id, v, dev));
        if (c) return c;
    }
    return null;
};
const update = (fs, dev, p) => Object.assign({}, ...fs.map(f => f.update(p, dev) || {}));

test('UIID 1: Schalter, LED, Inching', () => {
    const { dev, features } = feat(1, { switch: 'on', sledOnline: 'off', pulseWidth: 1500 });
    assert.deepEqual(update(features, dev, dev.params), { switch: true, led: false, pulseWidth: 1.5 });
    assert.deepEqual(write(features, dev, 'switch', false).params, { switch: 'off' });
    assert.deepEqual(write(features, dev, 'pulseWidth', 2.2).params, { pulse: 'on', pulseWidth: 2000 });
});
test('UIID 4: Kanäle mit Bulk und Kanalnamen', () => {
    const { dev, features } = feat(4, { switches: [{ outlet: 2, switch: 'on' }] }, { tags: { ck_channel_name: { 0: 'Flur' } } });
    const st = features[0].states(dev);
    assert.equal(st[0].common.name, 'Flur');
    assert.deepEqual(update(features, dev, dev.params), { channel3: true });
    const c = write(features, dev, 'channel2', true);
    assert.equal(c.bulk, 'switches');
    assert.deepEqual(c.params, { switches: [{ outlet: 1, switch: 'on' }] });
});
test('UIID 15: TH16 Schalter + Temperaturfilter', () => {
    const { dev, features } = feat(15, { switch: 'on', currentTemperature: '21.46', currentHumidity: 0 });
    assert.deepEqual(update(features, dev, dev.params), { switch: true, temperature: 21.5 });
    assert.deepEqual(write(features, dev, 'switch', true).params, { switch: 'on', mainSwitch: 'on', deviceType: 'normal' });
});
test('UIID 190: POWR3 Skalierung + Kanal operSide', () => {
    const { dev, features } = feat(190, { power: 12345, voltage: 23012, current: 53, dayKwh: 150 });
    const u = update(features, dev, dev.params);
    assert.equal(u.power, 123.45);
    assert.equal(u.voltage, 230.12);
    assert.equal(u.current, 0.53);
    assert.equal(u.energy_day, 1.5);
    assert.deepEqual(write(features, dev, 'channel1', true).params, { switches: [{ outlet: 0, switch: 'on' }], operSide: 1 });
});
test('UIID 126: DualR3 Kanäle / Motormodus', () => {
    let { dev, features } = feat(126, { switches: [] });
    assert.ok(write(features, dev, 'channel2', true));
    ({ dev, features } = feat(126, { workMode: 2 }));
    assert.deepEqual(write(features, dev, 'cover.position', 40).params, { location: 40 });
    assert.deepEqual(write(features, dev, 'cover.stop', true).params, { motorTurn: 0 });
});
test('UIID 104: B05-B Farbe/Weiß', () => {
    const { dev, features } = feat(104, { switch: 'off', ltype: 'white', white: { br: 50, ct: 255 } });
    const u = update(features, dev, dev.params);
    assert.equal(u['light.brightness'], 50);
    assert.equal(u['light.colorTemp'], 6500);
    const c = write(features, dev, 'light.rgb', '#ff8000');
    assert.deepEqual(c.params, { ltype: 'color', color: { br: 50, r: 255, g: 128, b: 0 } });
    assert.equal(c.cmdLan, 'dimmable');
    assert.deepEqual(c.preOn, { switch: 'on' });
    assert.deepEqual(write(features, dev, 'light.colorTemp', 2000).params, { ltype: 'white', white: { br: 50, ct: 0 } });
});
test('UIID 44: D1 Helligkeit', () => {
    const { dev, features } = feat(44, { switch: 'on', brightness: 30 });
    assert.deepEqual(write(features, dev, 'light.brightness', 60).params, { brightness: 60, mode: 0, switch: 'on' });
    assert.equal(write(features, dev, 'light.brightness', 60).preOn, null);
});
test('UIID 34: iFan Stufen (Cloud + LAN)', () => {
    const { dev, features } = feat(34, { switches: [{ outlet: 0, switch: 'on' }, { outlet: 1, switch: 'on' }, { outlet: 2, switch: 'on' }, { outlet: 3, switch: 'off' }] }, { localtype: 'fan_light' });
    assert.deepEqual(update(features, dev, dev.params), { 'fan.speed': 2, 'fan.on': true, 'light.on': true });
    const c = write(features, dev, 'fan.speed', 3);
    assert.deepEqual(c.params.switches, [{ outlet: 1, switch: 'on' }, { outlet: 2, switch: 'off' }, { outlet: 3, switch: 'on' }]);
    assert.deepEqual(c.paramsLan, { fan: 'on', speed: 3 });
});
test('Cover (setclose umgekehrt)', () => {
    const { dev, features } = feat(11, {});
    assert.deepEqual(update(features, dev, { switch: 'off', setclose: 30 }), { 'cover.position': 70, 'cover.state': 'stopped' });
    assert.deepEqual(write(features, dev, 'cover.position', 25).params, { setclose: 75 });
});
test('Tastenereignis mit trigTime-Duplikatschutz', () => {
    const { dev, features } = feat(1000, { key: 0, trigTime: '1' });
    const k = features[0];
    assert.equal(k.update(dev.params, dev), null); // Startwert
    assert.equal(k.update({ key: 0, trigTime: '1' }, dev), null);
    assert.deepEqual(k.update({ key: 1, trigTime: '2' }, dev), { action: 'double' });
});
test('localKeyPass (M5): Cloud-Nachricht und LAN-Vollzustand zählen einmal, späterer Druck wieder', () => {
    let now = 1000;
    const { dev, features } = feat(160, {});
    const f = features.find((x) => x.event);
    f.update.call(f, {}, dev);
    const k = F.key({ localKey: true, now: () => now });
    assert.deepEqual(k.update({ localKeyPass: { outlet: 0, key: 0 }, switches: [{ outlet: 0, switch: 'on' }], rssi: -40 }, dev), { action: 'button_1_single' });
    now += 150;
    assert.equal(k.update({ localKeyPass: { outlet: 0, key: 0 } }, dev), null);
    assert.equal(k.update({ switches: [{ outlet: 0, switch: 'off' }] }, dev), null);
    now += 5000;
    assert.deepEqual(k.update({ localKeyPass: { outlet: 0, key: 0 } }, dev), { action: 'button_1_single' });
    assert.deepEqual(k.update({ localKeyPass: { outlet: 0, key: 1 } }, dev), { action: 'button_1_double' });
});
test('M5: relaySeparations -> detach-Datenpunkte', () => {
    const one = feat(160, {}).features.find((x) => x.update && (x.update({ relaySeparations: [{ outlet: 0, enable: 1 }] }, {}) || {}).detach === true);
    assert.deepEqual(one.update({ relaySeparations: [{ outlet: 0, enable: 1 }] }), { detach: true });
    assert.deepEqual(one.update({ relaySeparations: [{ outlet: 0, enable: 0 }] }), { detach: false });
    assert.equal(one.update({ switches: [] }), null);
    const two = feat(161, {}).features.find((x) => x.update && 'detach1' in (x.update({ relaySeparations: [{ outlet: 0, enable: 1 }] }, {}) || {}));
    assert.deepEqual(two.update({ relaySeparations: [{ outlet: 0, enable: 1 }, { outlet: 1, enable: 0 }] }), { detach1: true, detach2: false });
});
test('Energie-Dekoder', () => {
    assert.deepEqual(DECODERS.pow('010203').slice(0, 1), [1.23]);
    assert.deepEqual(DECODERS.dualr3('0a25'), [10.25]);
    assert.deepEqual(DECODERS.powr3('a05'), [10.05]);
});
test('Unbekannte UIID → generischer Schalter / DIY-Erkennung', () => {
    assert.equal(feat(9999, { switch: 'on' }).features[0].states[0].id, 'switch');
    const d = setupDiy({ localtype: 'diy_plug', params: { switches: [] } });
    assert.equal(d.extra.uiid, 77);
});

// -------------------------------------------------------------- Cloud ----
test('Cloud: Antwortzuordnung per Sequenz + Updates', async () => {
    const c = new CloudRegistry({ log: { debug() {}, warn() {} } });
    const sent = [];
    c.ws = { readyState: 1, send: m => sent.push(JSON.parse(m)) };
    c.auth = { at: 't', user: { apikey: 'self' } };
    const ups = [];
    c.on('update', m => ups.push(m));
    const p = c.send({ deviceid: '1000aaaaaa', apikey: 'k' }, { switch: 'on' }, '42', 2);
    await sleep(10);
    assert.equal(sent[0].action, 'update');
    assert.equal(sent[0].selfApikey, 'self');
    c._processMsg({ sequence: '42', error: 0 });
    assert.equal(await p, 'online');
    c._processMsg({ action: 'update', deviceid: '1000aaaaaa', params: { switch: 'off' } });
    c._processMsg({ action: 'sysmsg', deviceid: '1000aaaaaa', params: { online: false } });
    assert.equal(ups.length, 2);
    const p2 = c.send({ deviceid: 'x', apikey: 'k' }, null, '43', 2);
    await sleep(150);
    c._processMsg({ sequence: '43', error: 503 });
    assert.equal(await p2, 'offline');
});

// ------------------------------------------------- Integration (LAN) ----
function fakeDevice(deviceid, devicekey) {
    const state = { switches: [{ outlet: 0, switch: 'off' }, { outlet: 1, switch: 'off' }], sledOnline: 'on' };
    const reqs = [];
    const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
            const j = JSON.parse(body);
            const data = j.encrypt ? crypto.decryptMsg(j, devicekey) : j.data;
            reqs.push({ url: req.url, data });
            for (const [k, v] of Object.entries(data)) {
                if (k === 'switches') for (const s of v) state.switches.find(x => x.outlet === s.outlet).switch = s.switch;
                else state[k] = v;
            }
            const reply = crypto.encryptPayload({ seq: 7, error: 0, data: state }, devicekey);
            delete reply.encrypt;
            res.end(JSON.stringify(reply));
        });
    });
    return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port, reqs, state })));
}

test('Integration: Adapter steuert verschlüsseltes LAN-Gerät (2 Kanäle)', async () => {
    const did = '1000abcdef';
    const key = 'f0e1d2c3-aaaa-bbbb-cccc-123456789abc';
    const dev = await fakeDevice(did, key);
    const factory = require('../main.js');
    const a = factory({ config: { mode: 'local', devices: [{ deviceid: did, devicekey: key, host: `127.0.0.1:${dev.port}`, uiid: 2, name: 'Testschalter' }] } });
    a.emit('ready');
    await sleep(800);
    try {
        // Ping hat Gerät als LAN-online markiert?
        assert.equal(a.val(`${did}.info.uiid`), 2);
        if (!a.local.online) console.log('  (Hinweis: mDNS im Testsystem nicht verfügbar – LAN-Test nutzt nur HTTP)');
        a.local.online = true;
        await a.localLoop();
        await sleep(300);
        assert.equal(a.val(`${did}.info.local`), true, 'LAN erreichbar');
        assert.equal(a.val(`${did}.info.connection`), 'local');

        // Kanal 1 + 2 schalten (gebündelt)
        await a.setStateAsync(`${did}.channel1`, true, false);
        await a.setStateAsync(`${did}.channel2`, true, false);
        await sleep(600);
        const sw = dev.reqs.filter(r => r.url === '/zeroconf/switches');
        assert.equal(sw.length, 1, 'genau ein gebündelter Befehl');
        assert.equal(sw[0].data.switches.length, 2);
        assert.deepEqual(a.states[`sonofflan.0.${did}.channel1`], { val: true, ack: true });
        assert.deepEqual(a.states[`sonofflan.0.${did}.channel2`], { val: true, ack: true });

        // mDNS-Nachricht (verschlüsselt) verarbeiten
        const enc = crypto.encryptPayload({ data: { switches: [{ outlet: 0, switch: 'off' }] } }, key);
        await a.onLocalUpdate({ deviceid: did, localtype: 'strip', seq: '9', host: `127.0.0.1:${dev.port}`, data: enc.data, iv: enc.iv });
        assert.equal(a.val(`${did}.channel1`), false);

        // raw.command
        await a.setStateAsync(`${did}.raw.command`, '{"sledOnline":"off"}', false);
        await sleep(300);
        assert.equal(dev.reqs.at(-1).url, '/zeroconf/sledOnline');
        assert.equal(a.val(`${did}.led`), false);

        // neues DIY-Gerät über mDNS
        await a.onLocalUpdate({ deviceid: '1000diy001', localtype: 'diy_plug', seq: '1', host: '127.0.0.1:1', params: { switch: 'on' } });
        assert.equal(a.val('1000diy001.switch'), true);
        assert.equal(a.val('1000diy001.info.model'), 'MINI DIY');

        // unbekanntes verschlüsseltes Gerät → nur Hinweis
        await a.onLocalUpdate({ deviceid: '1000xxxxxx', localtype: 'plug', seq: '1', data: 'abc', iv: 'abc' });
        assert.ok(a.logs.some(l => l[1].includes('1000xxxxxx')));
        assert.ok(!a.logs.some(l => l[0] === 'error'), 'keine Fehler im Log');
    } finally {
        await new Promise(r => a.onUnload(r));
        dev.srv.close();
    }
});

(async () => {
    for (const [name, fn] of tests) {
        try {
            await fn();
            passed++;
            console.log(`✔ ${name}`);
        } catch (e) {
            console.log(`✘ ${name}\n  ${e.stack}`);
            process.exitCode = 1;
        }
    }
    console.log(`\n${passed}/${tests.length} Tests bestanden`);
    setTimeout(() => process.exit(process.exitCode || 0), 100);
})();
