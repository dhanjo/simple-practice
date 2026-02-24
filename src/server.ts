import express from 'express';
import cors from 'cors';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 3000;
const TEST_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes max per test run

app.use(cors());
app.use(express.json());

// Track whether a test is already running (only one browser at a time)
let isRunning = false;
let currentProcess: ChildProcess | null = null;
let startedAt: Date | null = null;

interface RescheduleBody {
  clientSearch: string;
  newDate: string;
  newTime: string;
}

// ── Request logging middleware ──
app.use((req, _res, next) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.path}`);
  next();
});

app.post('/api/reschedule', async (req, res) => {
  const { clientSearch, newDate, newTime } = req.body as RescheduleBody;

  // ── Validate required fields ──
  if (!clientSearch || !newDate || !newTime) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: clientSearch, newDate, newTime',
    });
  }

  // ── Basic format validation ──
  if (!/^[0-9]{2}\/[0-9]{2}\/[0-9]{4}$/.test(newDate)) {
    return res.status(400).json({
      success: false,
      error: 'newDate must be in MM/DD/YYYY format (e.g. "03/05/2026")',
    });
  }

  if (!/^[0-9]{1,2}:[0-9]{2}\s?(AM|PM)$/i.test(newTime)) {
    return res.status(400).json({
      success: false,
      error: 'newTime must be in HH:MM AM/PM format (e.g. "03:00 PM")',
    });
  }

  // ── Prevent concurrent runs ──
  if (isRunning) {
    return res.status(429).json({
      success: false,
      error: 'A reschedule is already in progress. Try again later.',
    });
  }

  isRunning = true;
  startedAt = new Date();
  console.log(`[${startedAt.toISOString()}] Starting reschedule: client=${clientSearch}, date=${newDate}, time=${newTime}`);

  try {
    const result = await runPlaywrightTest({ clientSearch, newDate, newTime });
    console.log(`[${new Date().toISOString()}] Reschedule ${result.success ? 'succeeded' : 'failed'} in ${result.duration}s`);
    res.json(result);
  } catch (err: any) {
    console.error(`[${new Date().toISOString()}] Reschedule error:`, err.message);
    res.status(500).json({
      success: false,
      error: err.message || 'Unknown error',
    });
  } finally {
    isRunning = false;
    currentProcess = null;
    startedAt = null;
  }
});

// ── Health check ──
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    isRunning,
    startedAt: startedAt?.toISOString() ?? null,
  });
});

// ── Run the Playwright test as a child process ──
function runPlaywrightTest(
  params: RescheduleBody,
): Promise<{ success: boolean; output: string; duration: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';

    const testProcess = spawn(
      'npx',
      ['playwright', 'test', 'appointment-reschedule'],
      {
        cwd: path.resolve(__dirname, '..'),
        env: {
          ...process.env,
          SP_CLIENT_SEARCH: params.clientSearch,
          SP_NEW_DATE: params.newDate,
          SP_NEW_TIME: params.newTime,
        },
        shell: true,
      },
    );

    currentProcess = testProcess;

    // Kill the process if it exceeds the timeout
    const timeout = setTimeout(() => {
      testProcess.kill('SIGTERM');
      setTimeout(() => {
        if (!testProcess.killed) testProcess.kill('SIGKILL');
      }, 5000);
    }, TEST_TIMEOUT_MS);

    testProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    testProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    testProcess.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Math.round((Date.now() - start) / 1000);
      const output = (stdout + '\n' + stderr).trim();

      if (code === 0) {
        resolve({ success: true, output, duration });
      } else {
        resolve({ success: false, output, duration });
      }
    });
  });
}

app.listen(PORT, () => {
  console.log(`🚀 Reschedule API running on http://localhost:${PORT}`);
  console.log(`   POST /api/reschedule  — run appointment reschedule`);
  console.log(`   GET  /api/health      — check server status`);
});

