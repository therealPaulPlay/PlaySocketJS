import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createTestServer, getNextPort } from '../helpers/test-server.js';
import { openPage, sleep } from '../helpers/playwright-helpers.js';

test.describe('Server configuration', () => {

    test('verifyClient can accept connections', async ({ page }) => {
        const ts = await createTestServer({
            verifyClient: (info, callback) => callback(true),
        });
        await openPage(page, ts.httpUrl, 'test-client.html');
        const id = await page.evaluate(({ wsUrl }) => window.initClient('vc1', wsUrl), { wsUrl: ts.wsUrl });
        expect(id).toBe('vc1');
        ts.close();
    });

    test('verifyClient can reject connections', async ({ page }) => {
        const ts = await createTestServer({
            verifyClient: (info, callback) => callback(false, 403, 'Forbidden'),
        });
        await openPage(page, ts.httpUrl, 'test-client.html');
        const err = await page.evaluate(async ({ wsUrl }) => {
            try { await window.initClient('vc2', wsUrl); return null; }
            catch (e) { return e.message; }
        }, { wsUrl: ts.wsUrl });
        expect(err).toBeTruthy();
        ts.close();
    });

    test('rateLimit enforces message limits', async ({ page }) => {
        // rateLimit: 8 = enough for register(1) + create_room(5) = 6, then 2 more ops allowed
        // Sending 20 update ops should exceed the limit and get terminated
        const ts = await createTestServer({ rateLimit: 8 });
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('rl1', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom('rl1', { x: 0 }));

        // Wait for the rate limit bucket to refill (1s window)
        await sleep(1200);

        // Spam operations beyond the rate limit (8 points max, each costs 1)
        await page.evaluate(() => {
            for (let i = 0; i < 20; i++) window.updateStorage('rl1', 'x', 'set', i);
        });

        // Wait for disconnect
        await page.waitForFunction(() => {
            const ev = window.getEvents('rl1');
            return ev.error.length > 0 || ev.instanceDestroyed.length > 0 || ev.status.some(s => s.includes('Disconnected'));
        }, null, { timeout: 5_000 });
        ts.close();
    });

    test('passing an existing HTTP server works', async ({ page }) => {
        const port = getNextPort();
        const httpServer = createServer((req, res) => {
            if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
            res.writeHead(404); res.end();
        });
        await new Promise(resolve => httpServer.listen(port, resolve));

        const ts = await createTestServer({ existingServer: httpServer, port });

        // The custom route should still work
        const resp = await fetch(`http://localhost:${port}/health`);
        expect(resp.status).toBe(200);

        // PlaySocket should work on the shared server
        // We need to serve the pages ourselves since existingServer was provided
        // For this test, use a separate page server
        const pageTs = await createTestServer();
        await openPage(page, pageTs.httpUrl, 'test-client.html');
        const id = await page.evaluate(({ wsUrl }) => window.initClient('es1', wsUrl), { wsUrl: ts.wsUrl });
        expect(id).toBe('es1');

        await pageTs.close();
        ts.server.stop();
        httpServer.close();
    });

    test('ping/heartbeat terminates unresponsive clients', async ({ page }) => {
        const ts = await createTestServer();
        await openPage(page, ts.httpUrl, 'test-client.html?intercept-ws');
        await page.evaluate(({ wsUrl }) => window.initClient('hb1', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom('hb1', {}));

        // Block network so client can't reconnect, then simulate disconnect
        // Server's heartbeat should detect this within 2 heartbeat cycles
        await page.evaluate(() => {
            window.blockNetwork();
            window.simulateDisconnect('hb1');
        });

        // Wait for instanceDestroyed event (fires when client is terminated)
        await page.waitForFunction(
            () => window.getEvents('hb1').instanceDestroyed.length > 0,
            null,
            { timeout: 15_000 }
        );
        ts.close();
    });

    test('max room size enforcement', async ({ context }) => {
        const ts = await createTestServer();
        const pages = [];
        for (let i = 0; i < 5; i++) {
            pages.push(await context.newPage());
            await openPage(pages[i], ts.httpUrl, 'test-client.html');
        }

        // Create room with size=4
        await pages[0].evaluate(({ wsUrl }) => window.initClient('ms0', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await pages[0].evaluate(() => window.createRoom('ms0', {}, 4));

        // 3 more clients join (total 4 including host)
        for (let i = 1; i < 4; i++) {
            await pages[i].evaluate(({ wsUrl, id }) => window.initClient(id, wsUrl), { wsUrl: ts.wsUrl, id: 'ms' + i });
            await pages[i].evaluate(({ id, roomId }) => window.joinRoom(id, roomId), { id: 'ms' + i, roomId });
        }
        await pages[0].waitForFunction(() => window.participantCount('ms0') === 4, null, { timeout: 2_000 });

        // 5th client should be rejected
        await pages[4].evaluate(({ wsUrl }) => window.initClient('ms4', wsUrl), { wsUrl: ts.wsUrl });
        const err = await pages[4].evaluate(async ({ roomId }) => {
            try { await window.joinRoom('ms4', roomId); return null; }
            catch (e) { return e.message; }
        }, { roomId });
        expect(err).toContain('Room full');

        for (const p of pages) await p.close();
        ts.close();
    });
});
