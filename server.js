/**
 * EcoTrack OS — IoT Bridge Backend
 * Railway-ready Node.js server
 *
 * Endpoints the frontend calls:
 *   GET  /api/v1/status          — health check
 *   GET  /api/v1/live            — real-time sensor snapshot
 *   GET  /api/v1/monthly?month=  — monthly aggregated data
 *   POST /api/v1/readings        — ingest sensor push
 *   WS   /ws                     — live WebSocket broadcast
 */

const express    = require('express');
const http       = require('http');
const { WebSocketServer } = require('ws');
const cors       = require('cors');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

const PORT      = process.env.PORT || 3001;
const API_KEY   = process.env.API_KEY || '';          // set in Railway env vars — leave blank to disable auth
const START_TS  = Date.now();

app.use(cors({ origin: '*' }));
app.use(express.json());

/* ─── Optional API-key auth ─── */
function checkAuth(req, res, next) {
  if (!API_KEY) return next();                          // no key configured → open
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

/* ══════════════════════════════════════════════
   IN-MEMORY STATE
   Simulates real IoT sensor readings.
   When actual sensors push data via POST /api/v1/readings
   these are updated and broadcast over WebSocket.
══════════════════════════════════════════════ */
let liveState = {
  ts: new Date().toISOString(),
  devices: [
    { id: 'METER_01', type: 'smart_meter',   label: 'Main Grid Meter',   online: true },
    { id: 'SOLAR_01', type: 'solar_inverter', label: 'Rooftop Inverter',  online: true },
    { id: 'DIESEL_01',type: 'diesel_sensor',  label: 'Genset Flow Meter', online: true },
    { id: 'FLEET_01', type: 'fleet_tracker',  label: 'Fleet GPS Hub',     online: true },
  ],
  totals: {
    kw_demand_grid:  18.4,    // kW live grid draw
    kw_solar_now:    4.2,     // kW solar generation right now
    diesel_lph:      3.8,     // litres/hour diesel
    fleet_km_today:  142,     // km covered by fleet today
  },
};

// Monthly accumulators — updated on each POST /readings or every simulated tick
let monthlyAccumulators = {};   // keyed by "YYYY-MM"

function getMonthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function getOrInitMonth(key) {
  if (!monthlyAccumulators[key]) {
    monthlyAccumulators[key] = {
      kwh_grid:      0,
      kwh_solar:     0,
      litres_diesel: 0,
      km_fleet:      0,
      readings:      0,
      first_ts:      new Date().toISOString(),
    };
  }
  return monthlyAccumulators[key];
}

/* Seed current month with realistic UP-manufacturing defaults so the
   dashboard shows data immediately on first connect. */
(function seedCurrentMonth() {
  const key = getMonthKey();
  const m   = getOrInitMonth(key);
  if (m.readings === 0) {
    // Partial-month values — scale with days elapsed
    const now         = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysPassed  = now.getDate();
    const ratio       = daysPassed / daysInMonth;

    m.kwh_grid      = Math.round(18500 * ratio);
    m.kwh_solar     = Math.round(1200  * ratio);
    m.litres_diesel = Math.round(380   * ratio);
    m.km_fleet      = Math.round(4200  * ratio);
    m.readings      = daysPassed * 96;          // ~96 readings/day (15-min intervals)
  }
})();

/* ══════════════════════════════════════════════
   SIMULATION TICK  (every 30s)
   Adds small realistic increments so the live
   panel updates even without real sensors.
══════════════════════════════════════════════ */
function simulateTick() {
  const key = getMonthKey();
  const m   = getOrInitMonth(key);

  // Gaussian-ish jitter for live kW values
  const jitter  = (base, pct) => +(base * (1 + (Math.random() - 0.5) * pct)).toFixed(2);
  const hour    = new Date().getHours();
  const solarOn = hour >= 6 && hour <= 18;

  liveState.ts                      = new Date().toISOString();
  liveState.totals.kw_demand_grid   = jitter(18.4, 0.15);
  liveState.totals.kw_solar_now     = solarOn ? jitter(4.2, 0.25) : 0.0;
  liveState.totals.diesel_lph       = jitter(3.8, 0.10);
  liveState.totals.fleet_km_today  += +(Math.random() * 0.8).toFixed(1);   // +0–0.8 km/30s

  // Accumulate into monthly (15-min equivalent = 0.25h per 30s tick scaled down)
  const dT = 30 / 3600;   // hours in this tick
  m.kwh_grid      += +(liveState.totals.kw_demand_grid  * dT).toFixed(4);
  m.kwh_solar     += +(liveState.totals.kw_solar_now    * dT).toFixed(4);
  m.litres_diesel += +(liveState.totals.diesel_lph      * dT).toFixed(4);
  m.km_fleet      += liveState.totals.fleet_km_today > 0 ? +(Math.random() * 0.1).toFixed(3) : 0;
  m.readings++;

  // Broadcast to all connected WS clients
  broadcast({ type: 'METER_UPDATE', ts: liveState.ts, totals: liveState.totals });
}

setInterval(simulateTick, 30_000);

/* ══════════════════════════════════════════════
   WEBSOCKET
══════════════════════════════════════════════ */
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(ws => {
    if (ws.readyState === 1 /* OPEN */) ws.send(msg);
  });
}

