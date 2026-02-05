import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import PlaySocketServer from '../../dist/playsocket-server.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

const CONTENT_TYPES = { '.html': 'text/html', '.js': 'application/javascript' };

let nextPort = 4000;

/** @returns {number} Auto-incrementing port starting at 4000 */
export function getNextPort() { return nextPort++; }

/**
 * Create an isolated HTTP + WebSocket test server
 * @param {object} [options] - Server configuration
 * @param {number} [options.port] - Port to listen on (auto-assigned if omitted)
 * @param {import('node:http').Server} [options.existingServer] - Reuse an existing HTTP server instead of creating one
 * @param {Record<string, Function>} [options.eventHandlers] - PlaySocketServer event handlers to register
 * @param {number} [options.rateLimit] - Rate limit (points per second)
 * @param {Function} [options.verifyClient] - WebSocket verifyClient callback
 * @param {boolean} [options.debug] - Enable PlaySocketServer debug logging
 * @returns {Promise<{ server: PlaySocketServer, httpServer: import('node:http').Server, port: number, wsUrl: string, httpUrl: string, close: () => void }>} Test server handle
 */
export async function createTestServer(options = {}) {
    const port = options.port || getNextPort();
    const { eventHandlers = {}, rateLimit, verifyClient, debug = false } = options;
    const existing = options.existingServer;
    const httpServer = existing || createServer();

    // Serve e2e/helpers/*.html and dist/*.js for the test browser
    if (!existing) {
        httpServer.on('request', async (req, res) => {
            const pathname = req.url?.split('?')[0];
            let filePath;
            if (pathname?.startsWith('/dist/')) filePath = join(PROJECT_ROOT, pathname);
            else if (pathname?.endsWith('.html')) filePath = join(__dirname, pathname.split('/').pop());
            else return res.writeHead(404).end();

            try {
                const content = await readFile(filePath);
                res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(filePath)] || 'application/octet-stream' }).end(content);
            } catch { res.writeHead(404).end(); }
        });

        await new Promise(resolve => httpServer.listen(port, resolve));
    }

    // Build PlaySocketServer options, only including optional fields when provided
    const serverOpts = { server: httpServer, path: '/ws', debug };
    if (rateLimit != null) serverOpts.rateLimit = rateLimit;
    if (verifyClient) serverOpts.verifyClient = verifyClient;

    // Attach user-provided event handlers (e.g. requestReceived, storageUpdateRequested)
    const server = new PlaySocketServer(serverOpts);
    for (const [event, handler] of Object.entries(eventHandlers))
        server.onEvent(event, handler);

    return {
        server,
        httpServer,
        port,
        wsUrl: `ws://localhost:${port}/ws`,
        httpUrl: `http://localhost:${port}`,
        close() {
            server.stop();
            if (!existing) httpServer.close();
        }
    };
}