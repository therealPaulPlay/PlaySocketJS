/**
 * Simple WebSocket server for PlaySocket
 * Handles room creation and room logic
 */

const WebSocket = require('ws');
const http = require('http');

// Create server
const server = http.createServer();
const wsServer = new WebSocket.Server({ server });

// Store connected peers, rooms
const clients = new Map(); // peerId -> WebSocket
const rooms = {};

// Handle new WebSocket connections
wsServer.on('connection', ws => {
    // Set up message handler
    ws.on('message', message => {
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                case 'register':
                    // Register peer ID
                    if (data.id) {
                        if (clients.get(data.id)) {
                            ws.send(JSON.stringify({
                                type: 'id_taken'
                            }));
                            return;
                        }
                        ws.clientId = data.id; // Store ID directly on the websocket
                        clients.set(data.id, ws);
                        ws.send(JSON.stringify({
                            type: 'registered'
                        }));
                    }
                    break;

                case 'create_room':
                    if (ws.clientId) {
                        const from = ws.clientId;
                        if (rooms[from]) {
                            ws.send(JSON.stringify({
                                type: 'room_taken'
                            }));
                            return;
                        } else {
                            rooms[from] = {
                                participants: [data.from],
                                maxSize: data.size || null,
                                storage: data.storage,
                            }
                        }
                        ws.send(JSON.stringify({
                            type: 'room_created'
                        }));
                    }
                    break;

                case 'join_room':
                    if (data.roomId) {
                        const roomId = data.roomId;
                        if (!rooms[roomId]) {
                            ws.send(JSON.stringify({
                                type: 'connection_rejected',
                                reason: 'Room not found'
                            }));
                            return;
                        }
                        if (rooms[roomId].maxSize && rooms[roomId].participants?.length >= rooms[roomId].maxSize) {
                            ws.send(JSON.stringify({
                                type: 'connection_rejected',
                                reason: 'Room full'
                            }));
                            return;
                        }
                        rooms[roomId].participants.push(ws.clientId);

                        // Notify the joiner and send initial storage update
                        ws.send(JSON.stringify({
                            type: 'connection_accepted',
                            storage: rooms[roomId].storage,
                            participantCount: rooms[roomId].participants?.length
                        }));

                        // Notify all room participants (except the one that just joined)
                        rooms[roomId].participants.forEach((p) => {
                            if (p !== ws.clientId) {
                                const client = clients.get(p);
                                if (client) {
                                    client.send(JSON.stringify({
                                        type: 'client_connected',
                                        client: ws.clientId,
                                        participantCount: rooms[roomId].participants?.length
                                    }));
                                }
                            }
                        });

                    }
                    break;

                case 'room_storage_update':
                    if (data.roomId && rooms[data.roomId] && rooms[data.roomId]?.participants?.includes(ws.clientId)) {
                        rooms[data.roomId].storage[data.key] = data.value;
                        roomStorageSync(data.roomId);
                    }
                    break;

                case 'room_storage_array_update':
                    if (data.roomId && rooms[data.roomId] && rooms[data.roomId]?.participants?.includes(ws.clientId)) {
                        arrayUpdate(rooms[data.roomId].storage, data.key, data.operation, data.value, data.updateValue);
                        roomStorageSync(data.roomId);
                    }
                    break;
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });

    // Send a storage update to all room participants
    function roomStorageSync(roomId) {
        if (!rooms[roomId]) return;
        rooms[roomId].participants.forEach((p) => {
            const client = clients.get(p);
            if (client) {
                client.send(JSON.stringify({
                    type: 'storage_sync',
                    storage: rooms[roomId].storage
                }));
            }
        });
    }

    // Handle race-condition-safe array update operations
    function arrayUpdate(storage, key, operation, value, updateValue) {
        if (!storage[key] || !Array.isArray(storage[key])) storage[key] = [];
        let array = storage[key];

        const isObject = typeof value === 'object' && value !== null;
        const compare = (item) => isObject ?
            JSON.stringify(item) === JSON.stringify(value) : item === value;

        switch (operation) {
            case 'add':
                array.push(value);
                break;

            case 'add-unique':
                if (!array.some(compare)) array.push(value);
                break;

            case 'remove-matching':
                storage[key] = array.filter(item => !compare(item));
                break;

            case 'update-matching':
                const index = array.findIndex(compare);
                if (index !== -1) array[index] = updateValue;
                break;
        }
    }

    // Handle disconnection
    ws.on('close', () => {
        if (!ws.clientId) return;
        clients.delete(ws.clientId); // Remove

        let clientRoom;
        let clientRoomKey;
        for (const [key, value] of Object.entries(rooms)) {
            if (value?.participants?.includes(ws.clientId)) {
                clientRoomKey = key;
                clientRoom = rooms[clientRoomKey];
                break;
            }
        }

        // Notify all participants about the disconnection
        if (clientRoom) {
            clientRoom.participants = clientRoom.participants?.filter((p) => p !== ws.clientId)
            clientRoom.participants?.forEach((p) => {
                const client = clients.get(p);
                if (client) {
                    try {
                        client.send(JSON.stringify({
                            type: 'client_disconnected',
                            updatedHost: clientRoom.participants?.[0],
                            client: ws.clientId,
                            participantCount: clientRoom.participants?.length
                        }));
                    } catch (error) {
                        console.error(`Error notifying peer ${otherPeerId} of disconnection:`, error);
                    }
                }
            });
        }

        // Close / delete room if nobody is in it anymore
        if (clientRoom && clientRoom.participants?.length == 0) {
            delete rooms[clientRoomKey];
        }
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`WebSocket server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    wsServer.clients.forEach(client => client.close());
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});