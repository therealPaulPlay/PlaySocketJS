/**
 * Simple PlaySocket server for the chat example. Ensure the dependencies are installed (see readme).
 */

// Import the PlaySocketServer
const PlaySocketServer = require('../dist/playsocket-server.js');

// Create and start the server
const server = new PlaySocketServer({ debug: true });

server.onEvent("requestReceived", ({ name, roomId, data, clientId }) => {
    if (name == "test") server.updateRoomStorage(roomId, 'messages', 'array-add', { sender: "server", text: "Testing 1.. 2.. 3.. Test data: " + data });
})

// Gracefully disconnect all clients and close the server
function shutdown() {
    console.log('\nShutting down gracefully...');
    server.stop();
    process.exit(0);
}

// Handle both SIGINT (Ctrl+C) and SIGTERM (Docker stop)
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);