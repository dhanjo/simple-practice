# SimplePractice Appointment Reschedule API

Automates rescheduling appointments in SimplePractice via a REST API. Uses Playwright to drive the browser headlessly on a VPS.

---

## Setup

### Prerequisites

- **Node.js** ≥ 18
- **Linux VPS** (tested on Debian 12 / Ubuntu)

### Installation

```bash
# 1. Clone the repo
git clone https://github.com/dhanjo/simple-practice.git
cd simple-practice

# 2. Install dependencies
npm install

# 3. Install Chromium + OS-level deps (required for headless browser)
npx playwright install chromium
npx playwright install-deps

# 4. Create logs directory
mkdir -p logs

# 5. Start the server with PM2
npx pm2 start ecosystem.config.js
npx pm2 save
```

### Useful PM2 Commands

```bash
npx pm2 status                        # Check if server is running
npx pm2 logs simple-practice-api      # View live logs
npx pm2 restart simple-practice-api   # Restart after code changes
npx pm2 stop simple-practice-api      # Stop the server
```

### Environment Variables (optional)

| Variable  | Default                      | Description          |
|-----------|------------------------------|----------------------|
| `PORT`    | `3000`                       | Server port          |
| `API_KEY` | `sp-reschedule-2026-secure`  | API authentication key |

Set via `.env` file or in `ecosystem.config.js`.

---

## Endpoints

### `POST /api/reschedule`

Reschedules an existing SimplePractice appointment.

#### Headers

| Header         | Required | Value                        |
|----------------|----------|------------------------------|
| `Content-Type` | Yes      | `application/json`           |
| `X-API-Key`    | Yes      | Your API key (default: `sp-reschedule-2026-secure`) |

#### Request Body

| Field                    | Type     | Required | Format        | Description |
|--------------------------|----------|----------|---------------|-------------|
| `spEmail`                | `string` | ✅ Yes   | Email address | SimplePractice login email for the clinic |
| `spPassword`             | `string` | ✅ Yes   | —             | SimplePractice login password |
| `clientSearch`           | `string` | ✅ Yes   | Phone or name | Client identifier to search in SimplePractice |
| `newDate`                | `string` | ✅ Yes   | `MM/DD/YYYY`  | New appointment date |
| `newTime`                | `string` | ✅ Yes   | `HH:MM AM/PM` | New appointment time |
| `currentAppointmentDate` | `string` | ❌ No    | `MM/DD/YYYY`  | Target a specific appointment by its current date. If omitted, the first upcoming appointment is selected. |

#### Example Request

```bash
curl -X POST http://YOUR_VPS_IP:3000/api/reschedule \
  -H "Content-Type: application/json" \
  -H "X-API-Key: sp-reschedule-2026-secure" \
  -d '{
    "spEmail": "clinic@example.com",
    "spPassword": "your-password",
    "clientSearch": "7993499349",
    "currentAppointmentDate": "03/05/2026",
    "newDate": "03/10/2026",
    "newTime": "02:00 PM"
  }'
```

#### Success Response — `200 OK`

```json
{
  "success": true,
  "requestId": "d564eb09a89c",
  "message": "Appointment rescheduled to 03/10/2026 at 02:00 PM",
  "duration": 54
}
```

#### Error Responses

| Status | Condition | Example `error` |
|--------|-----------|-----------------|
| `400`  | Missing or invalid fields | `"Missing required fields: spEmail, spPassword, clientSearch, newDate, newTime"` |
| `400`  | Bad date format | `"newDate must be in MM/DD/YYYY format (e.g. \"03/05/2026\")"` |
| `400`  | Bad time format | `"newTime must be in HH:MM AM/PM format (e.g. \"03:00 PM\")"` |
| `401`  | Missing/wrong API key | `"Invalid or missing API key"` |
| `429`  | Queue is full (50 max) | `"Queue is full (50 pending). Try again later."` |
| `500`  | Automation failed | See table below |

#### Automation Error Messages

| Error | Meaning |
|-------|---------|
| `No upcoming appointments found for client "..."` | Client exists but has no future appointments |
| `No appointment found matching date "..." for client "..."` | `currentAppointmentDate` didn't match any appointment |
| `Login timed out. SimplePractice may be slow or credentials may be incorrect.` | Login page didn't redirect after sign-in |
| `Page took too long to load. SimplePractice may be experiencing slowness.` | Page load timeout |
| `Operation timed out. SimplePractice may be slow or unresponsive. Please try again.` | Generic timeout |

---

### `GET /api/health`

Returns server status and processing stats. **No authentication required.**

#### Example Request

```bash
curl http://YOUR_VPS_IP:3000/api/health
```

#### Response — `200 OK`

```json
{
  "status": "ok",
  "uptime": 3600,
  "isRunning": false,
  "queueLength": 0,
  "startedAt": null,
  "stats": {
    "totalProcessed": 5,
    "totalSuccess": 4,
    "totalFailed": 1
  },
  "lastResult": {
    "success": true,
    "requestId": "d564eb09a89c",
    "clientSearch": "7993499349",
    "duration": 54,
    "finishedAt": "2026-03-02T15:30:00.000Z"
  }
}
```

| Field         | Description |
|---------------|-------------|
| `uptime`      | Server uptime in seconds |
| `isRunning`   | `true` if a reschedule is currently in progress |
| `queueLength` | Number of requests waiting to be processed |
| `startedAt`   | ISO timestamp of the currently running job (or `null`) |
| `stats`       | Cumulative counts since last restart |
| `lastResult`  | Summary of the most recent completed request |

---

## Important Notes

- **Sequential processing** — Only one browser runs at a time. Requests are queued and processed in order.
- **Response time** — Expect ~50–70 seconds per request. Plan for up to 90s in your integration timeout settings.
- **Queue limit** — Max 50 pending requests. Returns `429` if exceeded.
- **Queue timeout** — Requests waiting longer than 10 minutes are automatically removed.
- **Credentials** — `spEmail` and `spPassword` are per-request. Store them securely on your backend (e.g. Supabase) and pass them at call time. They are never stored by this API.

