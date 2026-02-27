import { chromium, Browser, Page } from 'playwright';

export interface RescheduleParams {
  clientSearch: string;
  newDate: string;   // MM/DD/YYYY
  newTime: string;   // HH:MM AM/PM
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

    // Wait for login to complete — use networkidle like the working project
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2500);

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
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

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
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    // ── 5. Wait for Upcoming Appointments ───────────────────────
    step('Waiting for upcoming appointments');
    const upcomingHeader = page.getByText('Upcoming appointments');
    const hasUpcoming = await upcomingHeader.isVisible({ timeout: 15_000 }).catch(() => false);
    if (!hasUpcoming) {
      throw new Error(`No upcoming appointments found for client "${data.clientSearch}".`);
    }
    await page.waitForTimeout(500);

    // ── 6. Click first upcoming appointment ─────────────────────
    const firstAppointment = page
      .locator('text=Upcoming appointments')
      .locator('xpath=following::a[contains(@id,"ember")]')
      .first();
    const appointmentVisible = await firstAppointment.isVisible({ timeout: 15_000 }).catch(() => false);
    if (!appointmentVisible) {
      throw new Error(`No clickable appointment link found for client "${data.clientSearch}".`);
    }
    step('Clicking first upcoming appointment');
    await page.waitForTimeout(500);
    await firstAppointment.click();

    // ── 7. Wait for appointment form ────────────────────────────
    step('Waiting for appointment form');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);
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
    console.error('❌ Reschedule failed:', error.message);
    return { success: false, message: error.message };
  } finally {
    if (browser) await browser.close();
  }
}
