import { test, expect } from '@playwright/test';
import { createTestServer } from '../helpers/test-server.js';
import { openPage, sleep } from '../helpers/playwright-helpers.js';

let ts;

test.beforeAll(async () => { ts = await createTestServer(); });
test.afterAll(async () => { ts.close(); });

test.describe('Client lifecycle', () => {

    test('client can init with provided ID', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        const id = await page.evaluate(({ wsUrl }) => window.initClient('alice', wsUrl), { wsUrl: ts.wsUrl });
        expect(id).toBe('alice');
    });

    test('client can init with no ID and receive server-generated ID', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        const id = await page.evaluate(({ wsUrl }) => window.initClient(null, wsUrl), { wsUrl: ts.wsUrl });
        expect(id).toBeTruthy();
        expect(id.length).toBe(6);
    });

    test('client init with invalid endpoint rejects gracefully', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        const error = await page.evaluate(async () => {
            try { await window.initClient('fail', 'ws://localhost:1'); return null; }
            catch (e) { return e.message; }
        });
        expect(error).toBeTruthy();
    });

    test('createRoom returns room ID and sets initial storage', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('host1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('host1', { score: 0, items: [] }));
        expect(roomId).toBeTruthy();
        expect(roomId.length).toBe(6);

        const storage = await page.evaluate(() => window.getStorage('host1'));
        expect(storage).toEqual({ score: 0, items: [] });

        const isHost = await page.evaluate(() => window.isHost('host1'));
        expect(isHost).toBe(true);
    });

    test('createRoom with no initial storage returns empty storage', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('noStore', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('noStore'));
        expect(roomId).toBeTruthy();

        const storage = await page.evaluate(() => window.getStorage('noStore'));
        expect(storage).toEqual({});

        const isHost = await page.evaluate(() => window.isHost('noStore'));
        expect(isHost).toBe(true);
    });

    test('create + join completes within reasonable time', async ({ page, context }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        const page2 = await context.newPage();
        await openPage(page2, ts.httpUrl, 'test-client.html');

        const start = Date.now();
        await page.evaluate(({ wsUrl }) => window.initClient('timeHost', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('timeHost', { data: 'test' }));
        await page2.evaluate(({ wsUrl }) => window.initClient('timeJoin', wsUrl), { wsUrl: ts.wsUrl });
        await page2.evaluate(({ roomId }) => window.joinRoom('timeJoin', roomId), { roomId });
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(250);
        await page2.close();
    });

    test('joinRoom receives initial storage and updates connection count', async ({ page, context }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        const page2 = await context.newPage();
        await openPage(page2, ts.httpUrl, 'test-client.html');

        await page.evaluate(({ wsUrl }) => window.initClient('h2', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('h2', { msg: 'hello' }));

        await page2.evaluate(({ wsUrl }) => window.initClient('j2', wsUrl), { wsUrl: ts.wsUrl });
        await page2.evaluate(({ roomId }) => window.joinRoom('j2', roomId), { roomId });

        const storage = await page2.evaluate(() => window.getStorage('j2'));
        expect(storage.msg).toBe('hello');

        await page.waitForFunction(() => window.connectionCount('h2') === 1, null, { timeout: 2_000 });
        expect(await page2.evaluate(() => window.connectionCount('j2'))).toBe(1);
        await page2.close();
    });

    test('destroy fires instanceDestroyed and server removes client', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('dest', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('dest', {}));
        await page.evaluate(() => window.destroy('dest'));

        const events = await page.evaluate(() => window.getEvents('dest'));
        expect(events.instanceDestroyed.length).toBeGreaterThan(0);

        // Server should have cleaned up: room destroyed (was single-client)
        await sleep(100);
        expect(ts.server.getRooms[roomId]).toBeUndefined();
    });

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

    test('throwing inside client event handler is caught and does not crash client', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('te1', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.onEvent('te1', 'storageUpdated', () => { throw new Error('Intentional'); }));
        await page.evaluate(() => window.createRoom('te1', { x: 0 }));
        // If the client didn't crash, this should work
        const storage = await page.evaluate(() => window.getStorage('te1'));
        expect(storage.x).toBe(0);
    });

    test('all public getters return correct values', async ({ page, context }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        const page2 = await context.newPage();
        await openPage(page2, ts.httpUrl, 'test-client.html');

        await page.evaluate(({ wsUrl }) => window.initClient('get1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('get1', { val: 5 }));

        // Check host getters
        expect(await page.evaluate(() => window.getId('get1'))).toBe('get1');
        expect(await page.evaluate(() => window.isHost('get1'))).toBe(true);
        expect(await page.evaluate(() => window.connectionCount('get1'))).toBe(0);
        expect(await page.evaluate(() => window.getStorage('get1'))).toEqual({ val: 5 });

        // Join and check joiner getters
        await page2.evaluate(({ wsUrl }) => window.initClient('get2', wsUrl), { wsUrl: ts.wsUrl });
        await page2.evaluate(({ roomId }) => window.joinRoom('get2', roomId), { roomId });
        await page.waitForFunction(() => window.connectionCount('get1') === 1, null, { timeout: 2_000 });

        expect(await page2.evaluate(() => window.getId('get2'))).toBe('get2');
        expect(await page2.evaluate(() => window.isHost('get2'))).toBe(false);
        expect(await page2.evaluate(() => window.connectionCount('get2'))).toBe(1);
        expect(await page2.evaluate(() => window.getStorage('get2'))).toEqual({ val: 5 });
        expect(await page.evaluate(() => window.connectionCount('get1'))).toBe(1);

        await page2.close();
    });
});
