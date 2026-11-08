// Tire monitor — TPMS module readings, alarm limits and sensor pairing.
//
// Live data arrives over WebSocket from the CAN bridge (CAN 0x46-0x4B):
//   tpms_wheel     { wheel, position, psi, temp_c, battery_pct, alarms, seconds_since_seen, paired }
//   tpms_summary   { level: 0 ok | 1 warning | 2 critical, target_psi, ... }
//   tpms_config    the module's alarm limits (it owns them; we only send commands)
//   tpms_pairing   { wheel, address, learning }
//   tpms_candidate { address, rssi_dbm, psi } — unpaired sensors, learn mode only
import { API, wsClient } from '../api.js';
import { units } from '../services/units.js';

const WHEELS = ['Left front', 'Right front', 'Left rear', 'Right rear'];

const ALARM_TEXT = {
    low_crit: 'Low (critical)', fast_leak: 'Fast leak', temp_high: 'Hot',
    low_warn: 'Low', high: 'High', imbalance: 'Uneven vs tandem partner',
    sensor_lost: 'No signal', batt_low: 'Sensor battery low'
};
const CRITICAL = new Set(['low_crit', 'fast_leak', 'temp_high']);

const LIMITS = [
    { key: 'target_psi',     label: 'Target cold pressure',       unit: 'psi', step: 1 },
    { key: 'low_warn_pct',   label: 'Low warning below target',   unit: '%',   step: 1 },
    { key: 'low_crit_pct',   label: 'Low critical below target',  unit: '%',   step: 1 },
    { key: 'high_pct',       label: 'High above target',          unit: '%',   step: 1 },
    { key: 'fast_leak_psi',  label: 'Fast leak: drop in 60 s',    unit: 'psi', step: 0.1 },
    { key: 'temp_high_c',    label: 'Hot at',                     unit: '°C',  step: 1 },
    { key: 'lost_after_min', label: 'No signal after',            unit: 'min', step: 1 },
    { key: 'imbalance_psi',  label: 'Uneven vs tandem partner',   unit: 'psi', step: 1 }
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function wheelLevel(w) {
    if (!w || !w.alarms) return null;
    const active = Object.keys(w.alarms).filter(k => w.alarms[k]);
    if (active.some(k => CRITICAL.has(k))) return 'critical';
    return active.length ? 'warning' : 'ok';
}

export class TireMonitor {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.wheels = {};
        this.summary = null;
        this.config = null;
        this.pairing = {};
        this.candidates = {};      // address -> { address, rssi_dbm, psi, at }
        this.handlers = [];
        this.unsubStale = null;
        this.candidateTimer = null;
    }

    render() {
        return `
            <div class="card tpms-summary" id="tpms-summary"></div>
            <div class="tpms-axles" id="tpms-wheels"></div>

            <h2 class="section-title tpms-subtitle">Alarm limits</h2>
            <div class="card">
                <p class="tpms-note">Stored on the TPMS module. Changes are sent to the module, and the values below are what it reports back.</p>
                <div class="tpms-limits" id="tpms-limits"></div>
                <div class="tpms-actions">
                    <button class="tpms-btn tpms-btn-secondary" id="tpms-reset-limits">Reset to module defaults</button>
                    <span class="tpms-status" id="tpms-limit-status"></span>
                </div>
            </div>

            <h2 class="section-title tpms-subtitle">Sensors</h2>
            <div class="card">
                <div id="tpms-pairing"></div>
                <div class="tpms-actions">
                    <button class="tpms-btn" id="tpms-learn">Find sensors (2 min)</button>
                    <span class="tpms-status" id="tpms-pair-status"></span>
                </div>
                <div id="tpms-candidates"></div>
            </div>
        `;
    }

    async init() {
        try {
            const state = await API.getTpms();
            Object.assign(this.wheels, state.wheels || {});
            Object.assign(this.pairing, state.pairing || {});
            this.summary = state.summary;
            this.config = state.config;
        } catch (e) { /* no data yet: shows "--" until the module reports */ }
        this.paintAll();

        const on = (type, fn) => { wsClient.on(type, fn); this.handlers.push([type, fn]); };
        on('tpms_wheel', (d) => { if (d) { this.wheels[d.wheel] = d; this.paintWheels(); } });
        on('tpms_summary', (d) => { this.summary = d; this.paintSummary(); });
        on('tpms_config', (d) => { this.config = d; this.paintLimits(); });
        on('tpms_pairing', (d) => { if (d) { this.pairing[d.wheel] = d; this.paintPairing(); } });
        on('tpms_candidate', (d) => {
            if (d && d.address) { this.candidates[d.address] = { ...d, at: Date.now() }; this.paintCandidates(); }
        });
        this.unsubStale = wsClient.onStale('tpms_summary', () => {
            this.summary = null; this.wheels = {}; this.paintSummary(); this.paintWheels();
        }, 15000);
        this.candidateTimer = setInterval(() => this.paintCandidates(), 3000);
        this.bindStatic();
    }

    paintAll() {
        this.paintSummary(); this.paintWheels(); this.paintLimits(); this.paintPairing(); this.paintCandidates();
    }

    paintSummary() {
        const el = document.getElementById('tpms-summary');
        if (!el) return;
        const s = this.summary;
        const word = !s ? 'Waiting for the TPMS module' : ['All tires OK', 'Warning', 'Critical'][s.level] || '--';
        const cls = !s ? '' : ['ok', 'warning', 'critical'][s.level] || '';
        el.className = `card tpms-summary ${cls}`;
        el.innerHTML = `<span class="tpms-summary-word">${word}</span>
            <span class="tpms-summary-target">${s ? `Target ${s.target_psi} psi cold` : ''}</span>`;
    }

    paintWheels() {
        const el = document.getElementById('tpms-wheels');
        if (!el) return;
        const card = (i) => {
            const w = this.wheels[i];
            const paired = this.pairing[i] ? !!this.pairing[i].address : (w ? w.paired : null);
            const level = wheelLevel(w);
            const active = w && w.alarms ? Object.keys(ALARM_TEXT).filter(k => w.alarms[k]) : [];
            const tempF = w && w.temp_c !== null && w.temp_c !== undefined ? w.temp_c * 9 / 5 + 32 : null;
            const status = paired === false ? 'Not paired'
                : !w || w.psi === null ? 'No reading yet'
                : active.length ? active.map(k => ALARM_TEXT[k]).join(' · ') : 'OK';
            return `
                <div class="card tpms-wheel ${paired === false ? 'unpaired' : level || ''}">
                    <div class="tpms-wheel-name">${WHEELS[i]}</div>
                    <div class="tpms-wheel-psi">${w && w.psi !== null ? w.psi.toFixed(1) : '--'}<span>psi</span></div>
                    <div class="tpms-wheel-meta">
                        ${units.formatTemp(tempF)}${units.tempLabel()} ·
                        ${w && w.battery_pct !== null ? `${w.battery_pct}% battery` : '-- battery'}
                    </div>
                    <div class="tpms-wheel-status">${esc(status)}</div>
                    ${w && w.seconds_since_seen > 30 && paired !== false
                        ? `<div class="tpms-wheel-seen">Last heard ${w.seconds_since_seen >= 255 ? '4+ min' : `${w.seconds_since_seen} s`} ago</div>` : ''}
                </div>`;
        };
        el.innerHTML = `
            <div class="tpms-axle-label">Front axle</div>
            <div class="tpms-axle">${card(0)}${card(1)}</div>
            <div class="tpms-axle-label">Rear axle</div>
            <div class="tpms-axle">${card(2)}${card(3)}</div>`;
    }

    paintLimits() {
        const el = document.getElementById('tpms-limits');
        if (!el) return;
        if (!this.config) {
            el.innerHTML = '<p class="tpms-note">Waiting for the module to report its limits.</p>';
            return;
        }
        // Keep what the user is typing; repaint only rows not in focus.
        if (!el.querySelector('input')) {
            el.innerHTML = LIMITS.map(l => `
                <label class="tpms-limit-row">
                    <span>${l.label}</span>
                    <input class="form-input tpms-limit-input" type="number" step="${l.step}" data-limit="${l.key}">
                    <span class="tpms-limit-unit">${l.unit}</span>
                </label>`).join('');
            el.querySelectorAll('input[data-limit]').forEach((input) => {
                input.addEventListener('change', () => this.sendLimit(input));
            });
        }
        el.querySelectorAll('input[data-limit]').forEach((input) => {
            if (document.activeElement !== input) input.value = this.config[input.dataset.limit];
        });
    }

    async sendLimit(input) {
        const status = document.getElementById('tpms-limit-status');
        try {
            await API.tpmsSetLimit(input.dataset.limit, Number(input.value));
            status.textContent = 'Sent — the module confirms within a few seconds';
            // the module re-broadcasts at once; ask anyway in case that frame is missed
            setTimeout(() => API.tpmsRequest().catch(() => {}), 1500);
        } catch (e) {
            status.textContent = e.message;
            input.value = this.config ? this.config[input.dataset.limit] : '';
        }
        input.blur();
    }

    paintPairing() {
        const el = document.getElementById('tpms-pairing');
        if (!el) return;
        el.innerHTML = WHEELS.map((name, i) => {
            const p = this.pairing[i];
            return `
                <div class="tpms-pair-row">
                    <span class="tpms-pair-wheel">${name}</span>
                    <span class="tpms-pair-addr">${p ? (p.address || 'Not paired') : '--'}</span>
                    ${p && p.address ? `<button class="tpms-btn tpms-btn-secondary" data-unpair="${i}">Unpair</button>` : '<span></span>'}
                </div>`;
        }).join('');
        el.querySelectorAll('[data-unpair]').forEach((b) => b.addEventListener('click', async () => {
            const status = document.getElementById('tpms-pair-status');
            try { await API.tpmsUnpair(Number(b.dataset.unpair)); status.textContent = 'Unpair sent'; }
            catch (e) { status.textContent = e.message; }
        }));
        const learning = Object.values(this.pairing).some(p => p && p.learning);
        const btn = document.getElementById('tpms-learn');
        if (btn) btn.textContent = learning ? 'Stop finding sensors' : 'Find sensors (2 min)';
    }

    paintCandidates() {
        const el = document.getElementById('tpms-candidates');
        if (!el) return;
        const now = Date.now();
        for (const [a, c] of Object.entries(this.candidates)) if (now - c.at > 10000) delete this.candidates[a];
        const list = Object.values(this.candidates).sort((a, b) => b.rssi_dbm - a.rssi_dbm);
        const learning = Object.values(this.pairing).some(p => p && p.learning);
        if (!learning && !list.length) { el.innerHTML = ''; return; }
        if (!list.length) {
            el.innerHTML = '<p class="tpms-note">Looking for unpaired sensors… The closest sensor is usually the strongest signal. Or let a little air out of one tire and watch its pressure drop.</p>';
            return;
        }
        // Don't rebuild while a wheel is being picked.
        if (el.contains(document.activeElement)) return;
        el.innerHTML = `<p class="tpms-note">Sensors heard that aren't paired:</p>` + list.map(c => `
            <div class="tpms-pair-row">
                <span class="tpms-pair-addr">${esc(c.address)}</span>
                <span class="tpms-cand-meta">${c.rssi_dbm} dBm · ${c.psi !== null ? `${c.psi} psi` : '-- psi'}</span>
                <span class="tpms-cand-pair">
                    <select class="form-input" data-cand="${esc(c.address)}">
                        ${WHEELS.map((n, i) => `<option value="${i}">${n}</option>`).join('')}
                    </select>
                    <button class="tpms-btn" data-pair="${esc(c.address)}">Pair</button>
                </span>
            </div>`).join('');
        el.querySelectorAll('[data-pair]').forEach((b) => b.addEventListener('click', async () => {
            const sel = el.querySelector(`select[data-cand="${CSS.escape(b.dataset.pair)}"]`);
            const status = document.getElementById('tpms-pair-status');
            try {
                await API.tpmsPair(Number(sel.value), b.dataset.pair);
                status.textContent = `Pairing ${b.dataset.pair} to ${WHEELS[Number(sel.value)]}`;
                delete this.candidates[b.dataset.pair];
            } catch (e) { status.textContent = e.message; }
        }));
    }

    bindStatic() {
        document.getElementById('tpms-learn')?.addEventListener('click', async () => {
            const learning = Object.values(this.pairing).some(p => p && p.learning);
            const status = document.getElementById('tpms-pair-status');
            try {
                if (learning) { await API.tpmsLearnStop(); status.textContent = 'Stopped'; }
                else { await API.tpmsLearn(120); status.textContent = 'Listening for sensors for 2 minutes'; }
            } catch (e) { status.textContent = e.message; }
        });
        document.getElementById('tpms-reset-limits')?.addEventListener('click', async () => {
            const status = document.getElementById('tpms-limit-status');
            try { await API.tpmsResetLimits(); status.textContent = 'Reset sent'; }
            catch (e) { status.textContent = e.message; }
        });
    }

    cleanup() {
        for (const [t, fn] of this.handlers) wsClient.off(t, fn);
        this.handlers = [];
        if (this.unsubStale) this.unsubStale();
        if (this.candidateTimer) clearInterval(this.candidateTimer);
    }
}