wss.on('connection', (ws, req) => {
  console.log(`[WS] client connected (total: ${wss.clients.size})`);

  // Send current live state immediately on connect
  ws.send(JSON.stringify({ type: 'INIT', ...liveState }));

  ws.on('close', () =>
    console.log(`[WS] client disconnected (total: ${wss.clients.size})`)
  );
  ws.on('error', err => console.warn('[WS] error:', err.message));
});

/* ══════════════════════════════════════════════
   REST ENDPOINTS
══════════════════════════════════════════════ */

/* ── Health / status ── */
app.get('/api/v1/status', checkAuth, (req, res) => {
  res.json({
    ok:           true,
    service:      'EcoTrack IoT Bridge',
    version:      '1.2.0',
    uptime_s:     Math.round((Date.now() - START_TS) / 1000),
    ws_clients:   wss.clients.size,
    capabilities: ['smart_meter', 'solar_inverter', 'diesel_flow', 'fleet_gps'],
    ts:           new Date().toISOString(),
  });
});

/* ── Live sensor snapshot ── */
app.get('/api/v1/live', checkAuth, (req, res) => {
  res.json(liveState);
});

/* ── Monthly aggregated data ── */
app.get('/api/v1/monthly', checkAuth, (req, res) => {
  const month = req.query.month || getMonthKey();
  const m     = getOrInitMonth(month);

  // Project to end-of-month if partial
  const [y, mo] = month.split('-').map(Number);
  const daysInMonth = new Date(y, mo, 0).getDate();
  const now         = new Date();
  const isCurrentMonth = (y === now.getFullYear() && mo === now.getMonth() + 1);
  const daysPassed  = isCurrentMonth ? now.getDate() : daysInMonth;
  const projFactor  = daysInMonth / Math.max(daysPassed, 1);

  res.json({
    month,
    // Actual accumulated values
    kwh_grid:             +m.kwh_grid.toFixed(1),
    kwh_solar:            +m.kwh_solar.toFixed(1),
    litres_diesel:        +m.litres_diesel.toFixed(1),
    km_fleet:             +m.km_fleet.toFixed(1),
    readings:             m.readings,
    first_ts:             m.first_ts,
    // Projected full-month values (what the frontend uses for form auto-fill)
    projected_kwh_grid:   Math.round(m.kwh_grid      * projFactor),
    projected_kwh_solar:  Math.round(m.kwh_solar     * projFactor),
    projected_litres_diesel: Math.round(m.litres_diesel * projFactor),
    projected_km_fleet:   Math.round(m.km_fleet      * projFactor),
    projection_factor:    +projFactor.toFixed(3),
    days_elapsed:         daysPassed,
    days_in_month:        daysInMonth,
    ts:                   new Date().toISOString(),
  });
});

