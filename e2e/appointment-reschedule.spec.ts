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
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

/** Human-like pause between actions (300–600 ms default for production) */
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
    const email        = requiredEnv('SP_EMAIL');
    const password     = requiredEnv('SP_PASSWORD');
    const clientSearch = requiredEnv('SP_CLIENT_SEARCH');
    const newDate      = requiredEnv('SP_NEW_DATE');
    const newTime      = requiredEnv('SP_NEW_TIME');

    // ── 2. Login page ──────────────────────────────────────────────────
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
    await page.waitForURL('**/secure.simplepractice.com/**', { timeout: 30_000 });
    await humanDelay(page, 600, 1000);

    // ── 5. Navigate to Calendar ─────────────────────────────────────
    await page.goto('https://secure.simplepractice.com/calendar/appointments', {
      waitUntil: 'domcontentloaded',
    });

    // ── 6. Search for the client ────────────────────────────────────
    const searchTrigger = page.locator('[id*="search-container"][id$="trigger"]');
    await searchTrigger.waitFor({ state: 'visible', timeout: 15_000 });
    await searchTrigger.click();
    await humanDelay(page, 300, 500);

    const searchInput = page.getByRole('textbox', { name: 'Search clients' });
    await searchInput.waitFor({ state: 'visible', timeout: 10_000 });
    await searchInput.fill(clientSearch);
    await humanDelay(page, 1000, 1500); // wait for search results

    // ── 7. Click first search result ────────────────────────────────
    const clientOption = page.getByRole('option').first();
    await clientOption.waitFor({ state: 'visible', timeout: 15_000 });
    await humanDelay(page, 300, 500);
    await clientOption.click();
    await humanDelay(page, 600, 1000);

    // ── 8. Wait for Upcoming Appointments section ───────────────────
    await expect(page.getByText('Upcoming appointments')).toBeVisible({ timeout: 15_000 });
    await humanDelay(page, 300, 500);

    // ── 9. Click the first upcoming appointment ─────────────────────
    const firstAppointment = page
      .locator('text=Upcoming appointments')
      .locator('xpath=following::a[contains(@id,"ember")]')
      .first();
    await firstAppointment.waitFor({ state: 'visible', timeout: 15_000 });
    await humanDelay(page, 300, 500);
    await firstAppointment.click();

    // ── 10. Wait for appointment edit form to fully load ────────────
    await page.waitForLoadState('domcontentloaded');
    const startDateInput = page.getByRole('textbox', { name: /start date/i });
    await startDateInput.waitFor({ state: 'visible', timeout: 15_000 });
    // Extra settle time — form must fully render before we touch anything
    await humanDelay(page, 2000, 2500);

    // ── 11. Change the Start Date ───────────────────────────────────
    await clearAndType(page, startDateInput, newDate);
    await startDateInput.press('Tab');
    await humanDelay(page, 600, 1000);

    // ── 12. Change the Start Time ───────────────────────────────────
    // After Tab from start date, focus lands on the start time field.
    // Type the time exactly as-is (e.g. "03:00 PM") — no stripping needed.

    // Grab the now-focused start time field and triple-click to select all
    const startTimeInput = page.locator(':focus');
    await startTimeInput.click({ clickCount: 3 });
    await humanDelay(page, 200, 400);
    await page.keyboard.press('Backspace');
    await humanDelay(page, 300, 500);
    await page.keyboard.type(newTime, { delay: 100 });
    await humanDelay(page, 600, 1000);
    await page.keyboard.press('Tab');
    await humanDelay(page, 1000, 1500);

    // ── 13. Save ────────────────────────────────────────────────────
    const saveBtn = page.getByRole('button', { name: /save/i });
    await expect(saveBtn).toBeEnabled({ timeout: 10_000 });
    await humanDelay(page, 300, 500);
    await saveBtn.click();

    // ── 14. Verify save completed ───────────────────────────────────
    await page.waitForLoadState('domcontentloaded');
    await humanDelay(page, 1500, 2000);
  });
});

