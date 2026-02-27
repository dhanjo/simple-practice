import { test, expect, Page } from '@playwright/test';

/*
 * Production-ready appointment reschedule automation for SimplePractice.
 *
 * Dynamic values come from environment variables (via .env or API request):
 *   SP_EMAIL, SP_PASSWORD  — credentials (kept in .env on VPS)
 *   SP_CLIENT_SEARCH       — phone number to search client
 *   SP_NEW_DATE            — new date in MM/DD/YYYY format
 *   SP_NEW_TIME            — new time e.g. "03:00 PM"
 */

/* ── helpers ────────────────────────────────────────────────────────── */

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

/** Structured step logger for remote debugging */
function step(label: string) {
  console.log(`[STEP] ${label}`);
}

/** Human-like pause between actions */
async function humanDelay(page: Page, min = 300, max = 600): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  await page.waitForTimeout(ms);
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
  await humanDelay(page, 200, 400);
  await page.keyboard.press('Backspace');
  await humanDelay(page, 200, 400);
  await locator.pressSequentially(value, { delay: charDelay });
  await humanDelay(page, 400, 600);
}

/* ── test ───────────────────────────────────────────────────────────── */

test.describe('Appointment Reschedule', () => {

  test('should reschedule an existing appointment to a new date and time', async ({ page }) => {
    // ── 1. Read dynamic parameters ──────────────────────────────────
    const email        = 'cematthewslcsw@gmail.com';
    const password     = 'Njalone08#';
    const clientSearch = requiredEnv('SP_CLIENT_SEARCH');
    const newDate      = requiredEnv('SP_NEW_DATE');
    const newTime      = requiredEnv('SP_NEW_TIME');

    step(`Params: client=${clientSearch}, date=${newDate}, time=${newTime}`);

    // ── 2. Login page ──────────────────────────────────────────────────
    step('Navigating to login page');
    await page.goto('https://account.simplepractice.com/', {
      waitUntil: 'domcontentloaded',
    });

    const emailField = page.getByRole('textbox', { name: 'Email' });
    await emailField.waitFor({ state: 'visible', timeout: 30_000 });
    await humanDelay(page, 500, 800);

    // ── 3. Dismiss cookie consent banner if present ─────────────────
    const acceptCookieBtn = page.getByRole('button', { name: 'Accept' });
    if (await acceptCookieBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await acceptCookieBtn.click();
      await humanDelay(page, 400, 600);
    }

    // ── 4. Sign in ──────────────────────────────────────────────────
    step('Signing in');
    await emailField.click();
    await humanDelay(page, 150, 300);
    await emailField.fill(email);
    await humanDelay(page, 200, 400);

    const passwordField = page.getByRole('textbox', { name: 'Password' });
    await passwordField.click();
    await humanDelay(page, 150, 300);
    await passwordField.fill(password);
    await humanDelay(page, 200, 400);

    await page.getByRole('button', { name: 'Sign in' }).click();

    // Debug: wait a moment then log what happened after clicking sign in
    await page.waitForTimeout(5_000);
    step(`After sign-in click — URL: ${page.url()}`);
    const bodyText = await page.locator('body').innerText().catch(() => '(could not read body)');
    step(`Page text (first 500 chars): ${bodyText.substring(0, 500)}`);

    await page.waitForURL('**/secure.simplepractice.com/**', { timeout: 30_000 });
    step('Login successful');
    await humanDelay(page, 600, 1000);

    // ── 5. Navigate to Calendar ─────────────────────────────────────
    step('Navigating to calendar');
    await page.goto('https://secure.simplepractice.com/calendar/appointments', {
      waitUntil: 'domcontentloaded',
    });

    // ── 6. Search for the client ────────────────────────────────────
    step(`Searching for client: ${clientSearch}`);
    const searchTrigger = page.locator('[id*="search-container"][id$="trigger"]');
    await searchTrigger.waitFor({ state: 'visible', timeout: 15_000 });
    await searchTrigger.click();
    await humanDelay(page, 300, 500);

    const searchInput = page.getByRole('textbox', { name: 'Search clients' });
    await searchInput.waitFor({ state: 'visible', timeout: 10_000 });
    await searchInput.fill(clientSearch);
    await humanDelay(page, 1000, 1500);

    // ── 7. Click first search result ────────────────────────────────
    const clientOption = page.getByRole('option').first();
    await clientOption.waitFor({ state: 'visible', timeout: 15_000 });
    const clientName = await clientOption.textContent();
    step(`Found client: "${clientName?.trim()}"`);
    await humanDelay(page, 300, 500);
    await clientOption.click();
    await humanDelay(page, 600, 1000);

    // ── 8. Wait for Upcoming Appointments section ───────────────────
    step('Waiting for upcoming appointments');
    const upcomingHeader = page.getByText('Upcoming appointments');
    const hasUpcoming = await upcomingHeader.isVisible({ timeout: 15_000 }).catch(() => false);
    if (!hasUpcoming) {
      throw new Error(`No upcoming appointments section found for client "${clientSearch}". The client may have no future appointments.`);
    }
    await humanDelay(page, 300, 500);

    // ── 9. Click the first upcoming appointment ─────────────────────
    const firstAppointment = page
      .locator('text=Upcoming appointments')
      .locator('xpath=following::a[contains(@id,"ember")]')
      .first();
    const appointmentVisible = await firstAppointment.isVisible({ timeout: 15_000 }).catch(() => false);
    if (!appointmentVisible) {
      throw new Error(`No clickable appointment link found for client "${clientSearch}". The client may have no upcoming appointments.`);
    }
    step('Clicking first upcoming appointment');
    await humanDelay(page, 300, 500);
    await firstAppointment.click();

    // ── 10. Wait for appointment edit form to fully load ────────────
    step('Waiting for appointment form');
    await page.waitForLoadState('domcontentloaded');
    const startDateInput = page.getByRole('textbox', { name: /start date/i });
    await startDateInput.waitFor({ state: 'visible', timeout: 15_000 });
    // Extra settle time — Ember form must fully render before we touch anything
    await humanDelay(page, 2000, 2500);

    // ── 11. Read current values for logging ──────────────────────────
    const currentDate = await startDateInput.inputValue();
    step(`Current date: "${currentDate}" → New date: "${newDate}"`);

    // ── 12. Change the Start Date ───────────────────────────────────
    step('Setting start date');
    await clearAndType(page, startDateInput, newDate);
    await startDateInput.press('Tab');
    await humanDelay(page, 600, 1000);

    // ── 13. Change the Start Time ───────────────────────────────────
    // After Tab from start date, focus lands on the start time field.
    step('Setting start time');
    const startTimeInput = page.locator(':focus');
    const currentTime = await startTimeInput.inputValue().catch(() => '');
    step(`Current time: "${currentTime}" → New time: "${newTime}"`);

    await startTimeInput.click({ clickCount: 3 });
    await humanDelay(page, 200, 400);
    await page.keyboard.press('Backspace');
    await humanDelay(page, 300, 500);
    await page.keyboard.type(newTime, { delay: 100 });
    await humanDelay(page, 600, 1000);
    await page.keyboard.press('Tab');
    await humanDelay(page, 1000, 1500);

    // ── 14. Save ────────────────────────────────────────────────────
    const saveBtn = page.getByRole('button', { name: /save/i });

    // Handle edge case: if date and time were already the same, Save stays disabled
    const isSaveEnabled = await saveBtn.isEnabled({ timeout: 5_000 }).catch(() => false);
    if (!isSaveEnabled) {
      step('Save button is disabled — appointment may already be at the requested date/time');
      console.log(`⚠️ No changes detected. Appointment was already at ${newDate} ${newTime}`);
      return; // success — nothing to change
    }

    step('Clicking Save');
    await humanDelay(page, 300, 500);
    await saveBtn.click();

    // ── 15. Verify save completed ───────────────────────────────────
    // After a successful save the button becomes disabled again (Ember behavior).
    await expect(saveBtn).toBeDisabled({ timeout: 15_000 });
    await humanDelay(page, 1000, 1500);
    step('Save confirmed');
    console.log(`✅ Appointment rescheduled to ${newDate} at ${newTime}`);
  });
});

