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

        pageTs.close();
        ts.server.stop();
        httpServer.close();
    });

    test('stop() closes all connections and server', async ({ page }) => {
        const ts = await createTestServer();
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('st1', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom('st1', {}));

        ts.server.stop();

        // Client should detect disconnection
        await page.waitForFunction(() => {
            const ev = window.getEvents('st1');
            return ev.error.some(e => e.includes('Kicked') && e.includes('Server restart')) &&
                   ev.instanceDestroyed.length > 0;
        }, null, { timeout: 5_000 });
        ts.httpServer.close();
    });

    test('server createRoom creates server-owned room that clients can join', async ({ page }) => {
        const ts = await createTestServer();
        const room = ts.server.createRoom({ lobby: true }, 10);
        expect(room.id).toBeTruthy();
        expect(room.id.length).toBe(6);

        const storage = ts.server.getRoomStorage(room.id);
        expect(storage.lobby).toBe(true);

        // Client can join the server-created room
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('sc1', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(({ roomId }) => window.joinRoom('sc1', roomId), { roomId: room.id });
        const clientStorage = await page.evaluate(() => window.getStorage('sc1'));
        expect(clientStorage.lobby).toBe(true);
        ts.close();
    });

    test('server-created room persists when all clients leave', async ({ page }) => {
        const ts = await createTestServer();
        const room = ts.server.createRoom({ persistent: true });

        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('sp1', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(({ roomId }) => window.joinRoom('sp1', roomId), { roomId: room.id });

        // Client leaves
        await page.evaluate(() => window.destroy('sp1'));
        await sleep(100);

        // Room should still exist (getRooms)
        const rooms = ts.server.getRooms;
        expect(rooms[room.id]).toBeTruthy();

        // Storage should still be there
        const storage = ts.server.getRoomStorage(room.id);
        expect(storage.persistent).toBe(true);
        ts.close();
    });

    test('client-created room gets destroyed when all leave', async ({ page }) => {
        const ts = await createTestServer();
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('cr1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('cr1', { temp: true }));

        // Verify room exists
        expect(ts.server.getRooms[roomId]).toBeTruthy();

        // Client leaves
        await page.evaluate(() => window.destroy('cr1'));
        await sleep(100);

        // Room should be gone
        expect(ts.server.getRooms[roomId]).toBeUndefined();
        expect(ts.server.getRoomStorage(roomId)).toBeUndefined();
        ts.close();
    });

    test('destroyRoom kicks all participants and removes room', async ({ context }) => {
        const ts = await createTestServer();
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, 'test-client.html');
        await openPage(p2, ts.httpUrl, 'test-client.html');

        await p1.evaluate(({ wsUrl }) => window.initClient('dr1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await p1.evaluate(() => window.createRoom('dr1', {}));
        await p2.evaluate(({ wsUrl }) => window.initClient('dr2', wsUrl), { wsUrl: ts.wsUrl });
        await p2.evaluate(({ roomId }) => window.joinRoom('dr2', roomId), { roomId });
        await p1.waitForFunction(() => window.connectionCount('dr1') === 1, null, { timeout: 2_000 });

        ts.server.destroyRoom(roomId);

        // Both clients should be kicked
        await p1.waitForFunction(() => window.getEvents('dr1').error.some(e => e.includes('Kicked')), null, { timeout: 2_000 });
        await p2.waitForFunction(() => window.getEvents('dr2').error.some(e => e.includes('Kicked')), null, { timeout: 2_000 });

        // Room should be gone
        expect(ts.server.getRooms[roomId]).toBeUndefined();

        await p1.close(); await p2.close();
        ts.close();
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
        await pages[0].waitForFunction(() => window.connectionCount('ms0') === 3, null, { timeout: 2_000 });

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