/* ── Ingest sensor reading (push from hardware / MQTT bridge) ──
   Body: { device_id, type, value, unit, ts? }
   Examples:
     { device_id: "METER_01", type: "kwh_grid",      value: 4.5,  unit: "kWh" }
     { device_id: "SOLAR_01", type: "kwh_solar",     value: 0.3,  unit: "kWh" }
     { device_id: "DIESEL_01",type: "litres_diesel", value: 2.1,  unit: "L"   }
     { device_id: "FLEET_01", type: "km_fleet",      value: 15,   unit: "km"  }
*/
app.post('/api/v1/readings', checkAuth, (req, res) => {
  const { device_id, type, value, unit, ts } = req.body || {};
  if (!type || value == null) {
    return res.status(400).json({ error: 'type and value are required' });
  }

  const key = getMonthKey(ts ? new Date(ts) : undefined);
  const m   = getOrInitMonth(key);
  const v   = parseFloat(value);
  if (isNaN(v)) return res.status(400).json({ error: 'value must be numeric' });

  // Accumulate
  if (type === 'kwh_grid')        m.kwh_grid      += v;
  else if (type === 'kwh_solar')  m.kwh_solar     += v;
  else if (type === 'litres_diesel') m.litres_diesel += v;
  else if (type === 'km_fleet')   m.km_fleet      += v;
  m.readings++;

  // Update live totals (simple running average)
  if (type === 'kwh_grid')   liveState.totals.kw_demand_grid = +(v * 4).toFixed(2);  // kWh→kW (15-min)
  if (type === 'kwh_solar')  liveState.totals.kw_solar_now   = +(v * 4).toFixed(2);
  if (type === 'litres_diesel') liveState.totals.diesel_lph  = +(v * 4).toFixed(2);
  if (type === 'km_fleet')   liveState.totals.fleet_km_today = +m.km_fleet.toFixed(1);
  liveState.ts = new Date().toISOString();

  // Broadcast the appropriate WS event
  const wsTypeMap = {
    kwh_grid:      'METER_UPDATE',
    kwh_solar:     'SOLAR_UPDATE',
    litres_diesel: 'DIESEL_UPDATE',
    km_fleet:      'FLEET_UPDATE',
  };
  broadcast({ type: wsTypeMap[type] || 'METER_UPDATE', ts: liveState.ts, totals: liveState.totals });

  res.json({ ok: true, month: key, accumulated: { [type]: +m[type]?.toFixed(2) } });
});

/* ── List devices ── */
app.get('/api/v1/devices', checkAuth, (req, res) => {
  res.json({ devices: liveState.devices, ts: new Date().toISOString() });
});

/* ── Reset monthly accumulators (admin / testing) ── */
app.post('/api/v1/admin/reset', checkAuth, (req, res) => {
  const key = req.body?.month || getMonthKey();
  delete monthlyAccumulators[key];
  res.json({ ok: true, reset: key });
});

/* ── Root / ping ── */
app.get('/', (req, res) => {
  res.send(`
    <html><head><title>EcoTrack IoT Bridge</title></head>
    <body style="font-family:sans-serif;padding:40px;background:#050d08;color:#a3e635">
      <h1>🌱 EcoTrack IoT Bridge</h1>
      <p style="color:#22c55e">Status: <strong>Running</strong></p>
      <ul style="color:#e2f5e9;line-height:2">
        <li>GET  <a style="color:#4ade80" href="/api/v1/status">/api/v1/status</a></li>
        <li>GET  <a style="color:#4ade80" href="/api/v1/live">/api/v1/live</a></li>
        <li>GET  <a style="color:#4ade80" href="/api/v1/monthly">/api/v1/monthly</a></li>
        <li>GET  <a style="color:#4ade80" href="/api/v1/devices">/api/v1/devices</a></li>
        <li>POST /api/v1/readings  (sensor push)</li>
        <li>WS   /ws               (live stream)</li>
      </ul>
    </body></html>
  `);
});

/* ══════════════════════════════════════════════
   START
══════════════════════════════════════════════ */
server.listen(PORT, () => {
  console.log(`✅ EcoTrack IoT Bridge listening on port ${PORT}`);
  console.log(`   REST  → http://localhost:${PORT}/api/v1/status`);
  console.log(`   WS    → ws://localhost:${PORT}/ws`);
  if (API_KEY) console.log(`   Auth  → X-API-Key required`);
  else         console.log(`   Auth  → open (no API key set)`);
});
