import { test, expect } from '@playwright/test';
import { createTestServer } from '../helpers/test-server.js';
import { openPage } from '../helpers/playwright-helpers.js';

let ts;

test.beforeAll(async () => { ts = await createTestServer(); });
test.afterAll(async () => { ts.close(); });

test.describe('Client configuration', () => {

    test('client init with invalid endpoint rejects gracefully', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        const error = await page.evaluate(async () => {
            try { await window.initClient('fail', 'ws://localhost:1'); return null; }
            catch (e) { return e.message; }
        });
        expect(error).toBeTruthy();
    });

    test('init() called twice rejects with already initialized', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('di1', wsUrl), { wsUrl: ts.wsUrl });
        const err = await page.evaluate(async ({ wsUrl }) => {
            const { default: PlaySocket } = await import('/dist/playsocket-client.js');
            // Create a client, init it, then try to init again
            const client = new PlaySocket('di2', { endpoint: wsUrl });
            await client.init();
            try { await client.init(); return null; }
            catch (e) { return e.message; }
        }, { wsUrl: ts.wsUrl });
        expect(err).toContain('Already initialized');
    });

    test('init() with no endpoint rejects', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        const err = await page.evaluate(async () => {
            const { default: PlaySocket } = await import('/dist/playsocket-client.js');
            const client = new PlaySocket('noEp');
            try { await client.init(); return null; }
            catch (e) { return e.message; }
        });
        expect(err).toContain('endpoint');
    });
});
