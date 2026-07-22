import { test, expect } from "@playwright/test";
import { createTestServer } from "../helpers/test-server.js";
import { openPage, sleep } from "../helpers/playwright-helpers.js";

test.describe("Server events", () => {

    test("clientRegistrationRequested fires on registration", async ({ page }) => {
        const log = [];
        const ts = await createTestServer({
            eventHandlers: {
                clientRegistrationRequested: (id, customData) => { log.push({ id, customData }); }
            }
        });
        await openPage(page, ts.httpUrl, "test-client.html");
        await page.evaluate(({ wsUrl }) => window.initClient("reg1", wsUrl, { role: "admin" }), { wsUrl: ts.wsUrl });
        expect(log.some(e => e.id === "reg1" && e.customData?.role === "admin")).toBe(true);
        ts.close();
    });

    test("clientRegistrationRequested returns false - registration denied", async ({ page }) => {
        const ts = await createTestServer({
            eventHandlers: { clientRegistrationRequested: () => false }
        });
        await openPage(page, ts.httpUrl, "test-client.html");
        const err = await page.evaluate(async ({ wsUrl }) => {
            try { await window.initClient("deny1", wsUrl); return null; }
            catch (e) { return e.message; }
        }, { wsUrl: ts.wsUrl });
        expect(err).toContain("Failed to register");
        ts.close();
    });

    test("clientRegistrationRequested returns string - custom rejection", async ({ page }) => {
        const ts = await createTestServer({
            eventHandlers: { clientRegistrationRequested: () => "Custom denial reason" }
        });
        await openPage(page, ts.httpUrl, "test-client.html");
        const err = await page.evaluate(async ({ wsUrl }) => {
            try { await window.initClient("deny2", wsUrl); return null; }
            catch (e) { return e.message; }
        }, { wsUrl: ts.wsUrl });
        expect(err).toContain("Custom denial reason");
        ts.close();
    });

    test("clientRegistered fires with clientId and customData", async ({ page }) => {
        const log = [];
        const ts = await createTestServer({
            eventHandlers: { clientRegistered: (id, customData) => { log.push({ id, customData }); } }
        });
        await openPage(page, ts.httpUrl, "test-client.html");
        await page.evaluate(({ wsUrl }) => window.initClient("creg", wsUrl, { name: "Alice" }), { wsUrl: ts.wsUrl });
        expect(log.some(e => e.id === "creg" && e.customData?.name === "Alice")).toBe(true);
        ts.close();
    });

    test("roomCreationRequested - returning object overrides initial storage", async ({ page }) => {
        const ts = await createTestServer({
            eventHandlers: {
                roomCreationRequested: ({ initialStorage }) => {
                    return { ...initialStorage, serverAdded: true };
                }
            }
        });
        await openPage(page, ts.httpUrl, "test-client.html");
        await page.evaluate(({ wsUrl }) => window.initClient("rco1", wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom("rco1", { score: 0 }));
        const storage = await page.evaluate(() => window.storage("rco1"));
        expect(storage.serverAdded).toBe(true);
        expect(storage.score).toBe(0);
        ts.close();
    });

    test("roomCreationRequested - client disconnects during async callback cancels room", async ({ page }) => {
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
        await openPage(page, ts.httpUrl, "test-client.html");
        await page.evaluate(({ wsUrl }) => window.initClient("rcc1", wsUrl), { wsUrl: ts.wsUrl });

        // Start room creation (will block in async callback) and immediately destroy
        page.evaluate(() => window.createRoom("rcc1", {})).catch(() => { });
        await sleep(50);
        await page.evaluate(() => window.destroy("rcc1"));

        // Let the callback complete
        resolveCallback();
        await sleep(50);

        // Room should NOT have been created
        expect(Object.keys(ts.server.rooms).length).toBe(0);
        ts.close();
    });

    test("roomCreationRequested returns false - room creation denied", async ({ page }) => {
        const ts = await createTestServer({
            eventHandlers: { roomCreationRequested: () => false }
        });
        await openPage(page, ts.httpUrl, "test-client.html");
        await page.evaluate(({ wsUrl }) => window.initClient("rcd1", wsUrl), { wsUrl: ts.wsUrl });
        const err = await page.evaluate(async () => {
            try { await window.createRoom("rcd1", {}); return null; }
            catch (e) { return e.message; }
        });
        expect(err).toBeTruthy();
        ts.close();
    });

    test("roomCreationRequested returns string - custom rejection reason", async ({ page }) => {
        const ts = await createTestServer({
            eventHandlers: { roomCreationRequested: () => "Room not allowed" }
        });
        await openPage(page, ts.httpUrl, "test-client.html");
        await page.evaluate(({ wsUrl }) => window.initClient("rcd2", wsUrl), { wsUrl: ts.wsUrl });
        const err = await page.evaluate(async () => {
            try { await window.createRoom("rcd2", {}); return null; }
            catch (e) { return e.message; }
        });
        expect(err).toContain("Room not allowed");
        ts.close();
    });

    test("roomCreated fires with roomId", async ({ page }) => {
        const log = [];
        const ts = await createTestServer({
            eventHandlers: { roomCreated: (roomId) => { log.push(roomId); } }
        });
        await openPage(page, ts.httpUrl, "test-client.html");
        await page.evaluate(({ wsUrl }) => window.initClient("rc1", wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom("rc1", {}));
        expect(log).toContain(roomId);
        ts.close();
    });

    test("clientJoinRequested returns false - join denied", async ({ context }) => {
        const ts = await createTestServer({
            eventHandlers: { clientJoinRequested: () => false }
        });
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, "test-client.html");
        await openPage(p2, ts.httpUrl, "test-client.html");

        await p1.evaluate(({ wsUrl }) => window.initClient("jd1", wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await p1.evaluate(() => window.createRoom("jd1", {}));

        await p2.evaluate(({ wsUrl }) => window.initClient("jd2", wsUrl), { wsUrl: ts.wsUrl });
        const err = await p2.evaluate(async ({ roomId }) => {
            try { await window.joinRoom("jd2", roomId); return null; }
            catch (e) { return e.message; }
        }, { roomId });
        expect(err).toContain("No reason provided");

        await p1.close(); await p2.close();
        ts.close();
    });

    test("clientJoinRequested returns string - custom rejection reason", async ({ context }) => {
        const ts = await createTestServer({
            eventHandlers: { clientJoinRequested: () => "Room is locked" }
        });
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, "test-client.html");
        await openPage(p2, ts.httpUrl, "test-client.html");

        await p1.evaluate(({ wsUrl }) => window.initClient("jr1", wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await p1.evaluate(() => window.createRoom("jr1", {}));

        await p2.evaluate(({ wsUrl }) => window.initClient("jr2", wsUrl), { wsUrl: ts.wsUrl });
        const err = await p2.evaluate(async ({ roomId }) => {
            try { await window.joinRoom("jr2", roomId); return null; }
            catch (e) { return e.message; }
        }, { roomId });
        expect(err).toContain("Room is locked");

        await p1.close(); await p2.close();
        ts.close();
    });

    test("clientJoinRequested - client disconnects during async callback cancels join", async ({ context }) => {
        let resolveCallback;
        const callbackPromise = new Promise(r => { resolveCallback = r; });
        const ts = await createTestServer({
            eventHandlers: {
                clientJoinRequested: async () => {
                    await callbackPromise;
                    return true;
                }
            }
        });
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, "test-client.html");
        await openPage(p2, ts.httpUrl, "test-client.html");

        await p1.evaluate(({ wsUrl }) => window.initClient("jrc1", wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await p1.evaluate(() => window.createRoom("jrc1", {}));

        await p2.evaluate(({ wsUrl }) => window.initClient("jrc2", wsUrl), { wsUrl: ts.wsUrl });

        // Start join (will block in async callback) and immediately destroy
        p2.evaluate(({ roomId }) => window.joinRoom("jrc2", roomId), { roomId }).catch(() => { });
        await sleep(50);
        await p2.evaluate(() => window.destroy("jrc2"));

        // Let the callback complete
        resolveCallback();
        await sleep(50);

        // Client should NOT have joined the room
        expect(ts.server.rooms[roomId].participants).not.toContain("jrc2");
        expect(ts.server.rooms[roomId].participants.length).toBe(1);

        await p1.close(); await p2.close();
        ts.close();
    });

    test("clientJoinedRoom fires after successful join", async ({ context }) => {
        const log = [];
        const ts = await createTestServer({
            eventHandlers: { clientJoinedRoom: (clientId, roomId) => { log.push({ clientId, roomId }); } }
        });
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, "test-client.html");
        await openPage(p2, ts.httpUrl, "test-client.html");

        await p1.evaluate(({ wsUrl }) => window.initClient("cj1", wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await p1.evaluate(() => window.createRoom("cj1", {}));
        await p2.evaluate(({ wsUrl }) => window.initClient("cj2", wsUrl), { wsUrl: ts.wsUrl });
        await p2.evaluate(({ roomId }) => window.joinRoom("cj2", roomId), { roomId });

        expect(log.some(e => e.clientId === "cj2" && e.roomId === roomId)).toBe(true);

        await p1.close(); await p2.close();
        ts.close();
    });

    test("clientDisconnected fires when client disconnects", async ({ page }) => {
        let resolveDisconnected;
        const disconnectedPromise = new Promise(r => { resolveDisconnected = r; });
        const ts = await createTestServer({
            eventHandlers: { clientDisconnected: (clientId) => resolveDisconnected(clientId) }
        });
        await openPage(page, ts.httpUrl, "test-client.html");
        await page.evaluate(({ wsUrl }) => window.initClient("cd1", wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom("cd1", {}));
        await page.evaluate(() => window.destroy("cd1"));
        const clientId = await Promise.race([disconnectedPromise, sleep(3000).then(() => { throw new Error("Timeout!"); })]);
        expect(clientId).toBe("cd1");
        ts.close();
    });

    test("clientLeftRoom fires before clientDisconnected when client disconnects", async ({ page }) => {
        const eventOrder = [];
        let resolveDisconnected;
        const disconnectedFired = new Promise(r => { resolveDisconnected = r; });
        const ts = await createTestServer({
            eventHandlers: {
                clientLeftRoom: (clientId, roomId) => { eventOrder.push({ event: "clientLeftRoom", clientId, roomId }); },
                clientDisconnected: (clientId) => {
                    eventOrder.push({ event: "clientDisconnected", clientId });
                    resolveDisconnected();
                }
            }
        });
        await openPage(page, ts.httpUrl, "test-client.html");
        await page.evaluate(({ wsUrl }) => window.initClient("clr1", wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom("clr1", {}));
        await page.evaluate(() => window.destroy("clr1"));
        await disconnectedFired;
        expect(eventOrder.length).toBe(2);
        expect(eventOrder[0].event).toBe("clientLeftRoom");
        expect(eventOrder[0].clientId).toBe("clr1");
        expect(eventOrder[0].roomId).toBe(roomId);
        expect(eventOrder[1].event).toBe("clientDisconnected");
        expect(eventOrder[1].clientId).toBe("clr1");
        ts.close();
    });

    test("clientLeftRoom fires when client is moved to another room", async ({ page }) => {
        let resolve;
        const eventFired = new Promise(r => { resolve = r; });
        const ts = await createTestServer({
            eventHandlers: { clientLeftRoom: (clientId, roomId) => { resolve({ clientId, roomId }); } }
        });
        await openPage(page, ts.httpUrl, "test-client.html");

        const room1 = ts.server.createRoom({ name: "room1" });
        const room2 = ts.server.createRoom({ name: "room2" });

        await page.evaluate(({ wsUrl }) => window.initClient("clr2", wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(({ roomId }) => window.joinRoom("clr2", roomId), { roomId: room1.id });

        ts.server.move("clr2", room2.id);
        const event = await eventFired;
        expect(event.clientId).toBe("clr2");
        expect(event.roomId).toBe(room1.id);
        ts.close();
    });

    test("requestReceived fires with correct data", async ({ page }) => {
        let resolveRequest;
        const requestPromise = new Promise(r => { resolveRequest = r; });
        const ts = await createTestServer({
            eventHandlers: {
                requestReceived: (data) => resolveRequest(data)
            }
        });
        await openPage(page, ts.httpUrl, "test-client.html");
        await page.evaluate(({ wsUrl }) => window.initClient("rr1", wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom("rr1", {}));

        await page.evaluate(() => window.sendRequest("rr1", "testAction", { foo: "bar" }));
        const req = await Promise.race([requestPromise, sleep(3000).then(() => { throw new Error("Timeout!"); })]);

        expect(req.name).toBe("testAction");
        expect(req.data).toEqual({ foo: "bar" });
        expect(req.clientId).toBe("rr1");
        expect(req.roomId).toBe(roomId);
        ts.close();
    });

    test("requestReceived returns string - sendRequest rejects with custom reason", async ({ page }) => {
        const ts = await createTestServer({
            eventHandlers: { requestReceived: () => "Request not allowed" }
        });
        await openPage(page, ts.httpUrl, "test-client.html");
        await page.evaluate(({ wsUrl }) => window.initClient("rr2", wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom("rr2", {}));

        const err = await page.evaluate(async () => {
            try { await window.sendRequest("rr2", "blockedAction"); return null; }
            catch (e) { return e.message; }
        });
        expect(err).toContain("Request not allowed");
        ts.close();
    });

    test("requestReceived returns false - sendRequest rejects", async ({ page }) => {
        const ts = await createTestServer({
            eventHandlers: { requestReceived: () => false }
        });
        await openPage(page, ts.httpUrl, "test-client.html");
        await page.evaluate(({ wsUrl }) => window.initClient("rr3", wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom("rr3", {}));

        const err = await page.evaluate(async () => {
            try { await window.sendRequest("rr3", "blockedAction"); return null; }
            catch (e) { return e.message; }
        });
        expect(err).toContain("No reason provided");
        ts.close();
    });

    test("throwing requestReceived callback - sendRequest rejects instead of approving", async ({ page }) => {
        const ts = await createTestServer({
            eventHandlers: { requestReceived: () => { throw new Error("Test error!"); } }
        });
        await openPage(page, ts.httpUrl, "test-client.html");
        await page.evaluate(({ wsUrl }) => window.initClient("rr4", wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom("rr4", {}));

        const err = await page.evaluate(async () => {
            try { await window.sendRequest("rr4", "crashAction"); return null; }
            catch (e) { return e.message; }
        });
        expect(err).toContain("No reason provided");
        ts.close();
    });

    test("multiple requestReceived callbacks all run - first return value wins", async ({ page }) => {
        const ts = await createTestServer({
            eventHandlers: { requestReceived: () => "First reason" }
        });
        const secondLog = [];
        ts.server.onEvent("requestReceived", ({ name }) => { secondLog.push(name); return "Second reason"; });

        await openPage(page, ts.httpUrl, "test-client.html");
        await page.evaluate(({ wsUrl }) => window.initClient("rr5", wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom("rr5", {}));

        const err = await page.evaluate(async () => {
            try { await window.sendRequest("rr5", "multiAction"); return null; }
            catch (e) { return e.message; }
        });
        expect(err).toContain("First reason");
        expect(secondLog).toEqual(["multiAction"]);
        ts.close();
    });

    test("requestReceived callback without return value does not mask a later callback's rejection", async ({ page }) => {
        const log = [];
        const ts = await createTestServer({
            eventHandlers: { requestReceived: ({ name }) => { log.push(name); } }
        });
        ts.server.onEvent("requestReceived", () => "Validator reason");

        await openPage(page, ts.httpUrl, "test-client.html");
        await page.evaluate(({ wsUrl }) => window.initClient("rr6", wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom("rr6", {}));

        const err = await page.evaluate(async () => {
            try { await window.sendRequest("rr6", "loggedAction"); return null; }
            catch (e) { return e.message; }
        });
        expect(err).toContain("Validator reason");
        expect(log).toEqual(["loggedAction"]);
        ts.close();
    });

    test("storageUpdateRequested returns false - update rejected and reverted", async ({ page }) => {
        const consoleWarnings = [];
        page.on("console", msg => { if (msg.type() === "warning") consoleWarnings.push(msg.text()); });

        const ts = await createTestServer({
            eventHandlers: { storageUpdateRequested: () => false }
        });
        await openPage(page, ts.httpUrl, "test-client.html");
        await page.evaluate(({ wsUrl }) => window.initClient("sur1", wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom("sur1", { val: "original" }));

        await page.evaluate(() => window.updateStorage("sur1", "val", "set", "hacked"));
        await expect.poll(() => consoleWarnings.some(w => w.includes("rejected")), { timeout: 2_000 }).toBe(true);

        // Client should have reverted to the original value
        const storage = await page.evaluate(() => window.storage("sur1"));
        expect(storage.val).toBe("original");
        ts.close();
    });

    test("storageUpdateRequested returns string - update rejected with custom reason", async ({ page }) => {
        const consoleWarnings = [];
        page.on("console", msg => { if (msg.type() === "warning") consoleWarnings.push(msg.text()); });

        const ts = await createTestServer({
            eventHandlers: { storageUpdateRequested: () => "Storage update not allowed" }
        });
        await openPage(page, ts.httpUrl, "test-client.html");
        await page.evaluate(({ wsUrl }) => window.initClient("sur2", wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom("sur2", { val: "original" }));

        await page.evaluate(() => window.updateStorage("sur2", "val", "set", "hacked"));
        await expect.poll(() => consoleWarnings.some(w => w.includes("Storage update not allowed")), { timeout: 2_000 }).toBe(true);

        // Client should have reverted to the original value
        const storage = await page.evaluate(() => window.storage("sur2"));
        expect(storage.val).toBe("original");
        ts.close();
    });

    test("async storageUpdateRequested callback - update auto-rejected as async is not allowed for it", async ({ page }) => {
        const consoleWarnings = [];
        page.on("console", msg => { if (msg.type() === "warning") consoleWarnings.push(msg.text()); });

        const ts = await createTestServer({
            eventHandlers: {
                storageUpdateRequested: async () => true // Async validation is not allowed, even when it approves
            }
        });
        await openPage(page, ts.httpUrl, "test-client.html");
        await page.evaluate(({ wsUrl }) => window.initClient("sur3", wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom("sur3", { val: "original" }));

        await page.evaluate(() => window.updateStorage("sur3", "val", "set", "hacked"));
        await expect.poll(() => consoleWarnings.some(w => w.includes("synchronous")), { timeout: 2_000 }).toBe(true);

        // Update is reverted on the client and was never applied on the server
        const storage = await page.evaluate(() => window.storage("sur3"));
        expect(storage.val).toBe("original");
        expect(ts.server.getRoomStorage(roomId).val).toBe("original");
        ts.close();
    });

    test("storageUpdated fires on server with correct data", async ({ page }) => {
        let resolveUpdated;
        const updatedPromise = new Promise(r => { resolveUpdated = r; });
        const ts = await createTestServer({
            eventHandlers: { storageUpdated: (data) => resolveUpdated(data) }
        });
        await openPage(page, ts.httpUrl, "test-client.html");
        await page.evaluate(({ wsUrl }) => window.initClient("su1", wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom("su1", { x: 0 }));
        await page.evaluate(() => window.updateStorage("su1", "x", "set", 5));
        const data = await Promise.race([updatedPromise, sleep(3000).then(() => { throw new Error("Timeout!"); })]);

        expect(data.roomId).toBe(roomId);
        expect(data.clientId).toBe("su1");
        expect(data.storage.x).toBe(5);
        ts.close();
    });

    test("roomDestroyed fires when room auto-destroys and via destroyRoom", async ({ context }) => {
        let resolveDestroyed;
        let destroyedPromise = new Promise(r => { resolveDestroyed = r; });
        const log = [];
        const ts = await createTestServer({
            eventHandlers: { roomDestroyed: (roomId) => { log.push(roomId); resolveDestroyed(roomId); } }
        });
        const page = await context.newPage();
        await openPage(page, ts.httpUrl, "test-client.html");
        await page.evaluate(({ wsUrl }) => window.initClient("rd1", wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await page.evaluate(() => window.createRoom("rd1", {}));

        // Auto-destroy: last client leaves
        await page.evaluate(() => window.destroy("rd1"));
        await Promise.race([destroyedPromise, sleep(3000).then(() => { throw new Error("Timeout!"); })]);
        expect(log).toContain(roomId);
        expect(ts.server.rooms[roomId]).toBeUndefined();

        // Server-side destroy (synchronous, no wait needed)
        const room2 = ts.server.createRoom({ test: true });
        expect(ts.server.rooms[room2.id]).toBeDefined();
        ts.server.destroyRoom(room2.id);
        expect(log).toContain(room2.id);
        expect(ts.server.rooms[room2.id]).toBeUndefined();

        await page.close();
        ts.close();
    });

    test("throwing inside server event handler is caught and does not crash server", async ({ page }) => {
        const ts = await createTestServer({
            eventHandlers: { clientRegistered: () => { throw new Error("Test error!"); } }
        });
        await openPage(page, ts.httpUrl, "test-client.html");
        const id = await page.evaluate(({ wsUrl }) => window.initClient("te1", wsUrl), { wsUrl: ts.wsUrl });
        expect(id).toBe("te1");
        ts.close();
    });

    test("unsubscribe stops the callback, double-call is a safe no-op", async () => {
        const ts = await createTestServer();
        const unsubLog = [], keptLog = [];
        let resolveKept;
        const unsubscribe = ts.server.onEvent("roomCreated", (roomId) => { unsubLog.push(roomId); });
        ts.server.onEvent("roomCreated", (roomId) => { keptLog.push(roomId); resolveKept(); });

        let keptFired = new Promise(r => { resolveKept = r; });
        const room1 = ts.server.createRoom({});
        await keptFired;
        unsubscribe();
        unsubscribe(); // Second call must not remove other listeners
        keptFired = new Promise(r => { resolveKept = r; });
        const room2 = ts.server.createRoom({});
        await keptFired;

        expect(unsubLog).toEqual([room1.id]);
        expect(keptLog).toEqual([room1.id, room2.id]);
        ts.close();
    });

    test("callback that unsubscribes itself does not skip other listeners", async () => {
        const ts = await createTestServer();
        const order = [];
        let resolve;
        const bothFired = new Promise(r => { resolve = r; });
        const unsub = ts.server.onEvent("roomCreated", () => { order.push("first"); unsub(); });
        ts.server.onEvent("roomCreated", () => { order.push("second"); resolve(); });

        ts.server.createRoom({});
        await bothFired;
        expect(order).toEqual(["first", "second"]);
        ts.close();
    });
});
