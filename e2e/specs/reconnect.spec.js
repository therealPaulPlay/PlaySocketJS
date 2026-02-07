import { test, expect } from '@playwright/test';
import { createTestServer } from '../helpers/test-server.js';
import { openPage, sleep } from '../helpers/playwright-helpers.js';
import { RECONNECT_GRACE_PERIOD } from '../../src/server/server.js';

let ts;

test.beforeAll(async () => { ts = await createTestServer(); });
test.afterAll(() => { ts.close(); });

test.describe('Reconnection', () => {

    test('client reconnects after drop and storage is preserved', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html?intercept-ws');
        await page.evaluate(({ wsUrl }) => window.initClient('rc1', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom('rc1', { score: 42 }));

        // Simulate disconnect
        await page.evaluate(() => window.simulateDisconnect('rc1'));

        // Wait for reconnection
        await page.waitForFunction(() => {
            const ev = window.getEvents('rc1');
            return ev.status.some(s => s.includes('Reconnected'));
        }, null, { timeout: 10_000 });

        const storage = await page.evaluate(() => window.storage('rc1'));
        expect(storage.score).toBe(42);
    });

    test('client can update storage after reconnection', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html?intercept-ws');
        await page.evaluate(({ wsUrl }) => window.initClient('rc2', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom('rc2', { val: 'initial' }));

        await page.evaluate(() => window.simulateDisconnect('rc2'));
        await page.waitForFunction(() => {
            const ev = window.getEvents('rc2');
            return ev.status.some(s => s.includes('Reconnected'));
        }, null, { timeout: 10_000 });

        await page.evaluate(() => window.updateStorage('rc2', 'val', 'set', 'after-reconnect'));
        await page.waitForFunction(() => window.storage('rc2')?.val === 'after-reconnect', null, { timeout: 2_000 });
    });

    test('two clients: one reconnects, other stays, both sync after', async ({ context }) => {
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, 'test-client.html?intercept-ws');
        await openPage(p2, ts.httpUrl, 'test-client.html?intercept-ws');

        await p1.evaluate(({ wsUrl }) => window.initClient('rs1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await p1.evaluate(() => window.createRoom('rs1', { items: [] }));
        await p2.evaluate(({ wsUrl }) => window.initClient('rs2', wsUrl), { wsUrl: ts.wsUrl });
        await p2.evaluate(({ roomId }) => window.joinRoom('rs2', roomId), { roomId });
        await p1.waitForFunction(() => window.participantCount('rs1') === 2, null, { timeout: 2_000 });

        // Client 1 disconnects
        await p1.evaluate(() => window.simulateDisconnect('rs1'));

        // Client 2 adds data while client 1 is disconnected
        await p2.evaluate(() => window.updateStorage('rs2', 'items', 'array-add', 'while-offline'));

        // Wait for client 1 to reconnect
        await p1.waitForFunction(() => {
            const ev = window.getEvents('rs1');
            return ev.status.some(s => s.includes('Reconnected'));
        }, null, { timeout: 10_000 });

        // Client 1 should get the updated state
        await p1.waitForFunction(() => window.storage('rs1')?.items?.includes('while-offline'), null, { timeout: 2_000 });

        // Both can still sync
        await p1.evaluate(() => window.updateStorage('rs1', 'items', 'array-add', 'after-reconnect'));
        await p2.waitForFunction(() => window.storage('rs2')?.items?.length >= 2, null, { timeout: 5_000 });
        const s2 = await p2.evaluate(() => window.storage('rs2'));
        expect(s2.items).toContain('after-reconnect');

        await p1.close(); await p2.close();
    });

    test('local updates during disconnect are discarded on reconnect', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html?intercept-ws');
        await page.evaluate(({ wsUrl }) => window.initClient('lo1', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom('lo1', { counter: 0 }));

        // Block network, disconnect, then make local updates that should be discarded
        await page.evaluate(() => {
            window.blockNetwork();
            window.simulateDisconnect('lo1');
            window.updateStorage('lo1', 'counter', 'set', 999);
        });

        // Unblock and let client reconnect — importState overwrites local CRDT state
        await page.evaluate(() => window.unblockNetwork());
        await page.waitForFunction(() => {
            const ev = window.getEvents('lo1');
            return ev.status.some(s => s.includes('Reconnected'));
        }, null, { timeout: 10_000 });

        const storage = await page.evaluate(() => window.storage('lo1'));
        expect(storage.counter).toBe(0);
    });

    test('network blocked too long - client fails to reconnect', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html?intercept-ws');
        await page.evaluate(({ wsUrl }) => window.initClient('rc3', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom('rc3', {}));

        // Block network and disconnect
        await page.evaluate(() => {
            window.blockNetwork();
            window.simulateDisconnect('rc3');
        });

        // Wait for instance to be destroyed (max 9 retries * 500ms + timeouts)
        await page.waitForFunction(() => {
            const ev = window.getEvents('rc3');
            return ev.instanceDestroyed.length > 0 && ev.error.some(e => e.includes('Disconnected from server'));
        }, null, { timeout: 30_000 });

        await page.evaluate(() => window.unblockNetwork());
    });

    test('room destroyed by server during reconnection phase - client reconnects but finds no room', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html?intercept-ws');
        await page.evaluate(({ wsUrl }) => window.initClient('rd1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('rd1', { data: 1 }));

        expect(ts.server.rooms[roomId]).toBeDefined();

        // Block network and disconnect (client is still known to server within grace period)
        await page.evaluate(() => {
            window.blockNetwork();
            window.simulateDisconnect('rd1');
        });

        // Wait for server to register the disconnect and set up the pending reconnect entry
        await sleep(200);

        // Server explicitly destroys the room while client is disconnected
        ts.server.destroyRoom(roomId);

        // Unblock - client reconnects successfully but room is gone
        await page.evaluate(() => window.unblockNetwork());

        await page.waitForFunction(() => {
            const ev = window.getEvents('rd1');
            return ev.instanceDestroyed.length > 0 && ev.error.some(e => e.includes('room no longer exists'));
        }, null, { timeout: 10_000 });
    });

    test('grace period expires while disconnected - client and room cleaned up', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html?intercept-ws');
        await page.evaluate(({ wsUrl }) => window.initClient('gp1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('gp1', {}));

        // Room should exist on the server before disconnect
        expect(ts.server.rooms[roomId]).toBeDefined();

        // Block network and disconnect
        await page.evaluate(() => {
            window.blockNetwork();
            window.simulateDisconnect('gp1');
        });

        // Wait for grace period to expire
        await sleep(RECONNECT_GRACE_PERIOD + 500);

        // Room should be destroyed on the server after grace period
        expect(ts.server.rooms[roomId]).toBeUndefined();

        // Unblock - client tries to reconnect but server no longer knows it
        await page.evaluate(() => window.unblockNetwork());

        await page.waitForFunction(() => {
            const ev = window.getEvents('gp1');
            return ev.instanceDestroyed.length > 0 && ev.error.some(e => e.includes('Disconnected from server'));
        }, null, { timeout: 20_000 });
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
        await p1.waitForFunction(() => window.participantCount('vm1') === 2, null, { timeout: 2_000 });

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

        await p1.waitForFunction(() => window.storage('vm1')?.counter != null, null, { timeout: 2_000 });
        const s1 = await p1.evaluate(() => window.storage('vm1'));
        const s2 = await p2.evaluate(() => window.storage('vm2'));

        // Both should have the same state after resync
        expect(s1.counter).toBe(s2.counter);

        await p1.close(); await p2.close();
    });

    // Host migration during reconnection --------------

    test('client joins while host is reconnecting - new client becomes host, host reconnects, both should accept new client as host', async ({ context }) => {
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, 'test-client.html?intercept-ws');
        await openPage(p2, ts.httpUrl, 'test-client.html');

        // p1 creates room (becomes host), then disconnects non-willfully
        await p1.evaluate(({ wsUrl }) => window.initClient('hmr1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await p1.evaluate(() => window.createRoom('hmr1', { data: 1 }));

        // Block p1's network so it can't auto-reconnect before p2 joins
        await p1.evaluate(() => {
            window.blockNetwork();
            window.simulateDisconnect('hmr1');
        });
        await sleep(200);

        // p2 joins while p1 is in reconnect grace period — should become host
        await p2.evaluate(({ wsUrl }) => window.initClient('hmr2', wsUrl), { wsUrl: ts.wsUrl });
        await p2.evaluate(({ roomId }) => window.joinRoom('hmr2', roomId), { roomId });
        await p2.waitForFunction(() => window.isHost('hmr2') === true, null, { timeout: 2_000 });

        // Unblock p1's network so it can reconnect
        await p1.evaluate(() => window.unblockNetwork());

        // Wait for p1 to reconnect
        await p1.waitForFunction(() => {
            const ev = window.getEvents('hmr1');
            return ev.status.some(s => s.includes('Reconnected'));
        }, null, { timeout: 10_000 });

        // Both should agree that p2 is the host
        expect(await p1.evaluate(() => window.isHost('hmr1'))).toBe(false);
        expect(await p2.evaluate(() => window.isHost('hmr2'))).toBe(true);

        await p1.close(); await p2.close();
    });

    test('host disconnects and reconnects as sole member - becomes host again', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html?intercept-ws');
        await page.evaluate(({ wsUrl }) => window.initClient('rch', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom('rch', { val: 1 }));

        expect(await page.evaluate(() => window.isHost('rch'))).toBe(true);

        // Simulate disconnect (non-willful)
        await page.evaluate(() => window.simulateDisconnect('rch'));

        // Wait for reconnect
        await page.waitForFunction(() => {
            const ev = window.getEvents('rch');
            return ev.status.some(s => s.includes('Reconnected'));
        }, null, { timeout: 10_000 });

        await page.waitForFunction(() => window.isHost('rch') === true, null, { timeout: 2_000 });
    });
});
