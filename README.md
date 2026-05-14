# EcoTrack OS — IoT Bridge Backend

Railway-deployable Node.js backend for the EcoTrack OS frontend.

## What it provides

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/status` | GET | Health check — returns version & uptime |
| `/api/v1/live` | GET | Real-time sensor snapshot (kW, solar, diesel, fleet) |
| `/api/v1/monthly?month=YYYY-MM` | GET | Monthly accumulations + full-month projections |
| `/api/v1/readings` | POST | Ingest sensor push from hardware/MQTT |
| `/api/v1/devices` | GET | List registered IoT devices |
| `/ws` | WebSocket | Live event stream (METER_UPDATE, SOLAR_UPDATE, etc.) |

---

## Deploy on Railway (5 minutes)

### Option A — GitHub (recommended)

1. Push this folder to a GitHub repo (can be private).
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
3. Select your repo → Railway auto-detects Node.js and deploys.
4. In the Railway dashboard → **Settings** → **Networking** → click **Generate Domain**.  
   You'll get a URL like `https://ecotrack-iot-bridge-production.up.railway.app`.
5. (Optional) Add an environment variable `API_KEY=your-secret` for auth.

### Option B — Railway CLI

```bash
npm install -g @railway/cli
railway login
railway init        # link or create project
railway up          # deploy
railway domain      # generate public URL
```

---

## Connect to the EcoTrack Frontend

Once deployed, copy your Railway URL (e.g. `https://my-bridge.up.railway.app`).

In the EcoTrack OS dashboard:

1. Click the **IoT** button in the top nav.
2. Paste your URL into **REST Endpoint**: `https://my-bridge.up.railway.app`
3. Paste WebSocket URL: `wss://my-bridge.up.railway.app/ws`
4. Click **Test Connection** — should show ✅.
5. Click **Save & Connect**.

The dashboard will auto-fill form fields from live IoT data.

---

## Push real sensor data

```bash
curl -X POST https://YOUR-DOMAIN.up.railway.app/api/v1/readings \
  -H "Content-Type: application/json" \
  -d '{"device_id":"METER_01","type":"kwh_grid","value":4.5,"unit":"kWh"}'
```

Supported `type` values: `kwh_grid`, `kwh_solar`, `litres_diesel`, `km_fleet`

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Auto-set by Railway |
| `API_KEY` | *(empty)* | Optional — set to require `X-API-Key` header |
