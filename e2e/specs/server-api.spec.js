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
        await p1.waitForFunction(() => window.participantCount('sb1') === 2, null, { timeout: 2_000 });

        ts.server.updateRoomStorage(roomId, 'msg', 'set', 'from-server');

        await p1.waitForFunction(() => window.storage('sb1')?.msg === 'from-server', null, { timeout: 5_000 });
        await p2.waitForFunction(() => window.storage('sb2')?.msg === 'from-server', null, { timeout: 5_000 });

        const s1 = await p1.evaluate(() => window.storage('sb1'));
        const s2 = await p2.evaluate(() => window.storage('sb2'));
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
        await page.waitForFunction(() => window.storage('sr2')?.score === 100, null, { timeout: 5_000 });

        const storage = await page.evaluate(() => window.storage('sr2'));
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
        const clientStorage = await page.evaluate(() => window.storage('sc1'));
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

        // Room should still exist
        const rooms = ts.server.rooms;
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
        await p1.waitForFunction(() => window.participantCount('dr1') === 2, null, { timeout: 2_000 });

        ts.server.destroyRoom(roomId);

        // Both clients should be kicked
        await p1.waitForFunction(() => window.getEvents('dr1').error.some(e => e.includes('Kicked')), null, { timeout: 2_000 });
        await p2.waitForFunction(() => window.getEvents('dr2').error.some(e => e.includes('Kicked')), null, { timeout: 2_000 });

        // Room should be gone
        expect(ts.server.rooms[roomId]).toBeUndefined();

        await p1.close(); await p2.close();
        ts.close();
    });

    test('destroyRoom throws when room not found', async () => {
        const ts = await createTestServer();
        expect(() => ts.server.destroyRoom('NONEXISTENT')).toThrow('Room not found');
        ts.close();
    });

    // move() tests ----------------

    test('move() moves client to different room with correct storage', async ({ page }) => {
        const ts = await createTestServer();
        await openPage(page, ts.httpUrl, 'test-client.html');

        const room1 = ts.server.createRoom({ level: 1, name: 'Room A' });
        const room2 = ts.server.createRoom({ level: 5, name: 'Room B' });

        await page.evaluate(({ wsUrl }) => window.initClient('mv1', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(({ roomId }) => window.joinRoom('mv1', roomId), { roomId: room1.id });
        await page.waitForFunction(() => window.storage('mv1')?.name === 'Room A', null, { timeout: 2_000 });

        ts.server.move('mv1', room2.id);

        // Client should receive new room storage
        await page.waitForFunction(() => window.storage('mv1')?.name === 'Room B', null, { timeout: 2_000 });
        const storage = await page.evaluate(() => window.storage('mv1'));
        expect(storage.level).toBe(5);

        ts.close();
    });

    test('move() updates participant counts and notifies clients in both rooms', async ({ context }) => {
        const ts = await createTestServer();
        const [p1, p2, p3] = await Promise.all([
            context.newPage(), context.newPage(), context.newPage()
        ]);
        await openPage(p1, ts.httpUrl, 'test-client.html');
        await openPage(p2, ts.httpUrl, 'test-client.html');
        await openPage(p3, ts.httpUrl, 'test-client.html');

        const room1 = ts.server.createRoom({});
        const room2 = ts.server.createRoom({});

        // p1 and p2 join room1, p3 joins room2
        await p1.evaluate(({ wsUrl }) => window.initClient('pc1', wsUrl), { wsUrl: ts.wsUrl });
        await p1.evaluate(({ roomId }) => window.joinRoom('pc1', roomId), { roomId: room1.id });
        await p2.evaluate(({ wsUrl }) => window.initClient('pc2', wsUrl), { wsUrl: ts.wsUrl });
        await p2.evaluate(({ roomId }) => window.joinRoom('pc2', roomId), { roomId: room1.id });
        await p3.evaluate(({ wsUrl }) => window.initClient('pc3', wsUrl), { wsUrl: ts.wsUrl });
        await p3.evaluate(({ roomId }) => window.joinRoom('pc3', roomId), { roomId: room2.id });

        await p1.waitForFunction(() => window.participantCount('pc1') === 2, null, { timeout: 2_000 });
        await p3.waitForFunction(() => window.participantCount('pc3') === 1, null, { timeout: 2_000 });

        // Move p2 from room1 to room2
        ts.server.move('pc2', room2.id);

        // Verify participant counts update
        await p1.waitForFunction(() => window.participantCount('pc1') === 1, null, { timeout: 2_000 });
        await p3.waitForFunction(() => window.participantCount('pc3') === 2, null, { timeout: 2_000 });
        await p2.waitForFunction(() => window.participantCount('pc2') === 2, null, { timeout: 2_000 });

        // Verify notifications: p1 sees p2 leave, p3 sees p2 join
        await p1.waitForFunction(() => window.getEvents('pc1').clientLeft.includes('pc2'), null, { timeout: 2_000 });
        await p3.waitForFunction(() => window.getEvents('pc3').clientJoined.includes('pc2'), null, { timeout: 2_000 });

        await p1.close(); await p2.close(); await p3.close();
        ts.close();
    });

    test('move() throws when client not found', async () => {
        const ts = await createTestServer();
        const room = ts.server.createRoom({});
        expect(() => ts.server.move('nonexistent', room.id)).toThrow('Client not found');
        ts.close();
    });

    test('move() throws when client not in a room', async ({ page }) => {
        const ts = await createTestServer();
        await openPage(page, ts.httpUrl, 'test-client.html');

        const room = ts.server.createRoom({});
        await page.evaluate(({ wsUrl }) => window.initClient('noroom', wsUrl), { wsUrl: ts.wsUrl });

        expect(() => ts.server.move('noroom', room.id)).toThrow('Client is not in a room');
        ts.close();
    });

    test('move() throws when target room not found', async ({ page }) => {
        const ts = await createTestServer();
        await openPage(page, ts.httpUrl, 'test-client.html');

        const room = ts.server.createRoom({});
        await page.evaluate(({ wsUrl }) => window.initClient('badtarget', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(({ roomId }) => window.joinRoom('badtarget', roomId), { roomId: room.id });

        expect(() => ts.server.move('badtarget', 'NONEXISTENT')).toThrow('Target room not found');
        ts.close();
    });

    test('move() throws when target room is full', async ({ page }) => {
        const ts = await createTestServer();
        await openPage(page, ts.httpUrl, 'test-client.html');

        const room1 = ts.server.createRoom({});
        const room2 = ts.server.createRoom({}, 1); // size=1

        await page.evaluate(({ wsUrl }) => window.initClient('full1', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(({ roomId }) => window.joinRoom('full1', roomId), { roomId: room1.id });

        // Fill room2
        await page.evaluate(async ({ wsUrl, roomId }) => {
            await window.initClient('full2', wsUrl);
            await window.joinRoom('full2', roomId);
        }, { wsUrl: ts.wsUrl, roomId: room2.id });

        expect(() => ts.server.move('full1', room2.id)).toThrow('Target room is full');
        ts.close();
    });

    test('move() throws when target room is same as current room', async ({ page }) => {
        const ts = await createTestServer();
        await openPage(page, ts.httpUrl, 'test-client.html');

        const room = ts.server.createRoom({ val: 1 });
        await page.evaluate(({ wsUrl }) => window.initClient('same1', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(({ roomId }) => window.joinRoom('same1', roomId), { roomId: room.id });

        expect(() => ts.server.move('same1', room.id)).toThrow('Client is already in target room');
        ts.close();
    });

    test('move() handles storage updates during move without race conditions', async ({ context }) => {
        const ts = await createTestServer();
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, 'test-client.html');
        await openPage(p2, ts.httpUrl, 'test-client.html');

        const room1 = ts.server.createRoom({ counter: 0 });
        const room2 = ts.server.createRoom({ counter: 100 });

        await p1.evaluate(({ wsUrl }) => window.initClient('race1', wsUrl), { wsUrl: ts.wsUrl });
        await p1.evaluate(({ roomId }) => window.joinRoom('race1', roomId), { roomId: room1.id });
        await p2.evaluate(({ wsUrl }) => window.initClient('race2', wsUrl), { wsUrl: ts.wsUrl });
        await p2.evaluate(({ roomId }) => window.joinRoom('race2', roomId), { roomId: room2.id });

        await p1.waitForFunction(() => window.storage('race1')?.counter === 0, null, { timeout: 2_000 });

        // Update storage in room2 right before moving
        ts.server.updateRoomStorage(room2.id, 'counter', 'set', 101);

        // Move p1 to room2
        ts.server.move('race1', room2.id);

        // p1 should have the updated counter value from room2
        await p1.waitForFunction(() => window.storage('race1')?.counter === 101, null, { timeout: 2_000 });

        // Now update room2's counter and verify both clients see it
        ts.server.updateRoomStorage(room2.id, 'counter', 'set', 102);
        await p1.waitForFunction(() => window.storage('race1')?.counter === 102, null, { timeout: 2_000 });
        await p2.waitForFunction(() => window.storage('race2')?.counter === 102, null, { timeout: 2_000 });

        await p1.close(); await p2.close();
        ts.close();
    });

    test('move() triggers host migration when moving host out of room', async ({ context }) => {
        const ts = await createTestServer();
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, 'test-client.html');
        await openPage(p2, ts.httpUrl, 'test-client.html');

        // p1 creates room and becomes host
        await p1.evaluate(({ wsUrl }) => window.initClient('hm1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await p1.evaluate(() => window.createRoom('hm1', {}));

        // p2 joins room
        await p2.evaluate(({ wsUrl }) => window.initClient('hm2', wsUrl), { wsUrl: ts.wsUrl });
        await p2.evaluate(({ roomId }) => window.joinRoom('hm2', roomId), { roomId });
        await p1.waitForFunction(() => window.participantCount('hm1') === 2, null, { timeout: 2_000 });

        expect(await p1.evaluate(() => window.isHost('hm1'))).toBe(true);
        expect(await p2.evaluate(() => window.isHost('hm2'))).toBe(false);

        // Create another room and move the host there
        const room2 = ts.server.createRoom({});
        ts.server.move('hm1', room2.id);

        // p2 should become host in original room
        await p2.waitForFunction(() => window.isHost('hm2') === true, null, { timeout: 2_000 });

        // p2 should get host migration event
        const events = await p2.evaluate(() => window.getEvents('hm2'));
        expect(events.hostMigrated).toContain('hm2');

        await p1.close(); await p2.close();
        ts.close();
    });

    test('move() client can still update storage after move', async ({ page }) => {
        const ts = await createTestServer();
        await openPage(page, ts.httpUrl, 'test-client.html');

        const room1 = ts.server.createRoom({ val: 1 });
        const room2 = ts.server.createRoom({ val: 2 });

        await page.evaluate(({ wsUrl }) => window.initClient('upd1', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(({ roomId }) => window.joinRoom('upd1', roomId), { roomId: room1.id });
        await page.waitForFunction(() => window.storage('upd1')?.val === 1, null, { timeout: 2_000 });

        ts.server.move('upd1', room2.id);
        await page.waitForFunction(() => window.storage('upd1')?.val === 2, null, { timeout: 2_000 });

        // Update storage in new room
        await page.evaluate(() => window.updateStorage('upd1', 'val', 'set', 99));
        await page.waitForFunction(() => window.storage('upd1')?.val === 99, null, { timeout: 2_000 });

        // Verify server received it
        const serverStorage = ts.server.getRoomStorage(room2.id);
        expect(serverStorage.val).toBe(99);

        ts.close();
    });

    test('move() destroys old room when sole participant leaves', async ({ page }) => {
        const ts = await createTestServer();
        await openPage(page, ts.httpUrl, 'test-client.html');

        // Create room as client (not server-owned)
        await page.evaluate(({ wsUrl }) => window.initClient('sole1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('sole1', { data: 1 }));

        // Create target room (server-owned so it persists)
        const room2 = ts.server.createRoom({ data: 2 });

        // Room should exist
        expect(ts.server.rooms[roomId]).toBeDefined();

        // Move the sole participant out
        ts.server.move('sole1', room2.id);

        // Old room should be destroyed
        expect(ts.server.rooms[roomId]).toBeUndefined();

        // Client should be in new room with correct storage
        await page.waitForFunction(() => window.storage('sole1')?.data === 2, null, { timeout: 2_000 });

        ts.close();
    });

    test('move() works for pending disconnect client, they receive new room on reconnect', async ({ page }) => {
        const ts = await createTestServer();
        await openPage(page, ts.httpUrl, 'test-client.html?intercept-ws');

        // Client creates a room (becomes sole participant and host)
        await page.evaluate(({ wsUrl }) => window.initClient('pdc1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('pdc1', { data: 1 }));

        const room2 = ts.server.createRoom({ data: 2 });

        // Room should exist with the client in it
        expect(ts.server.rooms[roomId]).toBeDefined();
        expect(ts.server.rooms[roomId].participants).toContain('pdc1');

        // Client disconnects non-willfully (network drop), enters pending disconnect state
        await page.evaluate(() => {
            window.blockNetwork();
            window.simulateDisconnect('pdc1');
        });
        await sleep(200);

        // Client is now pending disconnect - move should work and transfer them to room2
        ts.server.move('pdc1', room2.id);

        // Old room should be destroyed (sole participant left), client should be in room2
        expect(ts.server.rooms[roomId]).toBeUndefined();
        expect(ts.server.rooms[room2.id].participants).toContain('pdc1');

        // Client reconnects and should receive room2's storage
        await page.evaluate(() => window.unblockNetwork());
        await page.waitForFunction(() => window.getEvents('pdc1').status.some(s => s.includes('Reconnected')));

        const storage = await page.evaluate(() => window.storage('pdc1'));
        expect(storage.data).toBe(2);

        ts.close();
    });
});
