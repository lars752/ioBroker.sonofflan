'use strict';
/**
 * Kryptografie für eWeLink Cloud (HMAC-Signatur) und LAN (AES-128-CBC).
 * Portiert aus AlexxIT/SonoffLAN (MIT), core/ewelink/cloud.py und local.py.
 */
const crypto = require('node:crypto');
const { REGIONS } = require('./regions');

const DEFAULT_APP_ID = 'R8Oq3y0eSZSYdKccHlrQzT1ACCOUT9Gv';

let derivedSecret = null;

/** Python-repr() der REGIONS-Tabelle nachbauen (Grundlage der Schlüsselableitung). */
function regionsRepr() {
    return '{' + REGIONS.map(([code, name, region]) => `'${code}': ('${name}', '${region}')`).join(', ') + '}';
}

/** App-Secret wie im Original-Integrationscode ableiten. */
function getDefaultSecret() {
    if (derivedSecret) return derivedSecret;
    const a = Buffer.from(Buffer.from(regionsRepr(), 'utf8').toString('base64'), 'utf8');
    const s = Buffer.from('L8KDAMO6wpomxpYZwrHhu4AuEjQKBy8nwoMHNB7DmwoWwrvCsSYGw4wDAxs=', 'base64').toString('utf8');
    const out = [];
    for (const ch of s) out.push(a[ch.codePointAt(0)]);
    derivedSecret = Buffer.from(out);
    return derivedSecret;
}

/**
 * @param {Buffer|string} msg
 * @param {string} [secret] eigenes App-Secret (optional)
 * @returns {string} Base64-HMAC-SHA256
 */
function sign(msg, secret) {
    const key = secret ? Buffer.from(secret, 'utf8') : getDefaultSecret();
    return crypto.createHmac('sha256', key).update(msg).digest('base64');
}

/** LAN-Payload verschlüsseln (Feld data → Base64-Ciphertext, iv, encrypt=true). */
function encryptPayload(payload, devicekey) {
    const plaintext = Buffer.from(JSON.stringify(payload.data), 'utf8');
    const key = crypto.createHash('md5').update(devicekey, 'utf8').digest();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { ...payload, encrypt: true, data: enc.toString('base64'), iv: iv.toString('base64') };
}

/** LAN-Nachricht entschlüsseln. Gibt Objekt zurück (leer bei fehlenden Daten). */
function decryptMsg(msg, devicekey) {
    if (!msg || !msg.data) return {};
    const key = crypto.createHash('md5').update(devicekey, 'utf8').digest();
    const iv = Buffer.from(msg.iv, 'base64');
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    let buf = Buffer.concat([decipher.update(Buffer.from(msg.data, 'base64')), decipher.final()]);
    let txt = buf.toString('utf8');
    // RF-Bridge Syntaxfehler {"rfList"="..."} korrigieren
    if (txt.startsWith('{"rf')) txt = txt.split('"="').join('":"');
    // https://github.com/AlexxIT/SonoffLAN/issues/1160
    txt = txt.replace(/\x02+$/, '');
    return JSON.parse(txt);
}

module.exports = { DEFAULT_APP_ID, sign, encryptPayload, decryptMsg, regionsRepr };
