/**
 * Simple PlaySocket server for the chat example. Ensure the dependencies are installed (see readme).
 */

// Import the PlaySocketServer
const PlaySocketServer = require('../dist/playsocket-server.js');

// Create and start the server
const server = new PlaySocketServer();

// Gracefully disconnect all clients and close the server
function shutdown() {
    console.log('Shutting down gracefully...');
    server.stop();
    process.exit(0);
}

// Handle both SIGINT (Ctrl+C) and SIGTERM (Docker stop)
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);