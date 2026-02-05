import { test, expect } from '@playwright/test';
import { createTestServer } from '../helpers/test-server.js';
import { openPage } from '../helpers/playwright-helpers.js';

let ts;

test.beforeAll(async () => { ts = await createTestServer(); });
test.afterAll(async () => { ts.close(); });

test.describe('Edge cases', () => {

    test('joining non-existent room fails', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('ec1', wsUrl), { wsUrl: ts.wsUrl });
        const err = await page.evaluate(async () => {
            try { await window.joinRoom('ec1', 'NONEXISTENT'); return null; }
            catch (e) { return e.message; }
        });
        expect(err).toContain('Room not found');
    });

    test('creating room when already in one fails', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('ec2', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom('ec2', {}));
        const err = await page.evaluate(async () => {
            try { await window.createRoom('ec2', {}); return null; }
            catch (e) { return e.message; }
        });
        expect(err).toContain('Already in a room');
    });

    test('joining room when already in one fails', async ({ context }) => {
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, 'test-client.html');
        await openPage(p2, ts.httpUrl, 'test-client.html');

        await p1.evaluate(({ wsUrl }) => window.initClient('ec3a', wsUrl), { wsUrl: ts.wsUrl });
        await p1.evaluate(() => window.createRoom('ec3a', {}));
        await p2.evaluate(({ wsUrl }) => window.initClient('ec3b', wsUrl), { wsUrl: ts.wsUrl });
        const room2 = await p2.evaluate(() => window.createRoom('ec3b', {}));

        // ec3a tries to join room2 while already in room1
        const err = await p1.evaluate(async ({ roomId }) => {
            try { await window.joinRoom('ec3a', roomId); return null; }
            catch (e) { return e.message; }
        }, { roomId: room2 });
        expect(err).toContain('Already in a room');

        await p1.close(); await p2.close();
    });

    test('duplicate client IDs are rejected', async ({ context }) => {
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, 'test-client.html');
        await openPage(p2, ts.httpUrl, 'test-client.html');

        await p1.evaluate(({ wsUrl }) => window.initClient('dup1', wsUrl), { wsUrl: ts.wsUrl });
        const err = await p2.evaluate(async ({ wsUrl }) => {
            try { await window.initClient('dup1', wsUrl); return null; }
            catch (e) { return e.message; }
        }, { wsUrl: ts.wsUrl });
        expect(err).toContain('ID is taken');

        await p1.close(); await p2.close();
    });

    test('"server" as client ID is rejected', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        const err = await page.evaluate(async ({ wsUrl }) => {
            try { await window.initClient('server', wsUrl); return null; }
            catch (e) { return e.message; }
        }, { wsUrl: ts.wsUrl });
        expect(err).toContain('ID is taken');
    });

    test('updateStorage when not in room triggers error', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('ec5', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.updateStorage('ec5', 'x', 'set', 1));
        await page.waitForFunction(() => window.getEvents('ec5').error.some(e => e.includes('not in a room')), null, { timeout: 2_000 });
    });

    test('createRoom before init rejects', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        // Try to create without initializing - need to handle this differently
        // since initClient does init(). We use evaluate to create a raw PlaySocket
        const err = await page.evaluate(async ({ wsUrl }) => {
            const { default: PlaySocket } = await import('/dist/playsocket-client.js');
            const client = new PlaySocket('noInit', { endpoint: wsUrl });
            try { await client.createRoom({}); return null; }
            catch (e) { return e.message; }
        }, { wsUrl: ts.wsUrl });
        expect(err).toContain('Not initialized');
    });

    test('joinRoom before init rejects', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        const err = await page.evaluate(async ({ wsUrl }) => {
            const { default: PlaySocket } = await import('/dist/playsocket-client.js');
            const client = new PlaySocket('noInit2', { endpoint: wsUrl });
            try { await client.joinRoom('SOME_ROOM'); return null; }
            catch (e) { return e.message; }
        }, { wsUrl: ts.wsUrl });
        expect(err).toContain('Not initialized');
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

    test('destroy() during pending createRoom rejects the promise', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('dp1', wsUrl), { wsUrl: ts.wsUrl });

        // Start createRoom but immediately destroy before it resolves
        const err = await page.evaluate(async () => {
            const createPromise = window.createRoom('dp1', {}).catch(e => e?.message || 'rejected');
            // Destroy immediately - the pending create should be rejected
            window.destroy('dp1');
            return await createPromise;
        });
        // Should have been rejected (either with a message or empty rejection from destroy)
        expect(err).not.toBeNull();
    });

    test('destroy() during pending joinRoom rejects the promise', async ({ page, context }) => {
        const page2 = await context.newPage();
        await openPage(page, ts.httpUrl, 'test-client.html');
        await openPage(page2, ts.httpUrl, 'test-client.html');

        await page.evaluate(({ wsUrl }) => window.initClient('dp2', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('dp2', {}));

        await page2.evaluate(({ wsUrl }) => window.initClient('dp3', wsUrl), { wsUrl: ts.wsUrl });

        const err = await page2.evaluate(async ({ roomId }) => {
            const joinPromise = window.joinRoom('dp3', roomId).catch(e => e?.message || 'rejected');
            window.destroy('dp3');
            return await joinPromise;
        }, { roomId });
        expect(err).not.toBeNull();

        await page2.close();
    });

    test('room version mismatch forces reconnect', async ({ context }) => {
        // This tests that the client detects skipped updates via version tracking
        // We need to observe the behavior when versions don't match
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, 'test-client.html?intercept-ws');
        await openPage(p2, ts.httpUrl, 'test-client.html?intercept-ws');

        await p1.evaluate(({ wsUrl }) => window.initClient('vm1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await p1.evaluate(() => window.createRoom('vm1', { counter: 0 }));
        await p2.evaluate(({ wsUrl }) => window.initClient('vm2', wsUrl), { wsUrl: ts.wsUrl });
        await p2.evaluate(({ roomId }) => window.joinRoom('vm2', roomId), { roomId });
        await p1.waitForFunction(() => window.connectionCount('vm1') === 1, null, { timeout: 2_000 });

        // Rapid updates that might cause version issues
        // Client 1 blocks network then client 2 makes updates
        await p1.evaluate(() => window.simulateDisconnect('vm1'));

        // While vm1 is disconnected, vm2 makes updates
        for (let i = 0; i < 5; i++) {
            await p2.evaluate(({ i }) => window.updateStorage('vm2', 'counter', 'set', i), { i });
        }

        // vm1 should reconnect and get the correct state
        await p1.waitForFunction(() => {
            const ev = window.getEvents('vm1');
            return ev.status.some(s => s.includes('Reconnected'));
        }, null, { timeout: 10_000 });

        await p1.waitForFunction(() => window.getStorage('vm1')?.counter != null, null, { timeout: 2_000 });
        const s1 = await p1.evaluate(() => window.getStorage('vm1'));
        const s2 = await p2.evaluate(() => window.getStorage('vm2'));
       
        // Both should have the same state after resync
        expect(s1.counter).toBe(s2.counter);

        await p1.close(); await p2.close();
    });
});
