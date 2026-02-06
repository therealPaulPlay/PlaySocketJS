import { test, expect } from '@playwright/test';
import { createTestServer } from '../helpers/test-server.js';
import { openPage, sleep } from '../helpers/playwright-helpers.js';

test.describe('Server API', () => {

    test('server kick disconnects client with reason', async ({ page }) => {
        const ts = await createTestServer();
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('sr3', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom('sr3', {}));

        ts.server.kick('sr3', 'Cheating detected');

        await page.waitForFunction(() => {
            const ev = window.getEvents('sr3');
            return ev.error.some(e => e.includes('Kicked') && e.includes('Cheating detected'));
        }, null, { timeout: 5_000 });
        ts.close();
    });

    test('server getRoomStorage returns correct state', async ({ page }) => {
        const ts = await createTestServer();
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('sr4', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('sr4', { level: 5 }));

        const storage = ts.server.getRoomStorage(roomId);
        expect(storage.level).toBe(5);
        ts.close();
    });

    test('server updateRoomStorage broadcasts to all room participants', async ({ context }) => {
        const ts = await createTestServer();
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
        ts.close();
    });

    test('server responds to request via updateRoomStorage', async ({ page }) => {
        const ts = await createTestServer({
            eventHandlers: {
                requestReceived: ({ roomId, name }) => {
                    if (name === 'addScore') {
                        ts.server.updateRoomStorage(roomId, 'score', 'set', 100);
                    }
                }
            }
        });
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('sr2', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom('sr2', { score: 0 }));

        await page.evaluate(() => window.sendRequest('sr2', 'addScore'));
        await page.waitForFunction(() => window.getStorage('sr2')?.score === 100, null, { timeout: 5_000 });

        const storage = await page.evaluate(() => window.getStorage('sr2'));
        expect(storage.score).toBe(100);
        ts.close();
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
});
