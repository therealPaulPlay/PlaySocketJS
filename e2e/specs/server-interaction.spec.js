import { test, expect } from '@playwright/test';
import { createTestServer } from '../helpers/test-server.js';
import { openPage, sleep } from '../helpers/playwright-helpers.js';

let ts, requestLog;

test.beforeAll(async () => {
    requestLog = [];
    ts = await createTestServer({
        eventHandlers: {
            requestReceived: ({ roomId, clientId, name, data }) => {
                requestLog.push({ roomId, clientId, name, data });
                if (name === 'addScore') {
                    ts.server.updateRoomStorage(roomId, 'score', 'set', 100);
                }
            }
        }
    });
});
test.afterAll(async () => { ts.close(); });

test.describe('Server interaction', () => {

    test.beforeEach(() => { requestLog.length = 0; });

    test('sendRequest delivers data to server', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('sr1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('sr1', {}));

        await page.evaluate(() => window.sendRequest('sr1', 'testAction', { foo: 'bar' }));
        await sleep(100);

        expect(requestLog.length).toBeGreaterThan(0);
        const req = requestLog[requestLog.length - 1];
        expect(req.name).toBe('testAction');
        expect(req.data).toEqual({ foo: 'bar' });
        expect(req.clientId).toBe('sr1');
        expect(req.roomId).toBe(roomId);
    });

    test('server responds to request via updateRoomStorage', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('sr2', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom('sr2', { score: 0 }));

        await page.evaluate(() => window.sendRequest('sr2', 'addScore'));
        await page.waitForFunction(() => window.getStorage('sr2')?.score === 100, null, { timeout: 5_000 });

        const storage = await page.evaluate(() => window.getStorage('sr2'));
        expect(storage.score).toBe(100);
    });

    test('server kick disconnects client with reason', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('sr3', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom('sr3', {}));

        ts.server.kick('sr3', 'Cheating detected');

        await page.waitForFunction(() => {
            const ev = window.getEvents('sr3');
            return ev.error.some(e => e.includes('Kicked') && e.includes('Cheating detected'));
        }, null, { timeout: 5_000 });
    });

    test('server getRoomStorage returns correct state', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('sr4', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('sr4', { level: 5 }));

        const storage = ts.server.getRoomStorage(roomId);
        expect(storage.level).toBe(5);
    });

    test('server updateRoomStorage broadcasts to all room participants', async ({ context }) => {
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, 'test-client.html');
        await openPage(p2, ts.httpUrl, 'test-client.html');

        await p1.evaluate(({ wsUrl }) => window.initClient('sb1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await p1.evaluate(() => window.createRoom('sb1', { msg: '' }));
        await p2.evaluate(({ wsUrl }) => window.initClient('sb2', wsUrl), { wsUrl: ts.wsUrl });
        await p2.evaluate(({ roomId }) => window.joinRoom('sb2', roomId), { roomId });
        await p1.waitForFunction(() => window.connectionCount('sb1') === 1, null, { timeout: 2_000 });

        ts.server.updateRoomStorage(roomId, 'msg', 'set', 'from-server');

        await p1.waitForFunction(() => window.getStorage('sb1')?.msg === 'from-server', null, { timeout: 5_000 });
        await p2.waitForFunction(() => window.getStorage('sb2')?.msg === 'from-server', null, { timeout: 5_000 });

        const s1 = await p1.evaluate(() => window.getStorage('sb1'));
        const s2 = await p2.evaluate(() => window.getStorage('sb2'));
        expect(s1.msg).toBe('from-server');
        expect(s2.msg).toBe('from-server');

        await p1.close(); await p2.close();
    });
});
