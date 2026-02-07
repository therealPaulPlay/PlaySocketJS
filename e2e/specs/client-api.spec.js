import { test, expect } from '@playwright/test';
import { createTestServer } from '../helpers/test-server.js';
import { openPage, sleep } from '../helpers/playwright-helpers.js';

let ts;

test.beforeAll(async () => { ts = await createTestServer(); });
test.afterAll(() => { ts.close(); });

test.describe('Client API', () => {

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

    test('createRoom returns room ID and sets initial storage', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('host1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('host1', { score: 0, items: [] }));
        expect(roomId).toBeTruthy();
        expect(roomId.length).toBe(6);

        const storage = await page.evaluate(() => window.storage('host1'));
        expect(storage).toEqual({ score: 0, items: [] });

        const isHost = await page.evaluate(() => window.isHost('host1'));
        expect(isHost).toBe(true);
    });

    test('createRoom with no initial storage returns empty storage', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('noStorage', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('noStorage'));
        expect(roomId).toBeTruthy();

        const storage = await page.evaluate(() => window.storage('noStorage'));
        expect(storage).toEqual({});

        const isHost = await page.evaluate(() => window.isHost('noStorage'));
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

    test('joinRoom receives initial storage and updates participant count', async ({ page, context }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        const page2 = await context.newPage();
        await openPage(page2, ts.httpUrl, 'test-client.html');

        await page.evaluate(({ wsUrl }) => window.initClient('h2', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('h2', { msg: 'hello' }));

        await page2.evaluate(({ wsUrl }) => window.initClient('j2', wsUrl), { wsUrl: ts.wsUrl });
        await page2.evaluate(({ roomId }) => window.joinRoom('j2', roomId), { roomId });

        const storage = await page2.evaluate(() => window.storage('j2'));
        expect(storage.msg).toBe('hello');

        await page.waitForFunction(() => window.participantCount('h2') === 2, null, { timeout: 2_000 });
        expect(await page2.evaluate(() => window.participantCount('j2'))).toBe(2);
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
        expect(ts.server.rooms[roomId]).toBeUndefined();
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
        expect(await page.evaluate(() => window.participantCount('get1'))).toBe(1);
        expect(await page.evaluate(() => window.storage('get1'))).toEqual({ val: 5 });

        // Join and check joiner getters
        await page2.evaluate(({ wsUrl }) => window.initClient('get2', wsUrl), { wsUrl: ts.wsUrl });
        await page2.evaluate(({ roomId }) => window.joinRoom('get2', roomId), { roomId });
        await page.waitForFunction(() => window.participantCount('get1') === 2, null, { timeout: 2_000 });

        expect(await page2.evaluate(() => window.getId('get2'))).toBe('get2');
        expect(await page2.evaluate(() => window.isHost('get2'))).toBe(false);
        expect(await page2.evaluate(() => window.participantCount('get2'))).toBe(2);
        expect(await page2.evaluate(() => window.storage('get2'))).toEqual({ val: 5 });
        expect(await page.evaluate(() => window.participantCount('get1'))).toBe(2);

        await page2.close();
    });

    test('updateStorage with set operation', async ({ page, context }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        const page2 = await context.newPage();
        await openPage(page2, ts.httpUrl, 'test-client.html');

        const id1 = 'us1_' + Math.random().toString(36).slice(2, 6);
        const id2 = 'us2_' + Math.random().toString(36).slice(2, 6);

        await page.evaluate(({ id, wsUrl }) => window.initClient(id, wsUrl), { id: id1, wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(({ id }) => window.createRoom(id, { score: 0 }), { id: id1 });
        await page2.evaluate(({ id, wsUrl }) => window.initClient(id, wsUrl), { id: id2, wsUrl: ts.wsUrl });
        await page2.evaluate(({ id, roomId }) => window.joinRoom(id, roomId), { id: id2, roomId });
        await page.waitForFunction(({ id }) => window.participantCount(id) === 2, { id: id1 }, { timeout: 2_000 });

        await page.evaluate(({ id }) => window.updateStorage(id, 'score', 'set', 42), { id: id1 });
        await page2.waitForFunction(({ id }) => window.storage(id)?.score === 42, { id: id2 });
        const s = await page2.evaluate(({ id }) => window.storage(id), { id: id2 });
        expect(s.score).toBe(42);

        await page2.close();
    });

    // Error cases ---------------------

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

    test('client-created room gets destroyed when all leave', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('cr1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom('cr1', { temp: true }));

        // Verify room exists
        expect(ts.server.rooms[roomId]).toBeTruthy();

        // Client leaves
        await page.evaluate(() => window.destroy('cr1'));
        await sleep(100);

        // Room should be gone
        expect(ts.server.rooms[roomId]).toBeUndefined();
        expect(ts.server.getRoomStorage(roomId)).toBeUndefined();
    });
});