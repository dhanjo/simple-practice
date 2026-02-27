import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { rescheduleAppointment, RescheduleParams, RescheduleResult } from './automation/rescheduleAppointment';

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'sp-reschedule-2026-secure';
const MAX_QUEUE_SIZE = 50;
const QUEUE_WAIT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min max wait in queue

app.use(cors());
app.use(express.json());

/* ── State ────────────────────────────────────────────────────────── */

interface QueueItem {
  id: string;
  params: RescheduleParams;
  resolve: (result: RunResult) => void;
  queuedAt: Date;
  timedOut: boolean;
}

interface RunResult {
  success: boolean;
  requestId: string;
  message?: string;
  error?: string;
  duration: number;
}

let isRunning = false;
let startedAt: Date | null = null;
const bootTime = new Date();

// Stats
let totalProcessed = 0;
let totalSuccess = 0;
let totalFailed = 0;
let lastResult: (RunResult & { clientSearch: string; finishedAt: string }) | null = null;

// Request queue — sequential processing, one browser at a time
const queue: QueueItem[] = [];

/* ── Helpers ──────────────────────────────────────────────────────── */

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function generateRequestId(): string {
  return crypto.randomBytes(6).toString('hex');
}



/* ── Request logging middleware ────────────────────────────────────── */

app.use((req, _res, next) => {
  log(`${req.method} ${req.path}`);
  next();
});

/* ── API Key auth middleware (only if API_KEY is configured) ──────── */

function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (!API_KEY) return next();
  const provided = req.headers['x-api-key'] as string | undefined;
  if (provided !== API_KEY) {
    return res.status(401).json({ success: false, error: 'Invalid or missing API key' });
  }
  next();
}

/* ── POST /api/reschedule ─────────────────────────────────────────── */

app.post('/api/reschedule', authMiddleware, async (req, res) => {
  const requestId = generateRequestId();
  const { clientSearch, newDate, newTime, currentAppointmentDate } = req.body as RescheduleParams;

  // ── Validate required fields ──
  if (!clientSearch || !newDate || !newTime) {
    return res.status(400).json({
      success: false,
      requestId,
      error: 'Missing required fields: clientSearch, newDate, newTime',
    });
  }

  // ── Format validation ──
  if (!/^[0-9]{2}\/[0-9]{2}\/[0-9]{4}$/.test(newDate)) {
    return res.status(400).json({
      success: false,
      requestId,
      error: 'newDate must be in MM/DD/YYYY format (e.g. "03/05/2026")',
    });
  }

  if (!/^[0-9]{1,2}:[0-9]{2}\s?(AM|PM)$/i.test(newTime)) {
    return res.status(400).json({
      success: false,
      requestId,
      error: 'newTime must be in HH:MM AM/PM format (e.g. "03:00 PM")',
    });
  }

  if (currentAppointmentDate && !/^[0-9]{2}\/[0-9]{2}\/[0-9]{4}$/.test(currentAppointmentDate)) {
    return res.status(400).json({
      success: false,
      requestId,
      error: 'currentAppointmentDate must be in MM/DD/YYYY format (e.g. "03/06/2026")',
    });
  }

  // ── Queue limit check ──
  if (queue.length >= MAX_QUEUE_SIZE) {
    return res.status(429).json({
      success: false,
      requestId,
      error: `Queue is full (${MAX_QUEUE_SIZE} pending). Try again later.`,
    });
  }

  // ── Enqueue and respond when processed ──
  const params: RescheduleParams = { clientSearch, newDate, newTime };
  if (currentAppointmentDate) params.currentAppointmentDate = currentAppointmentDate;

  const position = queue.length + (isRunning ? 1 : 0);
  log(`[${requestId}] Queued: client=${clientSearch}, date=${newDate}, time=${newTime}${currentAppointmentDate ? `, currentAppt=${currentAppointmentDate}` : ''} (position ${position})`);

  const result = await enqueue(requestId, params);
  res.status(result.success ? 200 : 500).json(result);
});

/* ── Queue management ─────────────────────────────────────────────── */

