const WebSocket = require('ws');
const http = require('http');

/**
 * PlaySocketServer - WebSocket server for PlaySocket multiplayer library
 */
class PlaySocketServer {
    #server;
    #ownsServer = false;
    #wss;
    #clients = new Map(); // ClientId -> WebSocket instance
    #rooms = {};
    #clientRooms = new Map(); // ClientId -> RoomId
    #rateLimits = new Map(); // Rate limiting storage
    #callbacks = new Map();
    #heartbeatInterval;

    /**
     * Create a new PlaySocketServer instance
     * @param {Object} options - Server configuration options
     * @param {HttpServer} [options.server] - Existing http server
     * @param {number} [options.port=3000] - Port to listen on (if no server provided)
     * @param {string} [options.path='/socket'] - WebSocket endpoint path
     */
    constructor(options = {}) {
        const { server, port = 3000, path = '/' } = options;

        // Handle server creation / usage
        if (server) {
            this.#server = server; // Use provided HTTP server
        } else {
            this.#ownsServer = true;
            this.#server = http.createServer(); // Create HTTP server and start it
            this.#server.listen(port, () => {
                console.log(`PlaySocket server running on port ${port}`);
            });
        }

        // Create WebSocket server
        this.#wss = new WebSocket.Server({
            server: this.#server,
            path
        });

        // Set up ws event handlers
        this.#wss.on('connection', ws => {
            ws.isAlive = true;
            ws.on('pong', () => { ws.isAlive = true; });
            ws.on('message', msg => this.#handleMessage(ws, msg));
            ws.on('close', () => this.#handleDisconnection(ws));
        });

        // Start heartbeat
        this.#heartbeatInterval = setInterval(() => {
            this.#wss.clients.forEach(ws => {
                if (!ws.isAlive) return ws.terminate();
                ws.isAlive = false;
                ws.ping();
            });
        }, 30000);
    }

    /**
     * Handle WebSocket message
     * @private
     */
    #handleMessage(ws, message) {
        try {
            const data = JSON.parse(message);

            // Apply rate limiting after client is registered
            if (ws.clientId && !this.#checkRateLimit(ws.clientId, data.type)) {
                return console.error(`Client ${ws.clientId} rate limit exceeded.`);
            }

            switch (data.type) {
                case 'register':
                    // Register client ID
                    if (!data.id) return;
                    if (this.#clients.get(data.id)) {
                        ws.send(JSON.stringify({ type: 'id_taken' }));
                        return;
                    }
                    ws.clientId = data.id; // Adds the provided id to the ws object as clientId
                    this.#clients.set(data.id, ws);
                    ws.send(JSON.stringify({ type: 'registered' }));
                    this.#triggerEvent("clientRegistered", data.id, data.customData);
                    break;

                case 'create_room':
                    if (!ws.clientId) return;
                    const newRoomId = ws.clientId;
                    if (this.#clientRooms.get(ws.clientId) || this.#rooms[newRoomId]) {
                        ws.send(JSON.stringify({
                            type: 'room_creation_failed',
                            reason: this.#clientRooms.get(ws.clientId) ? 'Already in a room' : 'Room id is taken'
                        }));
                        return;
                    }

                    this.#rooms[newRoomId] = {
                        participants: [ws.clientId],
                        maxSize: data.size || null,
                        storage: data.storage || {},
                    };

                    this.#clientRooms.set(ws.clientId, newRoomId);
                    ws.send(JSON.stringify({ type: 'room_created' }));
                    this.#triggerEvent("roomCreated", ws.clientId); // Client id = room id
                    break;

                case 'join_room':
                    if (!data.roomId) return;
                    const roomId = data.roomId;
                    const room = this.#rooms[roomId];

                    if (!room ||
                        (room.maxSize && room.participants.length >= room.maxSize) ||
                        this.#clientRooms.get(ws.clientId)) {
                        ws.send(JSON.stringify({
                            type: 'connection_rejected',
                            reason: !room ? 'Room not found' :
                                room.maxSize && room.participants.length >= room.maxSize ? 'Room full' :
                                    'Already in a room'
                        }));
                        return;
                    }

                    room.participants.push(ws.clientId);
                    this.#clientRooms.set(ws.clientId, roomId);

                    // Notify joiner with initial storage
                    ws.send(JSON.stringify({
                        type: 'connection_accepted',
                        storage: room.storage,
                        participantCount: room.participants.length
                    }));

                    // Notify existing participants
                    room.participants.forEach(p => {
                        if (p === ws.clientId) return;
                        const client = this.#clients.get(p);
                        if (client) {
                            client.send(JSON.stringify({
                                type: 'client_connected',
                                client: ws.clientId,
                                participantCount: room.participants.length
                            }));
                        }
                    });
                    this.#triggerEvent("roomJoined", ws.clientId, roomId);
                    break;

                case 'room_storage_update':
                    const updateRoomId = this.#clientRooms.get(ws.clientId);
                    const updateRoom = updateRoomId ? this.#rooms[updateRoomId] : null;
                    if (updateRoom && data.key && JSON.stringify(updateRoom.storage[data.key]) !== JSON.stringify(data.value)) {
                        updateRoom.storage[data.key] = data.value;
                        this.#syncRoomStorageKey(updateRoomId, data.key);
                    }
                    break;

                case 'room_storage_array_update':
                    const arrayRoomId = this.#clientRooms.get(ws.clientId);
                    const arrayRoom = arrayRoomId ? this.#rooms[arrayRoomId] : null;
                    if (arrayRoom && data.key) {
                        const updatedArray = this.#arrayUpdate(arrayRoom.storage, data.key, data.operation, data.value, data.updateValue);
                        if (JSON.stringify(arrayRoom.storage[data.key]) !== JSON.stringify(updatedArray)) {
                            arrayRoom.storage[data.key] = updatedArray;
                            this.#syncRoomStorageKey(arrayRoomId, data.key);
                        }
                    }
                    break;
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    }

    /**
     * Check rate limit using token bucket algorithm
     * @private
     */
    #checkRateLimit(clientId, operationType) {
        const MAX_POINTS = 100;
        const now = Date.now();

        if (!this.#rateLimits.has(clientId)) {
            this.#rateLimits.set(clientId, { points: MAX_POINTS, lastReset: now });
            return true;
        }

        const limit = this.#rateLimits.get(clientId);

        // Reset points if interval has passed (5s)
        if (now - limit.lastReset > 5000) {
            limit.points = MAX_POINTS;
            limit.lastReset = now;
        }

        const pointCost = ['create_room', 'join_room'].includes(operationType) ? 20 : 1;
        if (limit.points < pointCost) return false;

        limit.points -= pointCost;
        return true;
    }

    /**
     * Sync storage key to all clients in room
     * @private
     */
    #syncRoomStorageKey(roomId, key) {
        const room = this.#rooms[roomId];
        if (!room) return;
        room.participants.forEach(p => {
            const client = this.#clients.get(p);
            if (client) {
                client.send(JSON.stringify({
                    type: 'storage_sync',
                    key,
                    value: room.storage[key]
                }));
            }
        });
    }

    /**
     * Handle array operations
     * @private
     */
    #arrayUpdate(storage, key, operation, value, updateValue) {
        let array = (!storage[key] || !Array.isArray(storage[key])) ? [] : [...storage[key]];
        const isObject = typeof value === 'object' && value !== null;
        const compare = (item) => isObject ? JSON.stringify(item) === JSON.stringify(value) : item === value;

        switch (operation) {
            case 'add':
                array.push(value);
                break;

            case 'add-unique':
                if (!array.some(compare)) array.push(value);
                break;

            case 'remove-matching':
                array = array.filter(item => !compare(item));
                break;

            case 'update-matching':
                const index = array.findIndex(compare);
                if (index !== -1) array[index] = updateValue;
                break;
        }

        return array;
    }

    /**
     * Handle client disconnection
     * @private
     */
    #handleDisconnection(ws) {
        if (!ws.clientId) return;

        this.#clients.delete(ws.clientId);
        this.#rateLimits.delete(ws.clientId);

        const roomId = this.#clientRooms.get(ws.clientId);
        const room = roomId ? this.#rooms[roomId] : null;

        if (room) {
            room.participants = room.participants?.filter(p => p !== ws.clientId);
            this.#clientRooms.delete(ws.clientId);

            // Notify remaining participants
            room.participants?.forEach(p => {
                const client = this.#clients.get(p);
                if (client) {
                    try {
                        client.send(JSON.stringify({
                            type: 'client_disconnected',
                            updatedHost: room.participants?.[0],
                            client: ws.clientId,
                            participantCount: room.participants?.length
                        }));
                    } catch (error) {
                        console.error(`Error notifying client of disconnection:`, error);
                    }
                }
            });
            if (room.participants?.length === 0) delete this.#rooms[roomId]; // Delete room if now empty
        }

        this.#triggerEvent("clientDisconnected", ws.clientId);
    }

    /**
     * Register an event callback
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
     */
    onEvent(event, callback) {
        const validEvents = ["clientRegistered", "clientDisconnected", "roomCreated", "roomJoined"];
        if (!validEvents.includes(event)) return console.warn(`Invalid PlaySocket event type "${event}"`);
        if (!this.#callbacks.has(event)) this.#callbacks.set(event, []);
        this.#callbacks.get(event).push(callback);
    }

    /**
     * Trigger an event to registered callbacks
     * @private
     */
    #triggerEvent(event, ...args) {
        const callbacks = this.#callbacks.get(event);
        callbacks?.forEach(callback => {
            try { callback(...args) } catch (error) { console.error(`PlaySocket ${event} callback error:`, error) }
        });
    }

    /**
     * Close all client connections, then close the websocket and http server
     */
    stop() {
        clearInterval(this.#heartbeatInterval);
        if (this.#wss) {
            this.#wss.clients.forEach(client => client.close());
            this.#wss.close();
        }
        if (this.#server && this.#ownsServer) {
            this.#server.close(() => {
                console.log('PlaySocket server stopped');
            });
        }
    }

    get getRooms() { return { ...this.#rooms } }
}

module.exports = PlaySocketServer;