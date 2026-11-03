'use strict';

let lastSeq = 0;

/** Eindeutige Sequenznummer in ms (wie im Original). */
function nextSequence() {
    const t = Date.now();
    lastSeq = t > lastSeq ? t : lastSeq + 1;
    return String(lastSeq);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Lineare Umrechnung mit Begrenzung (entspricht conv() aus SonoffLAN). */
function conv(value, a1, a2, b1, b2) {
    let v = Math.round(((value - a1) / (a2 - a1)) * (b2 - b1) + b1);
    const lo = Math.min(b1, b2);
    const hi = Math.max(b1, b2);
    if (v < lo) v = lo;
    if (v > hi) v = hi;
    return v;
}

/** Name für ioBroker-ID säubern. */
function safeId(s) {
    return String(s).replace(/[^A-Za-z0-9_-]/g, '_');
}

module.exports = { nextSequence, sleep, conv, safeId };
