import { test, expect } from "@playwright/test";
import { createTestServer } from "../helpers/test-server.js";
import { openPage } from "../helpers/playwright-helpers.js";

let ts;

test.beforeAll(async () => { ts = await createTestServer({ rateLimit: 50 }); });
test.afterAll(() => { ts.close(); });

test.describe("Storage sync", () => {
    let page1, page2, roomId;

    test.beforeEach(async ({ context }) => {
        page1 = await context.newPage();
        page2 = await context.newPage();
        await openPage(page1, ts.httpUrl, "test-client.html");
        await openPage(page2, ts.httpUrl, "test-client.html");

        const id1 = "s1_" + Math.random().toString(36).slice(2, 6);
        const id2 = "s2_" + Math.random().toString(36).slice(2, 6);

        await page1.evaluate(({ id, wsUrl }) => window.initClient(id, wsUrl), { id: id1, wsUrl: ts.wsUrl });
        roomId = await page1.evaluate(({ id }) => window.createRoom(id, { items: [], score: 0 }), { id: id1 });
        await page2.evaluate(({ id, wsUrl }) => window.initClient(id, wsUrl), { id: id2, wsUrl: ts.wsUrl });
        await page2.evaluate(({ id, roomId }) => window.joinRoom(id, roomId), { id: id2, roomId });

        // Store IDs for use in tests
        page1.__cid = id1;
        page2.__cid = id2;
        await page1.waitForFunction(({ id }) => window.participantCount(id) === 2, { id: id1 }, { timeout: 2_000 });
    });

    test.afterEach(async () => {
        await page1.evaluate(({ id }) => window.destroy(id), { id: page1.__cid }).catch(() => { });
        await page2.evaluate(({ id }) => window.destroy(id), { id: page2.__cid }).catch(() => { });
        await page1.close();
        await page2.close();
    });

    // Set operation ------------------

    test("set with object value", async () => {
        await page1.evaluate(({ id }) => window.updateStorage(id, "config", "set", { difficulty: "hard", rounds: 5 }), { id: page1.__cid });
        await page2.waitForFunction(({ id }) => window.storage(id)?.config?.difficulty === "hard", { id: page2.__cid });
        const s = await page2.evaluate(({ id }) => window.storage(id), { id: page2.__cid });
        expect(s.config).toEqual({ difficulty: "hard", rounds: 5 });
    });

    // Array operations --------------

    test("array-add appends items", async () => {
        await page1.evaluate(({ id }) => window.updateStorage(id, "items", "array-add", "apple"), { id: page1.__cid });
        await page1.evaluate(({ id }) => window.updateStorage(id, "items", "array-add", "banana"), { id: page1.__cid });
        await page2.waitForFunction(({ id }) => window.storage(id)?.items?.length === 2, { id: page2.__cid });
        const s = await page2.evaluate(({ id }) => window.storage(id), { id: page2.__cid });
        expect(s.items).toEqual(["apple", "banana"]);
    });

    test("array-add-unique prevents duplicates", async () => {
        await page1.evaluate(({ id }) => window.updateStorage(id, "items", "array-add", "apple"), { id: page1.__cid });
        await page2.waitForFunction(({ id }) => window.storage(id)?.items?.length === 1, { id: page2.__cid }, { timeout: 2_000 });
        await page1.evaluate(({ id }) => window.updateStorage(id, "items", "array-add-unique", "apple"), { id: page1.__cid });
        await page1.evaluate(({ id }) => window.updateStorage(id, "items", "array-add-unique", "banana"), { id: page1.__cid });
        await page2.waitForFunction(({ id }) => window.storage(id)?.items?.length === 2, { id: page2.__cid });
        const s = await page2.evaluate(({ id }) => window.storage(id), { id: page2.__cid });
        expect(s.items).toContain("apple");
        expect(s.items).toContain("banana");
    });

    test("array-remove-matching removes matching items with deep compare", async () => {
        await page1.evaluate(({ id }) => window.updateStorage(id, "items", "array-add", { name: "apple", qty: 1 }), { id: page1.__cid });
        await page1.evaluate(({ id }) => window.updateStorage(id, "items", "array-add", { name: "banana", qty: 2 }), { id: page1.__cid });
        await page2.waitForFunction(({ id }) => window.storage(id)?.items?.length === 2, { id: page2.__cid }, { timeout: 2_000 });
        await page1.evaluate(({ id }) => window.updateStorage(id, "items", "array-remove-matching", { name: "apple", qty: 1 }), { id: page1.__cid });
        await page2.waitForFunction(({ id }) => {
            const s = window.storage(id);
            return s?.items?.length === 1 && s.items[0]?.name === "banana";
        }, { id: page2.__cid });
        const s = await page2.evaluate(({ id }) => window.storage(id), { id: page2.__cid });
        expect(s.items).toEqual([{ name: "banana", qty: 2 }]);
    });

    test("array-update-matching updates first matching item", async () => {
        const player = { id: "p1", score: 0 };
        const updatedPlayer = { id: "p1", score: 100 };
        await page1.evaluate(({ id, player }) => window.updateStorage(id, "items", "set", [player]), { id: page1.__cid, player });
        await page2.waitForFunction(({ id }) => window.storage(id)?.items?.[0]?.score === 0, { id: page2.__cid }, { timeout: 2_000 });
        await page1.evaluate(({ id, player, updatedPlayer }) =>
            window.updateStorage(id, "items", "array-update-matching", player, updatedPlayer),
            { id: page1.__cid, player, updatedPlayer }
        );
        await page2.waitForFunction(({ id }) => window.storage(id)?.items?.[0]?.score === 100, { id: page2.__cid });
        const s = await page2.evaluate(({ id }) => window.storage(id), { id: page2.__cid });
        expect(s.items[0]).toEqual(updatedPlayer);
    });

    test("multiple sequential operations on same key", async () => {
        await page1.evaluate(({ id }) => {
            window.updateStorage(id, "score", "set", 1);
            window.updateStorage(id, "score", "set", 2);
            window.updateStorage(id, "score", "set", 3);
        }, { id: page1.__cid });
        await page2.waitForFunction(({ id }) => window.storage(id)?.score === 3, { id: page2.__cid });
        const s = await page2.evaluate(({ id }) => window.storage(id), { id: page2.__cid });
        expect(s.score).toBe(3);
    });

    // Object operations -----------

    test("object-set-key sets object properties", async () => {
        await page1.evaluate(({ id }) => window.updateStorage(id, "prices", "object-set-key", "flower", 7), { id: page1.__cid });
        await page1.evaluate(({ id }) => window.updateStorage(id, "prices", "object-set-key", "stone", 3), { id: page1.__cid });
        await page2.waitForFunction(({ id }) => window.storage(id)?.prices?.stone === 3, { id: page2.__cid });
        const s = await page2.evaluate(({ id }) => window.storage(id), { id: page2.__cid });
        expect(s.prices).toEqual({ flower: 7, stone: 3 });
    });

    test("object-remove-key removes an object property", async () => {
        await page1.evaluate(({ id }) => window.updateStorage(id, "prices", "set", { flower: 7, stone: 3 }), { id: page1.__cid });
        await page2.waitForFunction(({ id }) => window.storage(id)?.prices?.flower === 7, { id: page2.__cid });
        await page2.evaluate(({ id }) => window.updateStorage(id, "prices", "object-remove-key", "flower"), { id: page2.__cid });
        await page1.waitForFunction(({ id }) => window.storage(id)?.prices?.flower === undefined, { id: page1.__cid });
        const s = await page1.evaluate(({ id }) => window.storage(id), { id: page1.__cid });
        expect(s.prices).toEqual({ stone: 3 });
    });

    // Number operation -----------

    test("number-increment increments and decrements", async () => {
        await page1.evaluate(({ id }) => window.updateStorage(id, "score", "number-increment", 10), { id: page1.__cid });
        await page1.evaluate(({ id }) => window.updateStorage(id, "score", "number-increment", -3), { id: page1.__cid });
        await page2.waitForFunction(({ id }) => window.storage(id)?.score === 7, { id: page2.__cid });
        const s = await page2.evaluate(({ id }) => window.storage(id), { id: page2.__cid });
        expect(s.score).toBe(7);
    });

    // Multi-client sync and convergence ----------------------

    test("3 clients all converge to same state", async ({ context }) => {
        const pages = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
        for (const p of pages) await openPage(p, ts.httpUrl, "test-client.html");

        const ids = ["mc1", "mc2", "mc3"];
        for (const [i, p] of pages.entries()) {
            await p.evaluate(({ id, wsUrl }) => window.initClient(id, wsUrl), { id: ids[i], wsUrl: ts.wsUrl });
        }

        const newRoomId = await pages[0].evaluate(({ id }) => window.createRoom(id, { items: [] }), { id: ids[0] });
        await pages[1].evaluate(({ id, roomId }) => window.joinRoom(id, roomId), { id: ids[1], roomId: newRoomId });
        await pages[2].evaluate(({ id, roomId }) => window.joinRoom(id, roomId), { id: ids[2], roomId: newRoomId });
        await pages[0].waitForFunction(({ id }) => window.participantCount(id) === 3, { id: ids[0] }, { timeout: 2_000 });

        await pages[0].evaluate(({ id }) => window.updateStorage(id, "items", "array-add", "fromA"), { id: ids[0] });
        await pages[1].evaluate(({ id }) => window.updateStorage(id, "items", "array-add", "fromB"), { id: ids[1] });
        await pages[2].evaluate(({ id }) => window.updateStorage(id, "items", "array-add", "fromC"), { id: ids[2] });

        for (const [i, p] of pages.entries()) {
            await p.waitForFunction(({ id }) => window.storage(id)?.items?.length === 3, { id: ids[i] });
        }

        const storages = await Promise.all(pages.map((p, i) =>
            p.evaluate(({ id }) => window.storage(id), { id: ids[i] })
        ));

        // All must contain all 3 items
        for (const s of storages) {
            expect(s.items).toContain("fromA");
            expect(s.items).toContain("fromB");
            expect(s.items).toContain("fromC");
        }

        for (const p of pages) await p.close();
    });

    test("rapid concurrent array-add from two clients - all items present", async ({ context }) => {
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, "test-client.html");
        await openPage(p2, ts.httpUrl, "test-client.html");

        await p1.evaluate(({ wsUrl }) => window.initClient("ra1", wsUrl), { wsUrl: ts.wsUrl });
        const newRoomId = await p1.evaluate(() => window.createRoom("ra1", { nums: [] }));
        await p2.evaluate(({ wsUrl }) => window.initClient("ra2", wsUrl), { wsUrl: ts.wsUrl });
        await p2.evaluate(({ roomId }) => window.joinRoom("ra2", roomId), { roomId: newRoomId });
        await p1.waitForFunction(() => window.participantCount("ra1") === 2, null, { timeout: 2_000 });

        // Both clients rapidly add items concurrently
        await Promise.all([
            p1.evaluate(() => { for (let i = 0; i < 10; i++) window.updateStorage("ra1", "nums", "array-add", "a" + i); }),
            p2.evaluate(() => { for (let i = 0; i < 10; i++) window.updateStorage("ra2", "nums", "array-add", "b" + i); }),
        ]);

        // Wait for convergence
        await p1.waitForFunction(() => window.storage("ra1")?.nums?.length >= 20, null, { timeout: 5_000 });
        await p2.waitForFunction(() => window.storage("ra2")?.nums?.length >= 20, null, { timeout: 5_000 });

        const s1 = await p1.evaluate(() => window.storage("ra1"));
        const s2 = await p2.evaluate(() => window.storage("ra2"));
        expect(s1.nums.length).toBe(20);
        expect(s2.nums.length).toBe(20);

        // All items from both clients should be present
        for (let i = 0; i < 10; i++) {
            expect(s1.nums).toContain("a" + i);
            expect(s1.nums).toContain("b" + i);
        }

        await p1.close(); await p2.close();
    });

    test("concurrent array-update-matching operations converge", async ({ context }) => {
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, "test-client.html");
        await openPage(p2, ts.httpUrl, "test-client.html");

        await p1.evaluate(({ wsUrl }) => window.initClient("au1", wsUrl), { wsUrl: ts.wsUrl });
        const players = [
            { id: "au1", name: "P1", score: 0 },
            { id: "au2", name: "P2", score: 0 }
        ];
        const newRoomId = await p1.evaluate(({ players }) => window.createRoom("au1", { players }), { players });
        await p2.evaluate(({ wsUrl }) => window.initClient("au2", wsUrl), { wsUrl: ts.wsUrl });
        await p2.evaluate(({ roomId }) => window.joinRoom("au2", roomId), { roomId: newRoomId });
        await p1.waitForFunction(() => window.participantCount("au1") === 2, null, { timeout: 2_000 });

        // Each client updates their own player score simultaneously
        await Promise.all([
            p1.evaluate(({ old, upd }) => window.updateStorage("au1", "players", "array-update-matching", old, upd),
                { old: players[0], upd: { ...players[0], score: 50 } }),
            p2.evaluate(({ old, upd }) => window.updateStorage("au2", "players", "array-update-matching", old, upd),
                { old: players[1], upd: { ...players[1], score: 75 } }),
        ]);

        // Wait for both clients to see both players updated
        await p1.waitForFunction(() => {
            const s = window.storage("au1");
            return s?.players?.some(p => p.score === 50) && s?.players?.some(p => p.score === 75);
        }, null, { timeout: 5_000 });
        await p2.waitForFunction(() => {
            const s = window.storage("au2");
            return s?.players?.some(p => p.score === 50) && s?.players?.some(p => p.score === 75);
        }, null, { timeout: 5_000 });

        const s1 = await p1.evaluate(() => window.storage("au1"));
        const s2 = await p2.evaluate(() => window.storage("au2"));

        // Both should converge to the same state
        expect(JSON.stringify(s1.players)).toBe(JSON.stringify(s2.players));

        await p1.close(); await p2.close();
    });

    test("array-add-unique from multiple clients simultaneously", async ({ context }) => {
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, "test-client.html");
        await openPage(p2, ts.httpUrl, "test-client.html");

        await p1.evaluate(({ wsUrl }) => window.initClient("uu1", wsUrl), { wsUrl: ts.wsUrl });
        const newRoomId = await p1.evaluate(() => window.createRoom("uu1", { tags: [] }));
        await p2.evaluate(({ wsUrl }) => window.initClient("uu2", wsUrl), { wsUrl: ts.wsUrl });
        await p2.evaluate(({ roomId }) => window.joinRoom("uu2", roomId), { roomId: newRoomId });
        await p1.waitForFunction(() => window.participantCount("uu1") === 2, null, { timeout: 2_000 });

        // Both add same unique value + different ones
        await Promise.all([
            p1.evaluate(() => {
                window.updateStorage("uu1", "tags", "array-add-unique", "shared");
                window.updateStorage("uu1", "tags", "array-add-unique", "onlyA");
            }),
            p2.evaluate(() => {
                window.updateStorage("uu2", "tags", "array-add-unique", "shared");
                window.updateStorage("uu2", "tags", "array-add-unique", "onlyB");
            }),
        ]);

        // Wait for convergence — both should have all 3 unique tags
        await p1.waitForFunction(() => window.storage("uu1")?.tags?.length >= 3, null, { timeout: 5_000 });
        await p2.waitForFunction(() => window.storage("uu2")?.tags?.length >= 3, null, { timeout: 5_000 });

        const s1 = await p1.evaluate(() => window.storage("uu1"));
        const s2 = await p2.evaluate(() => window.storage("uu2"));

        expect(s1.tags).toContain("shared");
        expect(s1.tags).toContain("onlyA");
        expect(s1.tags).toContain("onlyB");
        // Both should have same state
        expect(s1.tags.sort()).toEqual(s2.tags.sort());

        await p1.close(); await p2.close();
    });

    test("concurrent number-increment from two clients sums up", async ({ context }) => {
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, "test-client.html");
        await openPage(p2, ts.httpUrl, "test-client.html");

        await p1.evaluate(({ wsUrl }) => window.initClient("ni1", wsUrl), { wsUrl: ts.wsUrl });
        const newRoomId = await p1.evaluate(() => window.createRoom("ni1", { score: 0 }));
        await p2.evaluate(({ wsUrl }) => window.initClient("ni2", wsUrl), { wsUrl: ts.wsUrl });
        await p2.evaluate(({ roomId }) => window.joinRoom("ni2", roomId), { roomId: newRoomId });
        await p1.waitForFunction(() => window.participantCount("ni1") === 2, null, { timeout: 2_000 });

        // Both clients increment concurrently — increments must not overwrite each other
        await Promise.all([
            p1.evaluate(() => { for (let i = 0; i < 5; i++) window.updateStorage("ni1", "score", "number-increment", 2); }),
            p2.evaluate(() => { for (let i = 0; i < 5; i++) window.updateStorage("ni2", "score", "number-increment", 4); }),
        ]);

        // Both must converge to the total sum
        await p1.waitForFunction(() => window.storage("ni1")?.score === 30, null, { timeout: 5_000 });
        await p2.waitForFunction(() => window.storage("ni2")?.score === 30, null, { timeout: 5_000 });

        await p1.close(); await p2.close();
    });

    test("concurrent object-set-key on different keys merges both", async ({ context }) => {
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, "test-client.html");
        await openPage(p2, ts.httpUrl, "test-client.html");

        await p1.evaluate(({ wsUrl }) => window.initClient("oc1", wsUrl), { wsUrl: ts.wsUrl });
        const newRoomId = await p1.evaluate(() => window.createRoom("oc1", { prices: {} }));
        await p2.evaluate(({ wsUrl }) => window.initClient("oc2", wsUrl), { wsUrl: ts.wsUrl });
        await p2.evaluate(({ roomId }) => window.joinRoom("oc2", roomId), { roomId: newRoomId });
        await p1.waitForFunction(() => window.participantCount("oc1") === 2, null, { timeout: 2_000 });

        // Both clients set different keys on the same object concurrently
        await Promise.all([
            p1.evaluate(() => window.updateStorage("oc1", "prices", "object-set-key", "flower", 7)),
            p2.evaluate(() => window.updateStorage("oc2", "prices", "object-set-key", "stone", 3)),
        ]);

        // Both keys must be present on both clients
        await p1.waitForFunction(() => {
            const prices = window.storage("oc1")?.prices;
            return prices?.flower === 7 && prices?.stone === 3;
        }, null, { timeout: 5_000 });
        await p2.waitForFunction(() => {
            const prices = window.storage("oc2")?.prices;
            return prices?.flower === 7 && prices?.stone === 3;
        }, null, { timeout: 5_000 });

        await p1.close(); await p2.close();
    });

    test("reactive concurrent updates - shared flag triggers simultaneous score writes", async ({ context }) => {
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, "test-client.html");
        await openPage(p2, ts.httpUrl, "test-client.html");

        const initialStorage = {
            players: [{ id: "rp1", score: 0 }, { id: "rp2", score: 0 }],
            showResult: false,
        };

        await p1.evaluate(({ wsUrl }) => window.initClient("rp1", wsUrl), { wsUrl: ts.wsUrl });
        const newRoomId = await p1.evaluate(({ s }) => window.createRoom("rp1", s), { s: initialStorage });
        await p2.evaluate(({ wsUrl }) => window.initClient("rp2", wsUrl), { wsUrl: ts.wsUrl });
        await p2.evaluate(({ roomId }) => window.joinRoom("rp2", roomId), { roomId: newRoomId });
        await p1.waitForFunction(() => window.participantCount("rp1") === 2, null, { timeout: 2_000 });

        // Register reactive handlers: each client writes their score once when showResult becomes true
        await p1.evaluate(() => {
            window.onEvent("rp1", "storageUpdated", (storage) => {
                if (storage.showResult === true && !window.__scoreWritten_rp1) {
                    window.__scoreWritten_rp1 = true;
                    const score = Math.floor(Math.random() * 500) + 100;
                    window.updateStorage("rp1", "players", "array-update-matching",
                        { id: "rp1", score: 0 }, { id: "rp1", score });
                }
            });
        });
        await p2.evaluate(() => {
            window.onEvent("rp2", "storageUpdated", (storage) => {
                if (storage.showResult === true && !window.__scoreWritten_rp2) {
                    window.__scoreWritten_rp2 = true;
                    const score = Math.floor(Math.random() * 500) + 100;
                    window.updateStorage("rp2", "players", "array-update-matching",
                        { id: "rp2", score: 0 }, { id: "rp2", score });
                }
            });
        });

        // Host sets showResult to true — triggers both reactive score writes
        await p1.evaluate(() => window.updateStorage("rp1", "showResult", "set", true));

        // Wait for both clients to see both scores updated (non-zero)
        await p1.waitForFunction(() => {
            const s = window.storage("rp1");
            return s?.players?.every(p => p.score >= 100);
        }, null, { timeout: 5_000 });
        await p2.waitForFunction(() => {
            const s = window.storage("rp2");
            return s?.players?.every(p => p.score >= 100);
        }, null, { timeout: 5_000 });

        const s1 = await p1.evaluate(() => window.storage("rp1"));
        const s2 = await p2.evaluate(() => window.storage("rp2"));

        // Both must have converged to identical state
        expect(JSON.stringify(s1)).toBe(JSON.stringify(s2));

        // Scores must be valid (100-599 range from random generation)
        expect(s1.players.find(p => p.id === "rp1").score).toBeGreaterThanOrEqual(100);
        expect(s1.players.find(p => p.id === "rp2").score).toBeGreaterThanOrEqual(100);
        expect(s1.showResult).toBe(true);

        await p1.close(); await p2.close();
    });

    test("concurrent mixed operations (all operation types) converge", async ({ context }) => {
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, "test-client.html");
        await openPage(p2, ts.httpUrl, "test-client.html");

        const initialStorage = {
            counter: 0,
            score: 0,
            items: [],
            tags: [],
            levelPlays: {},
            players: [{ id: "p1", score: 0 }, { id: "p2", score: 0 }],
        };

        await p1.evaluate(({ wsUrl }) => window.initClient("mr1", wsUrl), { wsUrl: ts.wsUrl });
        const newRoomId = await p1.evaluate(({ s }) => window.createRoom("mr1", s), { s: initialStorage });
        await p2.evaluate(({ wsUrl }) => window.initClient("mr2", wsUrl), { wsUrl: ts.wsUrl });
        await p2.evaluate(({ roomId }) => window.joinRoom("mr2", roomId), { roomId: newRoomId });
        await p1.waitForFunction(() => window.participantCount("mr1") === 2, null, { timeout: 2_000 });

        // Both clients fire a mix of all operation types concurrently
        await Promise.all([
            p1.evaluate(() => {
                for (let i = 0; i < 5; i++) window.updateStorage("mr1", "counter", "set", i * 10);
                for (let i = 0; i < 5; i++) window.updateStorage("mr1", "score", "number-increment", 2);
                for (let i = 0; i < 5; i++) window.updateStorage("mr1", "items", "array-add", "a" + i);
                window.updateStorage("mr1", "tags", "array-add-unique", "shared");
                window.updateStorage("mr1", "tags", "array-add-unique", "onlyA");
                window.updateStorage("mr1", "players", "array-update-matching", { id: "p1", score: 0 }, { id: "p1", score: 100 });
                window.updateStorage("mr1", "items", "array-remove-matching", "a0");
                window.updateStorage("mr1", "levelPlays", "object-set-key", "levelA", 3);
                window.updateStorage("mr1", "levelPlays", "object-set-key", "obsolete", 1);
                window.updateStorage("mr1", "levelPlays", "object-remove-key", "obsolete");
            }),
            p2.evaluate(() => {
                for (let i = 0; i < 5; i++) window.updateStorage("mr2", "counter", "set", i * 10 + 5);
                for (let i = 0; i < 5; i++) window.updateStorage("mr2", "score", "number-increment", 4);
                for (let i = 0; i < 5; i++) window.updateStorage("mr2", "items", "array-add", "b" + i);
                window.updateStorage("mr2", "tags", "array-add-unique", "shared");
                window.updateStorage("mr2", "tags", "array-add-unique", "onlyB");
                window.updateStorage("mr2", "players", "array-update-matching", { id: "p2", score: 0 }, { id: "p2", score: 200 });
                window.updateStorage("mr2", "items", "array-remove-matching", "b0");
                window.updateStorage("mr2", "levelPlays", "object-set-key", "levelB", 5);
            }),
        ]);

        // Wait for convergence: both clients see both player updates, the summed score, and object operations
        await p1.waitForFunction(() => {
            const s = window.storage("mr1");
            return s?.players?.some(p => p.score === 100) && s?.players?.some(p => p.score === 200) && s?.score === 30
                && s?.levelPlays?.levelA === 3 && s?.levelPlays?.levelB === 5;
        }, null, { timeout: 5_000 });
        await p2.waitForFunction(() => {
            const s = window.storage("mr2");
            return s?.players?.some(p => p.score === 100) && s?.players?.some(p => p.score === 200) && s?.score === 30
                && s?.levelPlays?.levelA === 3 && s?.levelPlays?.levelB === 5;
        }, null, { timeout: 5_000 });

        const s1 = await p1.evaluate(() => window.storage("mr1"));
        const s2 = await p2.evaluate(() => window.storage("mr2"));

        // Both clients must have converged to identical state
        expect(JSON.stringify(s1)).toBe(JSON.stringify(s2));

        // Last-write-wins, value must be one of the values that were set
        expect(s1.counter % 5 === 0).toBe(true);

        // Ensure concurrent increments added up
        expect(s1.score).toBe(30);

        // Ensure object keys from both clients were set and the removed key is gone
        expect(s1.levelPlays).toEqual({ levelA: 3, levelB: 5 });

        // Ensure 'shared' appears exactly once in the tags, both unique tags present
        expect(s1.tags).toContain("shared");
        expect(s1.tags).toContain("onlyA");
        expect(s1.tags).toContain("onlyB");
        expect(s1.tags.filter(t => t === "shared").length).toBe(1);

        // Ensure a0 and b0 were removed, all other items present
        expect(s1.items).not.toContain("a0");
        expect(s1.items).not.toContain("b0");
        for (let i = 1; i < 5; i++) {
            expect(s1.items).toContain("a" + i);
            expect(s1.items).toContain("b" + i);
        }

        // Both scores should be updated
        expect(s1.players.find(p => p.id === "p1").score).toBe(100);
        expect(s1.players.find(p => p.id === "p2").score).toBe(200);

        await p1.close(); await p2.close();
    });
});