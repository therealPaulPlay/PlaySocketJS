import { test, expect } from '@playwright/test';
import { createTestServer } from '../helpers/test-server.js';
import { openPage } from '../helpers/playwright-helpers.js';

let ts;

test.beforeAll(async () => { ts = await createTestServer(); });
test.afterAll(async () => { ts.close(); });

test.describe('Client events', () => {

    test('status events fire in correct order through lifecycle', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('stat', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom('stat', {}));

        const events = await page.evaluate(() => window.getEvents('stat'));
        expect(events.status).toContain('Initializing...');
        expect(events.status).toContain('Connected to server.');
        expect(events.status).toContain('Room created.');
    });

    test('clientConnected fires on host when another client joins', async ({ page, context }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        const page2 = await context.newPage();
        await openPage(page2, ts.httpUrl, 'test-client.html');

        await page.evaluate(({ wsUrl }) => window.initClient('cc1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('cc1', {}));

        await page2.evaluate(({ wsUrl }) => window.initClient('cc2', wsUrl), { wsUrl: ts.wsUrl });
        await page2.evaluate(({ roomId }) => window.joinRoom('cc2', roomId), { roomId });

        await page.waitForFunction(() => window.getEvents('cc1').clientConnected.includes('cc2'), null, { timeout: 5_000 });
        await page2.close();
    });

    test('clientDisconnected fires when a client leaves', async ({ page, context }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        const page2 = await context.newPage();
        await openPage(page2, ts.httpUrl, 'test-client.html');

        await page.evaluate(({ wsUrl }) => window.initClient('cd1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('cd1', {}));

        await page2.evaluate(({ wsUrl }) => window.initClient('cd2', wsUrl), { wsUrl: ts.wsUrl });
        await page2.evaluate(({ roomId }) => window.joinRoom('cd2', roomId), { roomId });
        await page.waitForFunction(() => window.getEvents('cd1').clientConnected.includes('cd2'), null, { timeout: 2_000 });
        await page2.evaluate(() => window.destroy('cd2'));

        await page.waitForFunction(() => window.getEvents('cd1').clientDisconnected.includes('cd2'), null, { timeout: 5_000 });
        await page2.close();
    });

    test('all participants get notified about joins and leaves', async ({ page, context }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        const page2 = await context.newPage();
        await openPage(page2, ts.httpUrl, 'test-client.html');
        const page3 = await context.newPage();
        await openPage(page3, ts.httpUrl, 'test-client.html');

        await page.evaluate(({ wsUrl }) => window.initClient('n1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('n1', {}));

        await page2.evaluate(({ wsUrl }) => window.initClient('n2', wsUrl), { wsUrl: ts.wsUrl });
        await page2.evaluate(({ roomId }) => window.joinRoom('n2', roomId), { roomId });
        await page.waitForFunction(() => window.getEvents('n1').clientConnected.includes('n2'), null, { timeout: 2_000 });

        await page3.evaluate(({ wsUrl }) => window.initClient('n3', wsUrl), { wsUrl: ts.wsUrl });
        await page3.evaluate(({ roomId }) => window.joinRoom('n3', roomId), { roomId });

        // Both p1 and p2 should know about n3 joining
        await page.waitForFunction(() => window.getEvents('n1').clientConnected.includes('n3'), null, { timeout: 5_000 });
        await page2.waitForFunction(() => window.getEvents('n2').clientConnected.includes('n3'), null, { timeout: 5_000 });

        // Now n2 leaves - p1 and p3 should be notified
        await page2.evaluate(() => window.destroy('n2'));

        await page.waitForFunction(() => window.getEvents('n1').clientDisconnected.includes('n2'), null, { timeout: 5_000 });
        await page3.waitForFunction(() => window.getEvents('n3').clientDisconnected.includes('n2'), null, { timeout: 5_000 });

        await page2.close();
        await page3.close();
    });

    test('storageUpdated fires before createRoom and joinRoom resolve', async ({ page, context }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        const page2 = await context.newPage();
        await openPage(page2, ts.httpUrl, 'test-client.html');

        await page.evaluate(({ wsUrl }) => window.initClient('so1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(async () => {
            const roomId = await window.createRoom('so1', { val: 1 });
            window.__createStorageEvents = window.getEvents('so1').storageUpdated.length;
            return roomId;
        });
        expect(await page.evaluate(() => window.__createStorageEvents)).toBeGreaterThan(0);

        await page2.evaluate(({ wsUrl }) => window.initClient('so2', wsUrl), { wsUrl: ts.wsUrl });
        await page2.evaluate(async ({ roomId }) => {
            await window.joinRoom('so2', roomId);
            window.__joinStorageEvents = window.getEvents('so2').storageUpdated.length;
        }, { roomId });
        expect(await page2.evaluate(() => window.__joinStorageEvents)).toBeGreaterThan(0);

        await page2.close();
    });

    test('storageUpdated does not fire for no-op updates (same value)', async ({ page, context }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        const page2 = await context.newPage();
        await openPage(page2, ts.httpUrl, 'test-client.html');

        const id1 = 'noop1_' + Math.random().toString(36).slice(2, 6);
        const id2 = 'noop2_' + Math.random().toString(36).slice(2, 6);

        await page.evaluate(({ id, wsUrl }) => window.initClient(id, wsUrl), { id: id1, wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(({ id }) => window.createRoom(id, { score: 0 }), { id: id1 });
        await page2.evaluate(({ id, wsUrl }) => window.initClient(id, wsUrl), { id: id2, wsUrl: ts.wsUrl });
        await page2.evaluate(({ id, roomId }) => window.joinRoom(id, roomId), { id: id2, roomId });
        await page.waitForFunction(({ id }) => window.connectionCount(id) === 1, { id: id1 }, { timeout: 2_000 });

        // Set a value, wait for sync, clear events, then set the same value again
        await page.evaluate(({ id }) => window.updateStorage(id, 'score', 'set', 42), { id: id1 });
        await page2.waitForFunction(({ id }) => window.getStorage(id)?.score === 42, { id: id2 }, { timeout: 2_000 });

        // Clear events on page2 to get a clean baseline
        await page2.evaluate(({ id }) => window.clearEvents(id), { id: id2 });

        // Set the same value again from page
        await page.evaluate(({ id }) => window.updateStorage(id, 'score', 'set', 42), { id: id1 });

        // Give it time to arrive
        await new Promise(r => setTimeout(r, 200));

        // Page2 should NOT have received a storageUpdated event since the value didn't change
        const events = await page2.evaluate(({ id }) => window.getEvents(id), { id: id2 });
        expect(events.storageUpdated.length).toBe(0);

        await page2.close();
    });

    test('storageUpdated fires on receiver and sender', async ({ page, context }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        const page2 = await context.newPage();
        await openPage(page2, ts.httpUrl, 'test-client.html');

        const id1 = 'su1_' + Math.random().toString(36).slice(2, 6);
        const id2 = 'su2_' + Math.random().toString(36).slice(2, 6);

        await page.evaluate(({ id, wsUrl }) => window.initClient(id, wsUrl), { id: id1, wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(({ id }) => window.createRoom(id, { score: 0 }), { id: id1 });
        await page2.evaluate(({ id, wsUrl }) => window.initClient(id, wsUrl), { id: id2, wsUrl: ts.wsUrl });
        await page2.evaluate(({ id, roomId }) => window.joinRoom(id, roomId), { id: id2, roomId });
        await page.waitForFunction(({ id }) => window.connectionCount(id) === 1, { id: id1 }, { timeout: 2_000 });

        await page.evaluate(({ id }) => window.updateStorage(id, 'score', 'set', 99), { id: id1 });
        await page2.waitForFunction(({ id }) => window.getStorage(id)?.score === 99, { id: id2 }, { timeout: 2_000 });
        const ev1 = await page.evaluate(({ id }) => window.getEvents(id), { id: id1 });
        const ev2 = await page2.evaluate(({ id }) => window.getEvents(id), { id: id2 });
        // Sender should have storageUpdated from local update
        const senderUpdates = ev1.storageUpdated.filter(s => s.score === 99);
        expect(senderUpdates.length).toBeGreaterThan(0);
        // Receiver should have storageUpdated from network
        const receiverUpdates = ev2.storageUpdated.filter(s => s.score === 99);
        expect(receiverUpdates.length).toBeGreaterThan(0);

        await page2.close();
    });

    // Host migration events

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
        await new Promise(r => setTimeout(r, 200));

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

    test('throwing inside client event handler is caught and does not crash client', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('te1', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.onEvent('te1', 'storageUpdated', () => { throw new Error('Test error!'); }));
        await page.evaluate(() => window.createRoom('te1', { x: 0 }));
        // If the client didn't crash, this should work
        const storage = await page.evaluate(() => window.getStorage('te1'));
        expect(storage.x).toBe(0);
    });
});
