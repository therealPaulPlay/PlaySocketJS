const WebSocket = require('ws');
const http = require('http');
const { encode, decode } = require('@msgpack/msgpack');
const { CRDTManager } = require('../universal/crdtManager');

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
    #callbacks = new Map(); // Event -> [callback functions]
    #heartbeatInterval;
    #pendingDisconnects = new Map(); // ClientId -> {timeout, roomId}
    #clientTokens = new Map(); // ClientId -> Token
    #roomVersions = new Map(); // RoomId -> Version

    // Debug
    #debug = false;

    /**
     * Create a new PlaySocketServer instance
     * @param {Object} options - Server configuration options
     * @param {HttpServer} [options.server] - Existing http server
     * @param {number} [options.port=3000] - Port to listen on (if no server provided)
     * @param {string} [options.path='/socket'] - WebSocket endpoint path
     */
    constructor(options = {}) {
        const { server, port = 3000, path = '/', debug = false } = options;

        if (debug) this.#debug = true; // Enable extra logging

        // Handle server creation / usage
        if (server) {
            this.#server = server; // Use provided HTTP server
        } else {
            this.#ownsServer = true;
            this.#server = http.createServer(); // Create HTTP server and start it
            this.#server.listen(port, () => {
                console.log(`PlaySocket server running on port ${port}.`);
            });
        }

        // Create WebSocket server
        this.#wss = new WebSocket.Server({
            server: this.#server,
            path
        });

        // Set up ws event handlers
        this.#wss.on('connection', ws => {
            ws.connectionId = crypto.randomUUID();
            ws.isAlive = true;
            ws.on('pong', () => { ws.isAlive = true; });
            ws.on('message', msg => this.#handleMessage(ws, msg));
            ws.on('close', () => this.#handleDisconnection(ws));
            ws.on('error', (error) => {
                console.error(`PlaySocket WebSocket connection error for client ${ws.clientId || 'unknown'}:`, error); // Catch conn errors
            });
        });

        // Log & catch server-level errors
        this.#wss.on('error', (error) => {
            console.error('PlaySocket WebSocket server error:', error);
        });

        // Start heartbeat
        this.#heartbeatInterval = setInterval(() => {
            this.#wss.clients.forEach(ws => {
                if (!ws.isAlive) return ws.terminate();
                ws.isAlive = false;
                ws.ping();
            });
        }, 15000);
    }

    /**
     * Handle WebSocket message
     * @private
     */
    #handleMessage(ws, message) {
        if (ws.isTerminating) return;
        try {
            const data = decode(message);

            // Apply rate limiting to all connections (including unregistered)
            if (!this.#checkRateLimit(ws.connectionId, data.type)) {
                ws.rateLimitViolations = (ws.rateLimitViolations || 0) + 1;
                if (ws.rateLimitViolations > 5 && !ws.isTerminating) {
                    ws.isTerminating = true; // Prevent multiple terminate calls (it is async)
                    ws.terminate();
                    return console.error(`Connection ${ws.connectionId} terminated due to repeated rate limit violations.`);
                }
                return console.error(`Connection ${ws.connectionId} rate limit exceeded.`);
            }

            switch (data.type) {
                case 'register':
                    // Register client ID if provided & check for a duplicate
                    if (data.id && this.#clients.get(data.id)) {
                        ws.send(encode({ type: 'id_taken' }), { binary: true });
                        return;
                    }

                    // Generate client ID if none provided
                    if (!data.id) {
                        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789';
                        const maxAttempts = 50;
                        for (let i = 0; i < maxAttempts; i++) {
                            const id = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
                            if (!this.#clients.get(id)) {
                                data.id = id;
                                break;
                            }
                        }
                        if (!data.id) {
                            ws.send(encode({ type: 'id_taken' }), { binary: true });
                            throw new Error('Failed to generate unique ID!');
                        }
                    }


                    ws.clientId = data.id; // Adds the provided id to the ws object as clientId
                    this.#clients.set(data.id, ws);
                    const sessionToken = this.#generateSessionToken();
                    this.#clientTokens.set(data.id, sessionToken); // Token is used when reconnecting to prevent impersonation attacks
                    ws.send(encode({ type: 'registered', id: data.id, sessionToken }), { binary: true });
                    this.#triggerEvent("clientRegistered", data.id, data.customData);
                    break;

                case 'reconnect':
                    // If user is pending disconnect, respond (otherwise it's too late)
                    const pd = this.#pendingDisconnects.get(data.id);
                    if (pd && data.sessionToken) {
                        if (data.sessionToken !== this.#clientTokens.get(data.id)) {
                            ws.send(encode({
                                type: 'reconnection_failed',
                                reason: "Session token does not match"
                            }), { binary: true });
                            return;
                        }
                        clearTimeout(pd.timeout);
                        this.#pendingDisconnects.delete(data.id);

                        // Re-assign old client id to the new ws connection
                        ws.clientId = data.id;
                        this.#clients.set(data.id, ws);

                        // If they were in a room, provide updated room data
                        let roomData;
                        const formerRoomId = this.#clientRooms.get(data.id);
                        const formerRoom = this.#rooms[formerRoomId];
                        if (formerRoom) {
                            if (this.#debug) console.log(`State sent for reconnection for room ${formerRoomId}:`, formerRoom.crdtManager.getState);
                            roomData = {
                                state: formerRoom.crdtManager.getState,
                                participantCount: formerRoom.participants.length,
                                host: formerRoom.host,
                                version: this.#roomVersions.get(formerRoomId)
                            }
                        }

                        ws.send(encode({ type: 'reconnected', roomData }), { binary: true });
                    } else {
                        ws.send(encode({ type: 'reconnection_failed', reason: "Client unknown to server" }), { binary: true });
                    }
                    break;

                case 'create_room':
                    if (!ws.clientId) return;
                    const newRoomId = ws.clientId;
                    if (this.#clientRooms.get(ws.clientId) || this.#rooms[newRoomId]) {
                        ws.send(encode({
                            type: 'room_creation_failed',
                            reason: this.#clientRooms.get(ws.clientId) ? 'Already in a room' : 'Room id is taken'
                        }), { binary: true });
                        return;
                    }

                    // Create room
                    this.#roomVersions.set(newRoomId, 0); // Start with version 0
                    this.#rooms[newRoomId] = {
                        participants: [ws.clientId],
                        host: ws.clientId,
                        maxSize: data.size || null,
                        crdtManager: new CRDTManager(this.#debug)
                    };

                    // Load state if provided
                    if (data.state) {
                        this.#rooms[newRoomId].crdtManager.importState(data.state);
                        if (this.#debug) console.log("Room created with initial state:", data.state);
                    }

                    this.#clientRooms.set(ws.clientId, newRoomId); // Add client to their room
                    ws.send(encode({ type: 'room_created' }), { binary: true });
                    this.#triggerEvent("roomCreated", ws.clientId); // Client id = room id
                    break;

                case 'join_room':
                    if (!data.roomId || !ws.clientId) return;
                    const roomId = data.roomId;
                    const room = this.#rooms[roomId];

                    if (!room ||
                        (room.maxSize && room.participants.length >= room.maxSize) ||
                        this.#clientRooms.get(ws.clientId)) {
                        ws.send(encode({
                            type: 'join_rejected',
                            reason: !room ? 'Room not found' :
                                room.maxSize && room.participants.length >= room.maxSize ? 'Room full' :
                                    'Already in a room'
                        }), { binary: true });
                        return;
                    }

                    room.participants.push(ws.clientId);
                    this.#clientRooms.set(ws.clientId, roomId);

                    // Notify joiner with initial storage
                    if (this.#debug) console.log("Room state sent for join:", room.crdtManager.getState);
                    ws.send(encode({
                        type: 'join_accepted',
                        state: room.crdtManager.getState,
                        participantCount: room.participants.length,
                        host: room.host,
                        version: this.#roomVersions.get(roomId)
                    }), { binary: true });

                    // Notify existing participants
                    room.participants.forEach(p => {
                        if (p === ws.clientId) return;
                        const client = this.#clients.get(p);
                        if (client) {
                            client.send(encode({
                                type: 'client_connected',
                                client: ws.clientId,
                                participantCount: room.participants.length
                            }), { binary: true });
                        }
                    });
                    this.#triggerEvent("roomJoined", ws.clientId, roomId);
                    break;

                case 'update_property':
                    const updateRoomId = this.#clientRooms.get(ws.clientId);
                    const updateRoom = updateRoomId ? this.#rooms[updateRoomId] : null;

                    if (updateRoom && data.update) {
                        updateRoom.crdtManager.importPropertyUpdate(data.update);

                        // Increment version for this room
                        const currentVersion = this.#roomVersions.get(updateRoomId) + 1;
                        this.#roomVersions.set(updateRoomId, currentVersion);

                        if (this.#debug) console.log("Property update received and imported:", data.update);
                        updateRoom.participants?.forEach(p => {
                            const client = this.#clients.get(p);
                            if (client) {
                                client.send(encode({
                                    type: 'property_updated',
                                    update: data.update,
                                    version: currentVersion
                                }), { binary: true });
                            }
                        });
                    }
                    break;

                case 'disconnect':
                    // Client signals to server that it will will willfully disconnect soon
                    ws.willfulDisconnect = true;
                    break;
            }
        } catch (error) {
            console.error('Error in message handler:', error);
        }
    }

    /**
     * If the client that disconnected (and is now in the reconnection-phase) was the room host,
     * pick a new room host immediately to avoid host-less phase (in case important logic is attached to the host)
     * @param {string} roomId
     * @param {string} clientId
     */
    #changeHostIfDisconnected(roomId, clientId) {
        const room = this.#rooms[roomId];
        if (room && room.host === clientId && room.participants.length > 1) {
            const participantsWithoutClient = room.participants.filter((e) => e !== clientId);
            room.host = participantsWithoutClient[0]; // Set new host

            // Inform all participants about the new host
            participantsWithoutClient.forEach(p => {
                const client = this.#clients.get(p);
                if (client) client.send(encode({
                    type: 'host_migrated',
                    newHost: room.host,
                }), { binary: true });
            });
        }
    }

    /**
     * Generate a random token to prevent malicious reconnect attempts
     * @returns {string} - Token
     */
    #generateSessionToken() {
        let token = '';
        for (let i = 0; i < 16; i++) token += Math.floor(Math.random() * 16).toString(16);
        return token;
    }

    /**
     * Check rate limit using token bucket algorithm
     * @private
     */
    #checkRateLimit(connectionId, operationType) {
        const MAX_POINTS = 20;
        const now = Date.now();

        if (!this.#rateLimits.has(connectionId)) {
            this.#rateLimits.set(connectionId, { points: MAX_POINTS, lastReset: now });
            return true;
        }

        const limit = this.#rateLimits.get(connectionId);

        // Reset points if interval has passed (1s)
        if (now - limit.lastReset > 1000) {
            limit.points = MAX_POINTS;
            limit.lastReset = now;
        }

        const pointCost = operationType == "create_room" ? 5 : 1;
        if (limit.points < pointCost) return false;

        limit.points -= pointCost;
        return true;
    }

    /**
     * Handle client disconnection
     * @private
     */
    #handleDisconnection(ws) {
        this.#rateLimits.delete(ws.connectionId);

        if (ws.clientId) {
            this.#clients.delete(ws.clientId); // Immediately remove from active clients (otherwise, server would try to message this client)

            // If client was in a room, check if they were the host & migrate
            const roomId = this.#clientRooms.get(ws.clientId);
            if (roomId != null) this.#changeHostIfDisconnected(roomId, ws.clientId);

            if (ws.willfulDisconnect) {
                this.#disconnectClient(ws); // Immediate disconnection
            } else {
                // Pending complete disconnection with 5s grace period to allow for reconnections
                this.#pendingDisconnects.set(ws.clientId, {
                    timeout: setTimeout(() => {
                        this.#disconnectClient(ws);
                    }, 5000)
                });
            }
        }
    }

    /**
     * Disconnect a client
     * @private
     * @param {Object} ws 
     */
    #disconnectClient(ws) {
        this.#pendingDisconnects.delete(ws.clientId);
        this.#clientTokens.delete(ws.clientId);
        const roomId = this.#clientRooms.get(ws.clientId);
        const room = this.#rooms[roomId];

        if (room) {
            room.participants = room.participants.filter(p => p !== ws.clientId); // Remove client from room
            this.#clientRooms.delete(ws.clientId);

            if (room.participants?.length === 0) {
                delete this.#rooms[roomId]; // Delete room if now empty
                this.#roomVersions.delete(roomId); // Delete room version
                if (this.#debug) console.log("Deleted room with id " + roomId + ".");
            } else {
                // Notify remaining participants
                room.participants.forEach(p => {
                    const client = this.#clients.get(p);
                    if (client) client.send(encode({
                        type: 'client_disconnected',
                        client: ws.clientId,
                        participantCount: room.participants.length
                    }), { binary: true });
                });
            }
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
     * Kick a player from the server
     * @param {string} clientId - Client ID
     * @param {string} [reason] - Optional reason
     */
    kick(clientId, reason) {
        const client = this.#clients.get(clientId)
        if (client) {
            client.send(encode({ type: 'kicked', reason }), { binary: true });
            client.close();
        }
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
            this.#clients.forEach(client => {
                client.send(encode({ type: 'server_stopped' }), { binary: true });
                client.close();
            });
            this.#wss.close();
        }
        if (this.#server && this.#ownsServer) {
            this.#server.close(() => {
                console.log('PlaySocket server stopped.');
            });
        }
        this.#pendingDisconnects.forEach((data) => {
            clearTimeout(data.timeout);
        });
    }

    get getRooms() { return { ...this.#rooms } }
}

module.exports = PlaySocketServer;