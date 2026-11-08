// Tires page - TPMS module: per-wheel pressure, alarm limits, sensor pairing
import { TireMonitor } from '../components/tire-monitor.js';

let tireMonitor = null;

export const tiresPage = {
    render() {
        return `
            <section class="page-tires">
                <h1 class="section-title">Tires</h1>
                <div id="tires-container"></div>
            </section>
        `;
    },

    init() {
        // Readings arrive via WebSocket from the TPMS module on the CAN bus.
        // Shows "--" until the module reports.
        tireMonitor = new TireMonitor('tires-container');
        document.getElementById('tires-container').innerHTML = tireMonitor.render();
        tireMonitor.init();
    },

    cleanup() {
        if (tireMonitor) {
            tireMonitor.cleanup();
            tireMonitor = null;
        }
    }
};
