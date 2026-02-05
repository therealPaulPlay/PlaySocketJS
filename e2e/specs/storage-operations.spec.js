import { test, expect } from '@playwright/test';
import { createTestServer } from '../helpers/test-server.js';
import { openPage } from '../helpers/playwright-helpers.js';

let ts;

test.beforeAll(async () => { ts = await createTestServer(); });
test.afterAll(async () => { ts.close(); });

test.describe('Storage operations', () => {
    let page1, page2, roomId;

    test.beforeEach(async ({ context }) => {
        page1 = await context.newPage();
        page2 = await context.newPage();
        await openPage(page1, ts.httpUrl, 'test-client.html');
        await openPage(page2, ts.httpUrl, 'test-client.html');

        const id1 = 's1_' + Math.random().toString(36).slice(2, 6);
        const id2 = 's2_' + Math.random().toString(36).slice(2, 6);

        await page1.evaluate(({ id, wsUrl }) => window.initClient(id, wsUrl), { id: id1, wsUrl: ts.wsUrl });
        roomId = await page1.evaluate(({ id }) => window.createRoom(id, { items: [], score: 0 }), { id: id1 });
        await page2.evaluate(({ id, wsUrl }) => window.initClient(id, wsUrl), { id: id2, wsUrl: ts.wsUrl });
        await page2.evaluate(({ id, roomId }) => window.joinRoom(id, roomId), { id: id2, roomId });

        // Store IDs for use in tests
        page1.__cid = id1;
        page2.__cid = id2;
        await page1.waitForFunction(({ id }) => window.connectionCount(id) === 1, { id: id1 }, { timeout: 2_000 });
    });

    test.afterEach(async () => {
        await page1.evaluate(({ id }) => window.destroy(id), { id: page1.__cid }).catch(() => {});
        await page2.evaluate(({ id }) => window.destroy(id), { id: page2.__cid }).catch(() => {});
        await page1.close();
        await page2.close();
    });

    test('set with primitive value', async () => {
        await page1.evaluate(({ id }) => window.updateStorage(id, 'score', 'set', 42), { id: page1.__cid });
        await page2.waitForFunction(({ id }) => window.getStorage(id)?.score === 42, { id: page2.__cid });
        const s = await page2.evaluate(({ id }) => window.getStorage(id), { id: page2.__cid });
        expect(s.score).toBe(42);
    });

    test('set with object value', async () => {
        await page1.evaluate(({ id }) => window.updateStorage(id, 'config', 'set', { difficulty: 'hard', rounds: 5 }), { id: page1.__cid });
        await page2.waitForFunction(({ id }) => window.getStorage(id)?.config?.difficulty === 'hard', { id: page2.__cid });
        const s = await page2.evaluate(({ id }) => window.getStorage(id), { id: page2.__cid });
        expect(s.config).toEqual({ difficulty: 'hard', rounds: 5 });
    });

    test('array-add appends items', async () => {
        await page1.evaluate(({ id }) => window.updateStorage(id, 'items', 'array-add', 'apple'), { id: page1.__cid });
        await page1.evaluate(({ id }) => window.updateStorage(id, 'items', 'array-add', 'banana'), { id: page1.__cid });
        await page2.waitForFunction(({ id }) => window.getStorage(id)?.items?.length === 2, { id: page2.__cid });
        const s = await page2.evaluate(({ id }) => window.getStorage(id), { id: page2.__cid });
        expect(s.items).toEqual(['apple', 'banana']);
    });

    test('array-add-unique prevents duplicates', async () => {
        await page1.evaluate(({ id }) => window.updateStorage(id, 'items', 'array-add', 'apple'), { id: page1.__cid });
        await page2.waitForFunction(({ id }) => window.getStorage(id)?.items?.length === 1, { id: page2.__cid }, { timeout: 2_000 });
        await page1.evaluate(({ id }) => window.updateStorage(id, 'items', 'array-add-unique', 'apple'), { id: page1.__cid });
        await page1.evaluate(({ id }) => window.updateStorage(id, 'items', 'array-add-unique', 'banana'), { id: page1.__cid });
        await page2.waitForFunction(({ id }) => window.getStorage(id)?.items?.length === 2, { id: page2.__cid });
        const s = await page2.evaluate(({ id }) => window.getStorage(id), { id: page2.__cid });
        expect(s.items).toContain('apple');
        expect(s.items).toContain('banana');
    });

    test('array-remove-matching removes matching items with deep compare', async () => {
        await page1.evaluate(({ id }) => window.updateStorage(id, 'items', 'array-add', { name: 'apple', qty: 1 }), { id: page1.__cid });
        await page1.evaluate(({ id }) => window.updateStorage(id, 'items', 'array-add', { name: 'banana', qty: 2 }), { id: page1.__cid });
        await page2.waitForFunction(({ id }) => window.getStorage(id)?.items?.length === 2, { id: page2.__cid }, { timeout: 2_000 });
        await page1.evaluate(({ id }) => window.updateStorage(id, 'items', 'array-remove-matching', { name: 'apple', qty: 1 }), { id: page1.__cid });
        await page2.waitForFunction(({ id }) => {
            const s = window.getStorage(id);
            return s?.items?.length === 1 && s.items[0]?.name === 'banana';
        }, { id: page2.__cid });
        const s = await page2.evaluate(({ id }) => window.getStorage(id), { id: page2.__cid });
        expect(s.items).toEqual([{ name: 'banana', qty: 2 }]);
    });

    test('array-update-matching updates first matching item', async () => {
        const player = { id: 'p1', score: 0 };
        const updatedPlayer = { id: 'p1', score: 100 };
        await page1.evaluate(({ id, player }) => window.updateStorage(id, 'items', 'set', [player]), { id: page1.__cid, player });
        await page2.waitForFunction(({ id }) => window.getStorage(id)?.items?.[0]?.score === 0, { id: page2.__cid }, { timeout: 2_000 });
        await page1.evaluate(({ id, player, updatedPlayer }) =>
            window.updateStorage(id, 'items', 'array-update-matching', player, updatedPlayer),
            { id: page1.__cid, player, updatedPlayer }
        );
        await page2.waitForFunction(({ id }) => window.getStorage(id)?.items?.[0]?.score === 100, { id: page2.__cid });
        const s = await page2.evaluate(({ id }) => window.getStorage(id), { id: page2.__cid });
        expect(s.items[0]).toEqual(updatedPlayer);
    });

    test('multiple sequential operations on same key', async () => {
        await page1.evaluate(({ id }) => {
            window.updateStorage(id, 'score', 'set', 1);
            window.updateStorage(id, 'score', 'set', 2);
            window.updateStorage(id, 'score', 'set', 3);
        }, { id: page1.__cid });
        await page2.waitForFunction(({ id }) => window.getStorage(id)?.score === 3, { id: page2.__cid });
        const s = await page2.evaluate(({ id }) => window.getStorage(id), { id: page2.__cid });
        expect(s.score).toBe(3);
    });

    test('storageUpdated does not fire for no-op updates (same value)', async () => {
        // Set a value, wait for sync, clear events, then set the same value again
        await page1.evaluate(({ id }) => window.updateStorage(id, 'score', 'set', 42), { id: page1.__cid });
        await page2.waitForFunction(({ id }) => window.getStorage(id)?.score === 42, { id: page2.__cid }, { timeout: 2_000 });

        // Clear events on page2 to get a clean baseline
        await page2.evaluate(({ id }) => window.clearEvents(id), { id: page2.__cid });

        // Set the same value again from page1
        await page1.evaluate(({ id }) => window.updateStorage(id, 'score', 'set', 42), { id: page1.__cid });

        // Give it time to arrive
        await new Promise(r => setTimeout(r, 200));

        // Page2 should NOT have received a storageUpdated event since the value didn't change
        const events = await page2.evaluate(({ id }) => window.getEvents(id), { id: page2.__cid });
        expect(events.storageUpdated.length).toBe(0);
    });

    test('storageUpdated fires on receiver and sender', async () => {
        await page1.evaluate(({ id }) => window.updateStorage(id, 'score', 'set', 99), { id: page1.__cid });
        await page2.waitForFunction(({ id }) => window.getStorage(id)?.score === 99, { id: page2.__cid }, { timeout: 2_000 });
        const ev1 = await page1.evaluate(({ id }) => window.getEvents(id), { id: page1.__cid });
        const ev2 = await page2.evaluate(({ id }) => window.getEvents(id), { id: page2.__cid });
        // Sender should have storageUpdated from local update
        const senderUpdates = ev1.storageUpdated.filter(s => s.score === 99);
        expect(senderUpdates.length).toBeGreaterThan(0);
        // Receiver should have storageUpdated from network
        const receiverUpdates = ev2.storageUpdated.filter(s => s.score === 99);
        expect(receiverUpdates.length).toBeGreaterThan(0);
    });
});
