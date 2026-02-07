import { test, expect } from '@playwright/test';
import { createTestServer } from '../helpers/test-server.js';
import { openPage, sleep } from '../helpers/playwright-helpers.js';

test.describe('Server events', () => {

    test('clientRegistrationRequested fires on registration', async ({ page }) => {
        const log = [];
        const ts = await createTestServer({
            eventHandlers: {
                clientRegistrationRequested: (id, customData) => { log.push({ id, customData }); }
            }
        });
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('reg1', wsUrl, { role: 'admin' }), { wsUrl: ts.wsUrl });
        expect(log.some(e => e.id === 'reg1' && e.customData?.role === 'admin')).toBe(true);
        ts.close();
    });

    test('clientRegistrationRequested returns false - registration denied', async ({ page }) => {
        const ts = await createTestServer({
            eventHandlers: { clientRegistrationRequested: () => false }
        });
        await openPage(page, ts.httpUrl, 'test-client.html');
        const err = await page.evaluate(async ({ wsUrl }) => {
            try { await window.initClient('deny1', wsUrl); return null; }
            catch (e) { return e.message; }
        }, { wsUrl: ts.wsUrl });
        expect(err).toContain('Failed to register');
        ts.close();
    });

    test('clientRegistrationRequested returns string - custom rejection', async ({ page }) => {
        const ts = await createTestServer({
            eventHandlers: { clientRegistrationRequested: () => 'Custom denial reason' }
        });
        await openPage(page, ts.httpUrl, 'test-client.html');
        const err = await page.evaluate(async ({ wsUrl }) => {
            try { await window.initClient('deny2', wsUrl); return null; }
            catch (e) { return e.message; }
        }, { wsUrl: ts.wsUrl });
        expect(err).toContain('Custom denial reason');
        ts.close();
    });

    test('clientRegistered fires with clientId and customData', async ({ page }) => {
        const log = [];
        const ts = await createTestServer({
            eventHandlers: { clientRegistered: (id, customData) => { log.push({ id, customData }); } }
        });
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('creg', wsUrl, { name: 'Alice' }), { wsUrl: ts.wsUrl });
        expect(log.some(e => e.id === 'creg' && e.customData?.name === 'Alice')).toBe(true);
        ts.close();
    });

    test('roomCreationRequested - returning object overrides initial storage', async ({ page }) => {
        const ts = await createTestServer({
            eventHandlers: {
                roomCreationRequested: ({ initialStorage }) => {
                    return { ...initialStorage, serverAdded: true };
                }
            }
        });
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('rco1', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom('rco1', { score: 0 }));
        const storage = await page.evaluate(() => window.storage('rco1'));
        expect(storage.serverAdded).toBe(true);
        expect(storage.score).toBe(0);
        ts.close();
    });

    test('roomCreationRequested - client disconnects during async callback cancels room', async ({ page }) => {
        let resolveCallback;
        const callbackPromise = new Promise(r => { resolveCallback = r; });
        const ts = await createTestServer({
            eventHandlers: {
                roomCreationRequested: async () => {
                    await callbackPromise;
                    return true;
                }
            }
        });
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('rcc1', wsUrl), { wsUrl: ts.wsUrl });

        // Start room creation (will block in async callback) and immediately destroy
        page.evaluate(() => window.createRoom('rcc1', {})).catch(() => { });
        await sleep(50);
        await page.evaluate(() => window.destroy('rcc1'));

        // Let the callback complete
        resolveCallback();
        await sleep(50);

        // Room should NOT have been created
        expect(Object.keys(ts.server.rooms).length).toBe(0);
        ts.close();
    });

    test('roomCreationRequested returns false - room creation denied', async ({ page }) => {
        const ts = await createTestServer({
            eventHandlers: { roomCreationRequested: () => false }
        });
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('rcd1', wsUrl), { wsUrl: ts.wsUrl });
        const err = await page.evaluate(async () => {
            try { await window.createRoom('rcd1', {}); return null; }
            catch (e) { return e.message; }
        });
        expect(err).toBeTruthy();
        ts.close();
    });

    test('roomCreated fires with roomId', async ({ page }) => {
        const log = [];
        const ts = await createTestServer({
            eventHandlers: { roomCreated: (roomId) => { log.push(roomId); } }
        });
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('rc1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('rc1', {}));
        expect(log).toContain(roomId);
        ts.close();
    });

    test('clientJoinRequested returns false - join denied', async ({ context }) => {
        const ts = await createTestServer({
            eventHandlers: { clientJoinRequested: () => false }
        });
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, 'test-client.html');
        await openPage(p2, ts.httpUrl, 'test-client.html');

        await p1.evaluate(({ wsUrl }) => window.initClient('jd1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await p1.evaluate(() => window.createRoom('jd1', {}));

        await p2.evaluate(({ wsUrl }) => window.initClient('jd2', wsUrl), { wsUrl: ts.wsUrl });
        const err = await p2.evaluate(async ({ roomId }) => {
            try { await window.joinRoom('jd2', roomId); return null; }
            catch (e) { return e.message; }
        }, { roomId });
        expect(err).toContain('Denied');

        await p1.close(); await p2.close();
        ts.close();
    });

    test('clientJoinRequested returns string - custom rejection reason', async ({ context }) => {
        const ts = await createTestServer({
            eventHandlers: { clientJoinRequested: () => 'Room is locked' }
        });
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, 'test-client.html');
        await openPage(p2, ts.httpUrl, 'test-client.html');

        await p1.evaluate(({ wsUrl }) => window.initClient('jr1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await p1.evaluate(() => window.createRoom('jr1', {}));

        await p2.evaluate(({ wsUrl }) => window.initClient('jr2', wsUrl), { wsUrl: ts.wsUrl });
        const err = await p2.evaluate(async ({ roomId }) => {
            try { await window.joinRoom('jr2', roomId); return null; }
            catch (e) { return e.message; }
        }, { roomId });
        expect(err).toContain('Room is locked');

        await p1.close(); await p2.close();
        ts.close();
    });

    test('clientJoinedRoom fires after successful join', async ({ context }) => {
        const log = [];
        const ts = await createTestServer({
            eventHandlers: { clientJoinedRoom: (clientId, roomId) => { log.push({ clientId, roomId }); } }
        });
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, 'test-client.html');
        await openPage(p2, ts.httpUrl, 'test-client.html');

        await p1.evaluate(({ wsUrl }) => window.initClient('cj1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await p1.evaluate(() => window.createRoom('cj1', {}));
        await p2.evaluate(({ wsUrl }) => window.initClient('cj2', wsUrl), { wsUrl: ts.wsUrl });
        await p2.evaluate(({ roomId }) => window.joinRoom('cj2', roomId), { roomId });

        expect(log.some(e => e.clientId === 'cj2' && e.roomId === roomId)).toBe(true);

        await p1.close(); await p2.close();
        ts.close();
    });

    test('clientDisconnected fires when client disconnects', async ({ page }) => {
        const log = [];
        const ts = await createTestServer({
            eventHandlers: { clientDisconnected: (clientId, roomId) => { log.push({ clientId, roomId }); } }
        });
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('cd1', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom('cd1', {}));
        await page.evaluate(() => window.destroy('cd1'));
        await sleep(100);
        expect(log.some(e => e.clientId === 'cd1')).toBe(true);
        ts.close();
    });

    test('requestReceived fires with correct data', async ({ page }) => {
        const log = [];
        const ts = await createTestServer({
            eventHandlers: {
                requestReceived: ({ roomId, clientId, name, data }) => {
                    log.push({ roomId, clientId, name, data });
                }
            }
        });
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('rr1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('rr1', {}));

        await page.evaluate(() => window.sendRequest('rr1', 'testAction', { foo: 'bar' }));
        await sleep(100);

        expect(log.length).toBeGreaterThan(0);
        const req = log[log.length - 1];
        expect(req.name).toBe('testAction');
        expect(req.data).toEqual({ foo: 'bar' });
        expect(req.clientId).toBe('rr1');
        expect(req.roomId).toBe(roomId);
        ts.close();
    });

    test('storageUpdateRequested returns false - update rejected and state re-synced', async ({ page }) => {
        const ts = await createTestServer({
            eventHandlers: { storageUpdateRequested: () => false }
        });
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('sur1', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom('sur1', { val: 'original' }));

        await page.evaluate(() => window.updateStorage('sur1', 'val', 'set', 'hacked'));
        await page.waitForFunction(() => window.getEvents('sur1').error.some(e => e.includes('rejected')), null, { timeout: 2_000 });

        // Client should be re-synced to original value
        const events = await page.evaluate(() => window.getEvents('sur1'));
        expect(events.error.some(e => e.includes('rejected'))).toBe(true);
        const storage = await page.evaluate(() => window.storage('sur1'));
        expect(storage.val).toBe('original');
        ts.close();
    });

    test('storageUpdated fires on server with correct data', async ({ page }) => {
        const log = [];
        const ts = await createTestServer({
            eventHandlers: { storageUpdated: (data) => { log.push(data); } }
        });
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('su1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('su1', { x: 0 }));
        await page.evaluate(() => window.updateStorage('su1', 'x', 'set', 5));
        await sleep(100);

        const relevant = log.find(e => e.roomId === roomId && e.clientId === 'su1');
        expect(relevant).toBeTruthy();
        expect(relevant.storage.x).toBe(5);
        ts.close();
    });

    test('roomDestroyed fires when room auto-destroys and via destroyRoom', async ({ context }) => {
        const log = [];
        const ts = await createTestServer({
            eventHandlers: { roomDestroyed: (roomId) => { log.push(roomId); } }
        });
        const page = await context.newPage();
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('rd1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('rd1', {}));

        // Auto-destroy: last client leaves
        await page.evaluate(() => window.destroy('rd1'));
        await sleep(100);
        expect(log).toContain(roomId);
        expect(ts.server.rooms[roomId]).toBeUndefined();

        // Server-side destroy
        const room2 = ts.server.createRoom({ test: true });
        expect(ts.server.rooms[room2.id]).toBeDefined();
        ts.server.destroyRoom(room2.id);
        expect(log).toContain(room2.id);
        expect(ts.server.rooms[room2.id]).toBeUndefined();

        await page.close();
        ts.close();
    });

    test('throwing inside server event handler is caught and does not crash server', async ({ page }) => {
        const ts = await createTestServer({
            eventHandlers: { clientRegistered: () => { throw new Error('Test error!'); } }
        });
        await openPage(page, ts.httpUrl, 'test-client.html');
        const id = await page.evaluate(({ wsUrl }) => window.initClient('te1', wsUrl), { wsUrl: ts.wsUrl });
        expect(id).toBe('te1');
        ts.close();
    });
});
