/**
 * Navigate to an HTML test page and wait for it to be ready
 * @param {import('@playwright/test').Page} page - Playwright page instance
 * @param {string} httpUrl - Base URL of the test server (e.g. "http://localhost:4000")
 * @param {string} htmlFile - HTML filename to load (e.g. "client-lifecycle.html")
 */
export async function openPage(page, httpUrl, htmlFile) {
    await page.goto(`${httpUrl}/${htmlFile}`);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 10_000 });
}

/**
 * Wait for a condition to become truthy in the browser context
 * @param {import('@playwright/test').Page} page - Playwright page instance
 * @param {string} conditionStr - JavaScript expression to evaluate (must return truthy when done)
 * @param {number} [timeout=10000] - Max wait time in milliseconds
 */
export async function waitFor(page, conditionStr, timeout = 10_000) {
    await page.waitForFunction(conditionStr, null, { timeout });
}

/**
 * Sleep for a given duration
 * @param {number} ms - Duration in milliseconds
 * @returns {Promise<void>}
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
