import { chromium, Browser, Page } from 'playwright';

export interface RescheduleParams {
  clientSearch: string;
  newDate: string;   // MM/DD/YYYY
  newTime: string;   // HH:MM AM/PM
  currentAppointmentDate?: string; // MM/DD/YYYY — optional: pick a specific appointment to reschedule
}

export interface RescheduleResult {
  success: boolean;
  message: string;
}

function step(label: string) {
  console.log(`[STEP] ${label}`);
}

/**
 * Clear an input field and type a new value character-by-character.
 * Uses triple-click → Backspace → pressSequentially to trigger Ember change detection.
 */
async function clearAndType(
  page: Page,
  locator: ReturnType<Page['locator']>,
  value: string,
  charDelay = 100,
): Promise<void> {
  await locator.click({ clickCount: 3 });
  await page.waitForTimeout(300);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  await locator.pressSequentially(value, { delay: charDelay });
  await page.waitForTimeout(500);
}

export async function rescheduleAppointment(data: RescheduleParams): Promise<RescheduleResult> {
  let browser: Browser | null = null;

  try {
    step(`Params: client=${data.clientSearch}, date=${data.newDate}, time=${data.newTime}`);

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
    await emailField.pressSequentially('cematthewslcsw@gmail.com', { delay: 80 });
    await page.waitForTimeout(900);

    const passwordField = page.getByRole('textbox', { name: 'Password' });
    await passwordField.click();
    await page.waitForTimeout(500);
    await passwordField.pressSequentially('Njalone08#', { delay: 110 });
    await page.waitForTimeout(1200);

    await page.getByRole('button', { name: 'Sign in' }).click();
    console.log('✅ Sign in clicked');

    // Wait for login to complete
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(5000);

    // Verify we landed on the dashboard
    const currentUrl = page.url();
    step(`After login — URL: ${currentUrl}`);
    if (!currentUrl.includes('secure.simplepractice.com')) {
      // Try waiting for redirect a bit more
      await page.waitForURL('**/secure.simplepractice.com/**', { timeout: 30_000 });
    }
    step('Login successful');
    await page.waitForTimeout(1000);

    // ── 2. Navigate to Calendar ─────────────────────────────────
    step('Navigating to calendar');
    await page.goto('https://secure.simplepractice.com/calendar/appointments', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(5000);

    // ── 3. Search for client ────────────────────────────────────
    step(`Searching for client: ${data.clientSearch}`);
    const searchTrigger = page.locator('[id*="search-container"][id$="trigger"]');
    await searchTrigger.waitFor({ state: 'visible', timeout: 15_000 });
    await searchTrigger.click();
    await page.waitForTimeout(500);

    const searchInput = page.getByRole('textbox', { name: 'Search clients' });
    await searchInput.waitFor({ state: 'visible', timeout: 10_000 });
    await searchInput.fill(data.clientSearch);
    await page.waitForTimeout(1500);

    // ── 4. Click first search result ────────────────────────────
    const clientOption = page.getByRole('option').first();
    await clientOption.waitFor({ state: 'visible', timeout: 15_000 });
    const clientName = await clientOption.textContent();
    step(`Found client: "${clientName?.trim()}"`);
    await page.waitForTimeout(500);
    await clientOption.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(5000);

    // ── 5. Wait for Upcoming Appointments ───────────────────────
    step('Waiting for upcoming appointments');
    const upcomingHeader = page.getByText('Upcoming appointments');
    const hasUpcoming = await upcomingHeader.isVisible({ timeout: 15_000 }).catch(() => false);
    if (!hasUpcoming) {
      throw new Error(`No upcoming appointments found for client "${data.clientSearch}".`);
    }
    await page.waitForTimeout(500);

    // ── 6. Click the target upcoming appointment ──────────────────
    const allAppointments = page
      .locator('text=Upcoming appointments')
      .locator('xpath=following::a[contains(@id,"ember")]');
    const appointmentCount = await allAppointments.count();
    if (appointmentCount === 0) {
      throw new Error(`No clickable appointment link found for client "${data.clientSearch}".`);
    }
    step(`Found ${appointmentCount} upcoming appointment(s)`);

    let targetAppointment;

    if (data.currentAppointmentDate) {
      // Convert MM/DD/YYYY to possible display formats to match against
      const [mm, dd, yyyy] = data.currentAppointmentDate.split('/');
      const dateObj = new Date(parseInt(yyyy), parseInt(mm) - 1, parseInt(dd));
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const monthShort = monthNames[dateObj.getMonth()];
      const dayNum = dateObj.getDate().toString();
      // SimplePractice typically shows dates like "Mar 6, 2026" or "03/06/2026"
      const possibleFormats = [
        `${monthShort} ${dayNum}, ${yyyy}`,           // Mar 6, 2026
        `${monthShort} ${dd}, ${yyyy}`,               // Mar 06, 2026
        data.currentAppointmentDate,                   // 03/06/2026
        `${mm}/${dd}/${yyyy}`,                         // 03/06/2026
      ];
      step(`Looking for appointment matching date: ${data.currentAppointmentDate} (formats: ${possibleFormats.join(' | ')})`);

      let found = false;
      for (let i = 0; i < appointmentCount; i++) {
        const apptLink = allAppointments.nth(i);
        const apptText = (await apptLink.textContent()) || '';
        step(`  Appointment ${i + 1}: "${apptText.trim()}"`);
        if (possibleFormats.some(fmt => apptText.includes(fmt))) {
          targetAppointment = apptLink;
          step(`  ✅ Matched appointment ${i + 1}`);
          found = true;
          break;
        }
      }
      if (!found) {
        throw new Error(`No appointment found matching date "${data.currentAppointmentDate}" for client "${data.clientSearch}". Found ${appointmentCount} appointment(s) but none matched.`);
      }
    } else {
      // No specific date requested — click the first one
      targetAppointment = allAppointments.first();
      step('No currentAppointmentDate specified — selecting first upcoming appointment');
    }

    await page.waitForTimeout(500);
    await targetAppointment!.click();

    // ── 7. Wait for appointment form ────────────────────────────
    step('Waiting for appointment form');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(5000);
    const startDateInput = page.getByRole('textbox', { name: /start date/i });
    await startDateInput.waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(2000);

    const currentDate = await startDateInput.inputValue();
    step(`Current date: "${currentDate}" → New date: "${data.newDate}"`);

    // ── 8. Change Start Date ────────────────────────────────────
    step('Setting start date');
    await clearAndType(page, startDateInput, data.newDate);
    await startDateInput.press('Tab');
    await page.waitForTimeout(1000);

    // ── 9. Change Start Time ────────────────────────────────────
    // After Tab from start date, focus lands on the start time field.
    step('Setting start time');
    const startTimeInput = page.locator(':focus');
    const currentTime = await startTimeInput.inputValue().catch(() => '');
    step(`Current time: "${currentTime}" → New time: "${data.newTime}"`);

    await startTimeInput.click({ clickCount: 3 });
    await page.waitForTimeout(300);
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(500);
    await page.keyboard.type(data.newTime, { delay: 100 });
    await page.waitForTimeout(1000);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(1500);

    // ── 10. Save ────────────────────────────────────────────────
    const saveBtn = page.getByRole('button', { name: /save/i });
    const isSaveEnabled = await saveBtn.isEnabled({ timeout: 5_000 }).catch(() => false);
    if (!isSaveEnabled) {
      step('Save button is disabled — appointment may already be at the requested date/time');
      return { success: true, message: `No changes needed. Appointment was already at ${data.newDate} ${data.newTime}` };
    }

    step('Clicking Save');
    await page.waitForTimeout(500);
    await saveBtn.click();

    // ── 11. Verify save ─────────────────────────────────────────
    // Wait for save button to become disabled (Ember confirmation)
    const saveDisabled = await saveBtn.isDisabled({ timeout: 15_000 }).catch(() => false);
    if (!saveDisabled) {
      await page.waitForTimeout(3000);
    }
    await page.waitForTimeout(1500);
    step('Save confirmed');
    console.log(`✅ Appointment rescheduled to ${data.newDate} at ${data.newTime}`);
    return { success: true, message: `Appointment rescheduled to ${data.newDate} at ${data.newTime}` };

  } catch (error: any) {
    const friendlyMessage = cleanErrorMessage(error.message || 'Unknown error');
    console.error('❌ Reschedule failed:', friendlyMessage);
    return { success: false, message: friendlyMessage };
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Convert raw Playwright errors into clean, human-readable messages.
 */
function cleanErrorMessage(raw: string): string {
  // Strip Playwright log blocks:  ===== logs =====\n...\n============
  let msg = raw.replace(/=+\s*logs\s*=+[\s\S]*?=+/gi, '').trim();

  // Strip "page.xxx:" or "locator.xxx:" prefixes
  msg = msg.replace(/^(page|locator|browser|context)\.\w+(\.\w+)*:\s*/i, '').trim();

  // Map common Playwright errors to friendly messages
  if (/timeout\s*\d+ms\s*exceeded/i.test(msg)) {
    if (/waitForURL/i.test(raw) || /secure\.simplepractice/i.test(raw)) {
      return 'Login timed out. SimplePractice may be slow or credentials may be incorrect.';
    }
    if (/waitForLoadState/i.test(raw)) {
      return 'Page took too long to load. SimplePractice may be experiencing slowness.';
    }
    if (/waitFor/i.test(raw) && /search/i.test(raw)) {
      return 'Client search timed out. The search box did not appear in time.';
    }
    if (/waitFor/i.test(raw) && /start date/i.test(raw)) {
      return 'Appointment form did not load in time.';
    }
    return 'Operation timed out. SimplePractice may be slow or unresponsive. Please try again.';
  }

  if (/no upcoming appointments/i.test(msg)) {
    return msg; // already clean
  }

  if (/no clickable appointment/i.test(msg)) {
    return msg; // already clean
  }

  if (/no appointment found matching/i.test(msg)) {
    return msg; // already clean
  }

  // Remove any remaining newlines / excess whitespace
  msg = msg.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();

  // Cap length
  if (msg.length > 200) {
    msg = msg.substring(0, 200) + '...';
  }

  return msg || 'An unexpected error occurred during the reschedule process.';
}
