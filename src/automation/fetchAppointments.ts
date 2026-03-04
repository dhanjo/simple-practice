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
 * Format raw JSON:API appointment data into a clean, presentable structure.
 */
function formatAppointments(rawData: any, startDate: string, endDate: string): any {
  const items: any[] = rawData?.data || [];

  const clientAppointments: any[] = [];
  const nonClientAppointments: any[] = [];

  for (const item of items) {
    const attrs = item.attributes || {};
    const rels = item.relationships || {};

    if (item.type === 'appointments') {
      // Client appointment
      const clientId = rels.client?.data?.id || null;
      const clinicianRelId = rels.clinician?.data?.id || null;

      clientAppointments.push({
        id: item.id,
        clientName: attrs.title || null,
        startTime: attrs.startTime || null,
        endTime: attrs.endTime || null,
        duration: attrs.duration || null,
        status: attrs.attendanceStatus || null,
        clinicianId: attrs.clinicianId || clinicianRelId || null,
        clientId,
        officeName: attrs.officeName || null,
        officeId: attrs.officeId || null,
        isFullDay: attrs.fullDay === 'true',
        isRecurring: attrs.isRecurring === 'true',
        recurringSchedule: attrs.recurringSchedule || null,
        hasNote: attrs.hasNote === 'true',
        hasSignedNote: attrs.hasNoteSignature === 'true',
        clientConfirmationStatus: attrs.clientConfirmationStatus || null,
        cptCodes: (attrs.cptCodes || []).map((c: any) => ({
          code: c.code,
          description: c.description,
          rate: c.ratePerUnit || c.rate || null,
        })),
      });
    } else if (item.type === 'nonClientAppointments') {
      // Non-client appointment (break, block, pay period, etc.)
      const clinicianRelId = rels.clinician?.data?.id || null;

      nonClientAppointments.push({
        id: item.id,
        title: attrs.title || null,
        startTime: attrs.startTime || null,
        endTime: attrs.endTime || null,
        duration: attrs.duration || null,
        status: attrs.attendanceStatus || null,
        clinicianId: attrs.clinicianId || clinicianRelId || null,
        officeName: attrs.officeName || null,
        officeId: attrs.officeId || null,
        isFullDay: attrs.fullDay === 'true',
        isRecurring: attrs.isRecurring === 'true',
        recurringSchedule: attrs.recurringSchedule || null,
      });
    }
  }

  // Sort by startTime
  const sortByTime = (a: any, b: any) => {
    const ta = a.startTime ? new Date(a.startTime).getTime() : 0;
    const tb = b.startTime ? new Date(b.startTime).getTime() : 0;
    return ta - tb;
  };
  clientAppointments.sort(sortByTime);
  nonClientAppointments.sort(sortByTime);

  return {
    summary: {
      dateRange: { start: startDate, end: endDate },
      totalAppointments: clientAppointments.length + nonClientAppointments.length,
      totalClientAppointments: clientAppointments.length,
      totalNonClientAppointments: nonClientAppointments.length,
    },
    appointments: clientAppointments,
    nonClientAppointments,
  };
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

    // Wait for SAML redirect chain to complete (can take a while)
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(8000);

    // Verify login — SAML redirect may need extra time
    const currentUrl = page.url();
    step(`After login — URL: ${currentUrl}`);
    if (!currentUrl.includes('secure.simplepractice.com')) {
      step('Waiting for SAML redirect to complete...');
      await page.waitForURL('**/secure.simplepractice.com/**', { timeout: 60_000 });
    }
    step('Login successful');
    await page.waitForTimeout(2000);

    // ── 2. Navigate to calendar to get session cookies + CSRF token ───
    step('Navigating to calendar to extract session');
    await page.goto('https://secure.simplepractice.com/calendar/appointments', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(5000);

    // ── 3. Extract cookies + CSRF token from the browser ─────────
    step('Extracting cookies and CSRF token');
    const csrfToken = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="csrf-token"]');
      return meta?.getAttribute('content') || '';
    });

    const cookies = await context.cookies('https://secure.simplepractice.com');
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    step(`Extracted ${cookies.length} cookies, CSRF token: ${csrfToken ? 'found' : 'NOT FOUND'}`);

    // ── 4. Close the browser — we don't need it anymore ──────────
    await browser.close();
    browser = null;
    step('Browser closed — making API call directly from Node.js');

    // ── 5. Fetch appointments via Node.js fetch (no browser needed) ─
    const tzOffset = data.timezone || '-05:00';
    const apiUrl = buildAppointmentsUrl(data.startDate, data.endDate, tzOffset);
    step(`Fetching appointments from SP API: ${data.startDate} to ${data.endDate}`);

    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.api+json',
        'Api-Version': '2025-03-21',
        'X-Csrf-Token': csrfToken,
        'Cookie': cookieHeader,
        'Referer': 'https://secure.simplepractice.com/calendar/appointments',
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      step(`SP API returned ${response.status}: ${errorBody.substring(0, 200)}`);
      return {
        success: false,
        message: `SimplePractice API returned status ${response.status}`,
      };
    }

    const rawBody = await response.json();

    step(`Appointments fetched successfully`);
    const formatted = formatAppointments(rawBody, data.startDate, data.endDate);
    return {
      success: true,
      message: `Appointments fetched for ${data.startDate} to ${data.endDate}`,
      data: formatted,
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

