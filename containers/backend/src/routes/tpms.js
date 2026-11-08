const express = require('express');
const mqttService = require('../mqtt');

// TPMS (tire pressure) module. Live readings stream over WebSocket
// (tpms_wheel, tpms_summary, tpms_config, tpms_pairing, tpms_candidate).
// The module owns its alarm limits and wheel pairing (authoritative state
// owner, like Therma): these routes only send TpmsCommand (CAN 0x49); the
// module validates, clamps, saves and re-broadcasts what it accepted.

// SetLimit field ids and the API field names (units as in TpmsConfig 0x48,
// except fast_leak_psi which the API takes in psi and sends in 0.1 psi).
const LIMIT_FIELDS = {
    target_psi:     { id: 1, min: 20,  max: 150 },
    low_warn_pct:   { id: 2, min: 5,   max: 30 },
    low_crit_pct:   { id: 3, min: 10,  max: 50 },
    high_pct:       { id: 4, min: 10,  max: 50 },
    fast_leak_psi:  { id: 5, min: 0.5, max: 20, scale: 10 },
    temp_high_c:    { id: 6, min: 40,  max: 100 },
    lost_after_min: { id: 7, min: 1,   max: 60 },
    imbalance_psi:  { id: 8, min: 2,   max: 30 }
};

const CMD = { SET_LIMIT: 1, PAIR: 2, UNPAIR: 3, LEARN_START: 4, LEARN_STOP: 5, RESET_LIMITS: 6, REQUEST: 7 };

function parseWheel(value) {
    const wheel = Number(value);
    return Number.isInteger(wheel) && wheel >= 0 && wheel <= 3 ? wheel : null;
}

function parseAddress(value) {
    if (typeof value !== 'string') return null;
    const m = value.trim().match(/^([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})$/i);
    return m ? m.slice(1).map(h => parseInt(h, 16)) : null;
}

module.exports = () => {
    const router = express.Router();

    const send = (res, bytes, message) => {
        if (!mqttService.publishTpmsCommand(bytes)) {
            return res.status(503).json({ error: 'MQTT service not connected. Please try again later.' });
        }
        res.json({ success: true, message });
    };

    // GET /api/tpms — last decoded state (until the module next broadcasts)
    router.get('/', (req, res) => {
        res.json(mqttService.tpmsState);
    });

    // POST /api/tpms/limit { field, value }
    router.post('/limit', (req, res) => {
        const { field, value } = req.body || {};
        const spec = LIMIT_FIELDS[field];
        const num = Number(value);
        if (!spec) {
            return res.status(400).json({ error: `field must be one of: ${Object.keys(LIMIT_FIELDS).join(', ')}` });
        }
        if (!Number.isFinite(num) || num < spec.min || num > spec.max) {
            return res.status(400).json({ error: `${field} must be between ${spec.min} and ${spec.max}` });
        }
        const raw = Math.round(num * (spec.scale || 1));
        send(res, [CMD.SET_LIMIT, spec.id, (raw >> 8) & 0xFF, raw & 0xFF], `Limit ${field} sent`);
    });

    // POST /api/tpms/pair { wheel, address } — address "AA:BB:CC:DD:EE:FF"
    router.post('/pair', (req, res) => {
        const wheel = parseWheel(req.body && req.body.wheel);
        const addr = parseAddress(req.body && req.body.address);
        if (wheel === null) return res.status(400).json({ error: 'wheel must be 0-3' });
        if (!addr || addr.every(b => b === 0)) return res.status(400).json({ error: 'address must be a sensor address like 80:EA:CA:00:00:10' });
        send(res, [CMD.PAIR, wheel, ...addr], 'Pair command sent');
    });

    // POST /api/tpms/unpair { wheel }
    router.post('/unpair', (req, res) => {
        const wheel = parseWheel(req.body && req.body.wheel);
        if (wheel === null) return res.status(400).json({ error: 'wheel must be 0-3' });
        send(res, [CMD.UNPAIR, wheel], 'Unpair command sent');
    });

    // POST /api/tpms/learn { seconds } — report unpaired sensors on tpms_candidate
    router.post('/learn', (req, res) => {
        const seconds = req.body && req.body.seconds !== undefined ? Number(req.body.seconds) : 120;
        if (!Number.isInteger(seconds) || seconds < 0 || seconds > 255) {
            return res.status(400).json({ error: 'seconds must be 0-255 (0 = module default)' });
        }
        send(res, [CMD.LEARN_START, seconds], 'Learn mode started');
    });

    // POST /api/tpms/learn/stop
    router.post('/learn/stop', (req, res) => send(res, [CMD.LEARN_STOP], 'Learn mode stopped'));

    // POST /api/tpms/reset-limits — firmware defaults, pairing kept
    router.post('/reset-limits', (req, res) => send(res, [CMD.RESET_LIMITS], 'Limits reset to module defaults'));

    // POST /api/tpms/request — ask for an immediate limits + pairing broadcast
    router.post('/request', (req, res) => send(res, [CMD.REQUEST], 'Re-broadcast requested'));

    return router;
};
