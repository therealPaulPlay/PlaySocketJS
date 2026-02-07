import { test, expect } from '@playwright/test';
import { createTestServer } from '../helpers/test-server.js';
import { openPage, sleep } from '../helpers/playwright-helpers.js';
import WebSocket from 'ws';
import { encode, decode } from '@msgpack/msgpack';

let ts;

test.beforeAll(async () => { ts = await createTestServer(); });
test.afterAll(async () => { ts.close(); });

test.describe('Security', () => {

    test('HTML tags are stripped from string values', async ({ context }) => {
        const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);
        await openPage(p1, ts.httpUrl, 'test-client.html');
        await openPage(p2, ts.httpUrl, 'test-client.html');

        await p1.evaluate(({ wsUrl }) => window.initClient('xss1', wsUrl), { wsUrl: ts.wsUrl });
        const roomId = await p1.evaluate(() => window.createRoom('xss1', { msg: '' }));
        await p2.evaluate(({ wsUrl }) => window.initClient('xss2', wsUrl), { wsUrl: ts.wsUrl });
        await p2.evaluate(({ roomId }) => window.joinRoom('xss2', roomId), { roomId });
        await p1.waitForFunction(() => window.connectionCount('xss1') === 1, null, { timeout: 2_000 });

        await p1.evaluate(() => window.updateStorage('xss1', 'msg', 'set', '<script>alert("xss")</script>'));
        await p2.waitForFunction(() => window.storage('xss2')?.msg?.length > 0, null, { timeout: 2_000 });

        const s1 = await p1.evaluate(() => window.storage('xss1'));
        const s2 = await p2.evaluate(() => window.storage('xss2'));
        expect(s1.msg).not.toContain('<');
        expect(s1.msg).not.toContain('>');
        expect(s2.msg).not.toContain('<');

        await p1.close(); await p2.close();
    });

    test('large value payloads exceeding 50KB are rejected', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('lv1', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom('lv1', {}));

        // Try to set a value > 50KB
        await page.evaluate(() => {
            const bigValue = 'x'.repeat(60000);
            window.updateStorage('lv1', 'big', 'set', bigValue);
        });
        await sleep(100);

        const storage = await page.evaluate(() => window.storage('lv1'));
        expect(storage.big).toBeUndefined();
    });

    test('large key payloads - test with large values within individual keys', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('lk1', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom('lk1', {}));

        // Set a value just under 50KB limit
        await page.evaluate(() => {
            const value = 'a'.repeat(49000);
            window.updateStorage('lk1', 'largeKey', 'set', value);
        });
        await page.waitForFunction(() => window.storage('lk1')?.largeKey?.length === 49000, null, { timeout: 2_000 });
        const storage = await page.evaluate(() => window.storage('lk1'));
        expect(storage.largeKey?.length).toBe(49000);

        // Now try one just over the limit
        await page.evaluate(() => {
            const tooBig = 'b'.repeat(60000);
            window.updateStorage('lk1', 'tooBig', 'set', tooBig);
        });
        await sleep(100);
        const storage2 = await page.evaluate(() => window.storage('lk1'));
        expect(storage2.tooBig).toBeUndefined();
    });

    test('reconnection with invalid session token is rejected', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html?intercept-ws');
        await page.evaluate(({ wsUrl }) => window.initClient('tk1', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom('tk1', { x: 1 }));

        // Disconnect the real client so it enters the pending reconnect state
        // Block network so the client doesn't auto-reconnect before our forged attempt
        await page.evaluate(() => {
            window.blockNetwork();
            window.simulateDisconnect('tk1');
        });
        await sleep(200);

        // From Node.js, open a raw WebSocket and send a reconnect with a forged token
        const msg = await new Promise((resolve) => {
            const ws = new WebSocket(ts.wsUrl);
            ws.binaryType = 'arraybuffer';
            ws.on('open', () => {
                ws.send(encode({ type: 'reconnect', id: 'tk1', sessionToken: 'FORGED_TOKEN' }));
            });
            ws.on('message', (data) => {
                resolve(decode(data));
                ws.close();
            });
            setTimeout(() => { resolve(null); ws.close(); }, 3000);
        });

        expect(msg).toBeTruthy();
        expect(msg.type).toBe('reconnection_failed');
        expect(msg.reason).toContain('token');
    });

    test('nested objects and arrays are recursively sanitized', async ({ page }) => {
        await openPage(page, ts.httpUrl, 'test-client.html');
        await page.evaluate(({ wsUrl }) => window.initClient('ns1', wsUrl), { wsUrl: ts.wsUrl });
        await page.evaluate(() => window.createRoom('ns1', {}));

        await page.evaluate(() => {
            window.updateStorage('ns1', 'data', 'set', {
                text: '<img src=x onerror=alert(1)>',
                arr: ['<div>test</div>', { inner: '<b>bold</b>' }]
            });
        });
        await page.waitForFunction(() => window.storage('ns1')?.data?.text != null, null, { timeout: 2_000 });

        const storage = await page.evaluate(() => window.storage('ns1'));
        expect(storage.data.text).not.toContain('<');
        expect(storage.data.text).not.toContain('>');
        expect(storage.data.arr[0]).not.toContain('<');
        expect(storage.data.arr[1].inner).not.toContain('<');
    });
});
