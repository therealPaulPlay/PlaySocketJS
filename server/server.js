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
const clientRooms = new Map(); // Clients matched to rooms

// Handle new WebSocket connections
wsServer.on('connection', ws => {
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
                        const newRoomId = ws.clientId;
                        if (clientRooms.get(ws.clientId)) {
                            ws.send(JSON.stringify({
                                type: 'room_creation_failed',
                                reason: 'Already in a room'
                            }));
                            return;
                        }
                        if (rooms[newRoomId]) {
                            ws.send(JSON.stringify({
                                type: 'room_creation_failed',
                                reason: 'Room id is taken'
                            }));
                            return;
                        }
                        rooms[newRoomId] = {
                            participants: [ws.clientId],
                            maxSize: data.size || null,
                            storage: data.storage,
                        }
                        clientRooms.set(ws.clientId, newRoomId);
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
                        if (clientRooms.get(ws.clientId)) {
                            ws.send(JSON.stringify({
                                type: 'connection_rejected',
                                reason: 'Already in a room'
                            }));
                            return;
                        }

                        rooms[roomId].participants.push(ws.clientId);
                        clientRooms.set(ws.clientId, roomId);

                        // Notify the joiner and send initial storage update
                        ws.send(JSON.stringify({
                            type: 'connection_accepted',
                            storage: rooms[roomId].storage,
                            participantCount: rooms[roomId].participants?.length
                        }));

                        // Notify all room participants (except the one that just joined)
                        rooms[roomId].participants.forEach((p) => {
                            if (p === ws.clientId) return;
                            const client = clients.get(p);
                            if (client) {
                                client.send(JSON.stringify({
                                    type: 'client_connected',
                                    client: ws.clientId,
                                    participantCount: rooms[roomId].participants?.length
                                }));
                            }
                        });

                    }
                    break;

                case 'room_storage_update':
                    const updateKey = clientRooms.get(ws.clientId);
                    const updateRoom = updateKey ? rooms[updateKey] : null;
                    if (updateRoom) {
                        updateRoom.storage[data.key] = data.value;
                        roomStorageSync(updateKey);
                    }
                    break;

                case 'room_storage_array_update':
                    const arrayUpdateKey = clientRooms.get(ws.clientId);
                    const arrayUpdateRoom = arrayUpdateKey ? rooms[arrayUpdateKey] : null;
                    if (arrayUpdateRoom) {
                        arrayUpdate(arrayUpdateRoom.storage, data.key, data.operation, data.value, data.updateValue);
                        roomStorageSync(arrayUpdateKey);
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
        clients.delete(ws.clientId); // Remove from connected clients

        const key = clientRooms.get(ws.clientId);
        const room = key ? rooms[key] : null;

        // Notify all participants about the disconnection
        if (room) {
            room.participants = room.participants?.filter((p) => p !== ws.clientId); // Remove from room
            clientRooms.delete(ws.clientId); // Remove from lookup map
            room.participants?.forEach((p) => {
                const client = clients.get(p);
                if (client) {
                    try {
                        client.send(JSON.stringify({
                            type: 'client_disconnected',
                            updatedHost: room.participants?.[0],
                            client: ws.clientId,
                            participantCount: room.participants?.length
                        }));
                    } catch (error) {
                        console.error(`Error notifying peer of disconnection:`, error);
                    }
                }
            });
        }

        // Close / delete room if nobody is in it anymore
        if (room && room.participants?.length == 0) delete rooms[key];
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