function enqueue(requestId: string, params: RescheduleParams): Promise<RunResult> {
  return new Promise((resolve) => {
    const item: QueueItem = { id: requestId, params, resolve, queuedAt: new Date(), timedOut: false };
    queue.push(item);

    // Auto-timeout: if this request sits in queue too long, resolve with error
    setTimeout(() => {
      if (!item.timedOut && queue.includes(item)) {
        item.timedOut = true;
        const idx = queue.indexOf(item);
        if (idx !== -1) queue.splice(idx, 1);
        log(`[${requestId}] Queue timeout — removed after ${QUEUE_WAIT_TIMEOUT_MS / 1000}s`);
        resolve({
          success: false,
          requestId,
          error: 'Request timed out waiting in queue. Try again later.',
          duration: 0,
        });
      }
    }, QUEUE_WAIT_TIMEOUT_MS);

    processQueue();
  });
}

async function processQueue() {
  if (isRunning || queue.length === 0) return;

  // Skip items that timed out while waiting
  while (queue.length > 0 && queue[0].timedOut) {
    queue.shift();
  }
  if (queue.length === 0) return;

  isRunning = true;
  const item = queue.shift()!;
  startedAt = new Date();
  const waitTime = Math.round((startedAt.getTime() - item.queuedAt.getTime()) / 1000);
  log(`[${item.id}] Processing: client=${item.params.clientSearch} (waited ${waitTime}s, ${queue.length} remaining)`);

  try {
    const start = Date.now();
    const result = await rescheduleAppointment(item.params);
    const duration = Math.round((Date.now() - start) / 1000);
    const runResult: RunResult = result.success
      ? { success: true, requestId: item.id, message: result.message, duration }
      : { success: false, requestId: item.id, error: result.message, duration };
    totalProcessed++;
    if (result.success) totalSuccess++;
    else totalFailed++;
    lastResult = {
      ...runResult,
      clientSearch: item.params.clientSearch,
      finishedAt: new Date().toISOString(),
    };
    log(`[${item.id}] ${result.success ? 'SUCCESS' : 'FAILED'}: client=${item.params.clientSearch} in ${duration}s`);
    item.resolve(runResult);
  } catch (err: any) {
    totalProcessed++;
    totalFailed++;
    const errorResult: RunResult = {
      success: false,
      requestId: item.id,
      error: err.message || 'An unexpected error occurred.',
      duration: 0,
    };
    log(`[${item.id}] ERROR: client=${item.params.clientSearch} — ${err.message}`);
    item.resolve(errorResult);
  } finally {
    isRunning = false;
    startedAt = null;
    processQueue();
  }
}

/* ── GET /api/health ──────────────────────────────────────────────── */

app.get('/api/health', (_req, res) => {
  const uptimeSeconds = Math.round((Date.now() - bootTime.getTime()) / 1000);
  res.json({
    status: 'ok',
    uptime: uptimeSeconds,
    isRunning,
    queueLength: queue.length,
    startedAt: startedAt?.toISOString() ?? null,
    stats: { totalProcessed, totalSuccess, totalFailed },
    lastResult: lastResult
      ? { success: lastResult.success, requestId: lastResult.requestId, clientSearch: lastResult.clientSearch, duration: lastResult.duration, finishedAt: lastResult.finishedAt }
      : null,
  });
});

/* ── Graceful shutdown ────────────────────────────────────────────── */

let server: ReturnType<typeof app.listen>;

function shutdown(signal: string) {
  log(`${signal} received — shutting down gracefully`);

  while (queue.length > 0) {
    const item = queue.shift()!;
    item.resolve({ success: false, requestId: item.id, error: 'Server shutting down', duration: 0 });
  }

  server.close(() => {
    log('Server closed');
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/* ── Uncaught error handlers — keep server alive ──────────────────── */

process.on('uncaughtException', (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.message}`);
  console.error(err.stack);
  // Don't exit — keep processing queue
});

process.on('unhandledRejection', (reason) => {
  log(`UNHANDLED REJECTION: ${reason}`);
  // Don't exit — keep processing queue
});

/* ── Start ────────────────────────────────────────────────────────── */

server = app.listen(PORT, () => {
  log(`🚀 Reschedule API running on http://localhost:${PORT}`);
  log(`   POST /api/reschedule  — run appointment reschedule`);
  log(`   GET  /api/health      — check server status`);
  log(`   Auth: ${API_KEY ? 'API key required (X-API-Key header)' : 'open (set API_KEY in .env to enable)'}`);
  log(`   Max queue: ${MAX_QUEUE_SIZE} | Queue timeout: ${QUEUE_WAIT_TIMEOUT_MS / 1000}s`);
});

