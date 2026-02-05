import { test, expect } from '@playwright/test';
import { createTestServer } from '../helpers/test-server.js';
import { openPage, sleep } from '../helpers/playwright-helpers.js';

let ts;

test.beforeAll(async () => { ts = await createTestServer(); });
test.afterAll(async () => { ts.close(); });

test.describe('Host migration', () => {

    test('host disconnects - next participant becomes host', async ({ context }) => {
        const [p1, p2, p3] = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, 'test-client.html');
        await openPage(p2, ts.httpUrl, 'test-client.html');
        await openPage(p3, ts.httpUrl, 'test-client.html');

        await p1.evaluate(({ wsUrl }) => window.initClient('hm1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await p1.evaluate(() => window.createRoom('hm1', {}));
        await p2.evaluate(({ wsUrl }) => window.initClient('hm2', wsUrl), { wsUrl: ts.wsUrl });
        await p2.evaluate(({ roomId }) => window.joinRoom('hm2', roomId), { roomId });
        await p3.evaluate(({ wsUrl }) => window.initClient('hm3', wsUrl), { wsUrl: ts.wsUrl });
        await p3.evaluate(({ roomId }) => window.joinRoom('hm3', roomId), { roomId });
        await p1.waitForFunction(() => window.connectionCount('hm1') === 2, null, { timeout: 2_000 });

        // Host leaves
        await p1.evaluate(() => window.destroy('hm1'));

        // Wait for host migration to propagate
        await p2.waitForFunction(() => window.isHost('hm2') === true, null, { timeout: 5_000 });

        // p2 should become host, p3 should not
        expect(await p3.evaluate(() => window.isHost('hm3'))).toBe(false);

        // Both p2 and p3 should know about the migration
        await p3.waitForFunction(() => window.getEvents('hm3').hostMigrated.includes('hm2'), null, { timeout: 5_000 });
        const ev2 = await p2.evaluate(() => window.getEvents('hm2'));
        expect(ev2.hostMigrated).toContain('hm2');

        await p1.close(); await p2.close(); await p3.close();
    });

    test('host disconnects from 2-person room - remaining becomes host', async ({ context }) => {
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, 'test-client.html');
        await openPage(p2, ts.httpUrl, 'test-client.html');

        await p1.evaluate(({ wsUrl }) => window.initClient('h2a', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await p1.evaluate(() => window.createRoom('h2a', {}));
        await p2.evaluate(({ wsUrl }) => window.initClient('h2b', wsUrl), { wsUrl: ts.wsUrl });
        await p2.evaluate(({ roomId }) => window.joinRoom('h2b', roomId), { roomId });
        await p1.waitForFunction(() => window.connectionCount('h2a') === 1, null, { timeout: 2_000 });

        await p1.evaluate(() => window.destroy('h2a'));

        await p2.waitForFunction(() => window.isHost('h2b') === true, null, { timeout: 5_000 });
        const ev = await p2.evaluate(() => window.getEvents('h2b'));
        expect(ev.hostMigrated).toContain('h2b');

        await p1.close(); await p2.close();
    });

    test('joining empty room where previous host left and is in reconnect state - joiner becomes host', async ({ context }) => {
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, 'test-client.html?intercept-ws');
        await openPage(p2, ts.httpUrl, 'test-client.html');

        // Create room, then host disconnects (non-willful to keep room alive during grace period)
        await p1.evaluate(({ wsUrl }) => window.initClient('eh1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await p1.evaluate(() => window.createRoom('eh1', { data: 'test' }));

        // Block network so host can't reconnect
        await p1.evaluate(() => {
            window.blockNetwork();
            window.simulateDisconnect('eh1');
        });
        await sleep(200);

        // New client joins the room (host is null since sole participant disconnected)
        await p2.evaluate(({ wsUrl }) => window.initClient('eh2', wsUrl), { wsUrl: ts.wsUrl });
        await p2.evaluate(({ roomId }) => window.joinRoom('eh2', roomId), { roomId });

        // New joiner should become host
        const isHost = await p2.evaluate(() => window.isHost('eh2'));
        expect(isHost).toBe(true);

        const ev = await p2.evaluate(() => window.getEvents('eh2'));
        expect(ev.hostMigrated).toContain('eh2');

        await p1.close(); await p2.close();
    });

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
