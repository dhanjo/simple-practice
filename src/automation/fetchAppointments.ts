import { chromium, Browser } from 'playwright';

export interface FetchAppointmentsParams {
  spEmail: string;
  spPassword: string;
  startDate: string;  // YYYY-MM-DD
  endDate: string;    // YYYY-MM-DD
  timezone?: string;  // e.g. "America/New_York", defaults to "-05:00"
}

export interface FetchAppointmentsResult {
  success: boolean;
  message: string;
  data?: any;
}

function step(label: string) {
  console.log(`[APPOINTMENTS] ${label}`);
}

/**
 * Build the SimplePractice appointments API URL for a given date range.
 */
function buildAppointmentsUrl(startDate: string, endDate: string, tzOffset: string): string {
  const baseUrl = 'https://secure.simplepractice.com/frontend/appointments';

  const appointmentFields = [
    'pendingAppointmentConfirmation', 'cursorId', 'client', 'superbill',
    'coupleClient', 'insuranceClaim', 'payments', 'invoices', 'invoiceItems',
    'wileyTreatmentPlans', 'clientDocumentRequestAppointmentConnections',
    'scheduledMeasures', 'treatmentProgress', 'progressNote',
    'globalMonarchChannel', 'globalMonarchSubchannel', 'psychotherapyNote',
    'overviewDocuments', 'diagnosisTreatmentPlan', 'complexNote',
    'previousAppointment', 'nextAppointment', 'advancedFilter',
    'transcriptRetentionOptOut', 'permissions', 'clientConfirmationStatus',
    'hasNote', 'hasPsychotherapyNote', 'hasNoteSignature',
    'sendDeclineEmail', 'sendAcceptEmail', 'clinicianId', 'rankNum',
    'channelName', 'channelLogo', 'hasSuperbill', 'cptCodes',
    'recurringAppointment', 'office', 'appointmentMemo', 'noteTakerDocument',
    'draftAiNote', 'appointmentClients', 'serviceRemittances',
    'officeId', 'officeName', 'fullDay', 'duration', 'updateScope',
    'scopeAction', 'attendanceStatus', 'practice', 'clinician',
    'thisType', 'title', 'startTime', 'endTime', 'isRecurring',
    'recurrence', 'recurringSchedule',
  ];

  const externalFields = [
    'title', 'duration', 'eventType', 'fullDay', 'occurrences',
    'permissions', 'startTime', 'thisType', 'clinician',
  ];

  const params = new URLSearchParams();
  params.set('fields[appointments]', appointmentFields.join(','));
  params.set('fields[externalAppointments]', externalFields.join(','));
  params.set('fields[pendingAppointmentConfirmations]', 'id,createdAt,status');
  params.set('fields[globalMonarchChannel]', 'displayName,logoUrl');
  params.set('fields[globalMonarchSubchannel]', 'displayName,logoUrl');
  params.set('fields[appointmentClients]', 'id');
  params.set('filter[timeRange]', `${startDate}T00:00:00${tzOffset},${endDate}T00:00:00${tzOffset}`);
  params.set('filter[withMemoPresence]', 'true');
  params.set('include', 'pendingAppointmentConfirmation,globalMonarchChannel,globalMonarchSubchannel,appointmentClients');

  return `${baseUrl}?${params.toString()}`;
}

export async function fetchAppointments(data: FetchAppointmentsParams): Promise<FetchAppointmentsResult> {
  let browser: Browser | null = null;

  try {
    step(`Params: email=${data.spEmail}, range=${data.startDate} → ${data.endDate}`);

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(60000);

    // ── 1. Login ──────────────────────────────────────────────────
    step('Navigating to login page');
    await page.goto('https://account.simplepractice.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForTimeout(2000);

    const emailField = page.getByRole('textbox', { name: 'Email' });
    await emailField.waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForTimeout(800);

    // Dismiss cookie consent banner if present
    const acceptCookieBtn = page.getByRole('button', { name: 'Accept' });
    if (await acceptCookieBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await acceptCookieBtn.click();
      await page.waitForTimeout(600);
    }

    step('Signing in');
    await emailField.click();
    await page.waitForTimeout(600);
    await emailField.pressSequentially(data.spEmail, { delay: 80 });
    await page.waitForTimeout(900);

    const passwordField = page.getByRole('textbox', { name: 'Password' });
    await passwordField.click();
    await page.waitForTimeout(500);
    await passwordField.pressSequentially(data.spPassword, { delay: 110 });
    await page.waitForTimeout(1200);

    await page.getByRole('button', { name: 'Sign in' }).click();
    step('Sign in clicked');

    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(5000);

    // Verify login
    const currentUrl = page.url();
    step(`After login — URL: ${currentUrl}`);
    if (!currentUrl.includes('secure.simplepractice.com')) {
      await page.waitForURL('**/secure.simplepractice.com/**', { timeout: 30_000 });
    }
    step('Login successful');
    await page.waitForTimeout(1000);

    // ── 2. Navigate to calendar (to establish session context) ───
    step('Navigating to calendar to establish session');
    await page.goto('https://secure.simplepractice.com/calendar/appointments', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(5000);

    // ── 3. Extract CSRF token + fetch appointments via page.evaluate ─
    const tzOffset = data.timezone || '-05:00';
    const apiUrl = buildAppointmentsUrl(data.startDate, data.endDate, tzOffset);
    step(`Fetching appointments from SP API: ${data.startDate} to ${data.endDate}`);

    const fetchResult = await page.evaluate(async (url: string) => {
      // Get CSRF token from meta tag
      const csrfMeta = document.querySelector('meta[name="csrf-token"]');
      const csrfToken = csrfMeta?.getAttribute('content') || '';

      const response = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Accept': 'application/vnd.api+json',
          'Api-Version': '2025-03-21',
          'X-Csrf-Token': csrfToken,
        },
      });

      if (!response.ok) {
        return { ok: false, status: response.status, body: await response.text() };
      }

      return { ok: true, status: response.status, body: await response.json() };
    }, apiUrl);

    if (!fetchResult.ok) {
      step(`SP API returned ${fetchResult.status}`);
      return {
        success: false,
        message: `SimplePractice API returned status ${fetchResult.status}`,
      };
    }

    step(`Appointments fetched successfully`);
    return {
      success: true,
      message: `Appointments fetched for ${data.startDate} to ${data.endDate}`,
      data: fetchResult.body,
    };

  } catch (error: any) {
    const msg = cleanErrorMessage(error.message || 'Unknown error');
    console.error('❌ Fetch appointments failed:', msg);
    return { success: false, message: msg };
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Convert raw Playwright errors into clean, human-readable messages.
 */
function cleanErrorMessage(raw: string): string {
  let msg = raw.replace(/=+\s*logs\s*=+[\s\S]*?=+/gi, '').trim();
  msg = msg.replace(/^(page|locator|browser|context)\.\w+(\.\w+)*:\s*/i, '').trim();

  if (/timeout\s*\d+ms\s*exceeded/i.test(msg)) {
    if (/waitForURL/i.test(raw) || /secure\.simplepractice/i.test(raw)) {
      return 'Login timed out. SimplePractice may be slow or credentials may be incorrect.';
    }
    if (/waitForLoadState/i.test(raw)) {
      return 'Page took too long to load. SimplePractice may be experiencing slowness.';
    }
    return 'Operation timed out. SimplePractice may be slow or unresponsive. Please try again.';
  }

  msg = msg.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (msg.length > 200) msg = msg.substring(0, 200) + '...';

  return msg || 'An unexpected error occurred while fetching appointments.';
}

