import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { encode, decode } from '@msgpack/msgpack';
import CRDTManager from '../universal/crdtManager';

/* eslint-disable jsdoc/require-returns */

const MAX_ROOM_SIZE = 500;

/**
 * @typedef {import('node:http').Server} HttpServer
 * @typedef {import('ws').WebSocket} WebSocket
 */

/**
 * PlaySocket Server
 */
export default class PlaySocketServer {
    #server;
    #ownsServer = false;
    #rateLimitMaxPoints;
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
     * @param {object} options - Server configuration options
     * @param {HttpServer} [options.server] - Existing http server
     * @param {number} [options.port=3000] - Port to listen on (if no server provided)
     * @param {string} [options.path='/'] - WebSocket endpoint path
     * @param {boolean} [options.debug=false] - Enable debug logging
     * @param {number} [options.rateLimit=20] - Maximum number of operations per second per client
     */
    constructor(options = {}) {
        const { server, port = 3000, path = '/', debug = false, rateLimit = 20 } = options;

        if (debug) this.#debug = true; // Enable extra logging

        this.#rateLimitMaxPoints = rateLimit; // Set rate limit

        // Handle server creation / usage
        if (server) {
            this.#server = server; // Use provided HTTP server
        } else {
            this.#ownsServer = true;
            this.#server = createServer(); // Create HTTP server and start it
            this.#server.listen(port, () => {
                console.log(`PlaySocket server running on port ${port}.`);
            });
        }

        // Create WebSocket server
        this.#wss = new WebSocketServer({
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
     * @param {WebSocket} ws - WebSocket client
     * @param {Buffer} message - Message encoded with messagepack
     * @private
     */
    async #handleMessage(ws, message) {
        if (ws.isTerminating) return;
        try {
            const data = decode(message);

            // Apply rate limiting to all connections (including unregistered)
            if (!this.#checkRateLimit(ws.connectionId, data.type)) {
                if (!ws.isTerminating) {
                    ws.isTerminating = true; // Prevent multiple terminate calls (it is async)
                    ws.terminate();
                    console.error(`PlaySocket connection ${ws.connectionId} terminated due to rate limit violations.`);
                    return;
                }
            }

            switch (data.type) {
                case 'register': {
                    // Register client ID if provided & check for a duplicate
                    if (data.id && (this.#clients.get(data.id) || data.id === "server")) {
                        ws.send(encode({ type: 'registration_failed', reason: 'ID is taken.' }), { binary: true });
                        return;
                    }

                    // Generate client ID if none provided
                    if (!data.id) {
                        for (let i = 0; i < 50; i++) {
                            const id = this.#generateId();
                            if (!this.#clients.get(id)) {
                                data.id = id;
                                break;
                            }
                        }
                        if (!data.id) {
                            ws.send(encode({ type: 'registration_failed', reason: 'No available ID found.' }), { binary: true });
                            throw new Error('Failed to generate unique ID!');
                        }
                    }

                    // Event callback
                    const registrationAllowed = await this.#triggerEvent("clientRegistrationRequested", data.id, data.customData);
                    if (registrationAllowed === false || typeof registrationAllowed === 'string') {
                        ws.send(encode({
                            type: 'registration_failed',
                            reason: typeof registrationAllowed === 'string' ? registrationAllowed : 'Denied.'
                        }), { binary: true });
                        return;
                    }

                    ws.clientId = data.id; // Adds the provided id to the ws object as clientId
                    this.#clients.set(data.id, ws);
                    const sessionToken = this.#generateSessionToken();
                    this.#clientTokens.set(data.id, sessionToken); // Token is used when reconnecting to prevent impersonation attacks
                    ws.send(encode({ type: 'registered', id: data.id, sessionToken }), { binary: true });
                    this.#triggerEvent("clientRegistered", data.id, data.customData);
                    break;
                }

                case 'reconnect': {
                    // If user is pending disconnect, respond (otherwise it's too late)
                    const pd = this.#pendingDisconnects.get(data.id);
                    if (pd && data.sessionToken) {
                        if (data.sessionToken !== this.#clientTokens.get(data.id)) {
                            ws.send(encode({
                                type: 'reconnection_failed',
                                reason: "Session token does not match."
                            }), { binary: true });
                            return;
                        }
                        clearTimeout(pd.timeout);
                        this.#pendingDisconnects.delete(data.id);

                        // Re-assign old client ID to the new ws connection
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
                        ws.send(encode({ type: 'reconnection_failed', reason: "Client unknown to server." }), { binary: true });
                    }
                    break;
                }

                case 'create_room': {
                    if (!ws.clientId) return;

                    if (this.#clientRooms.get(ws.clientId)) {
                        ws.send(encode({
                            type: 'room_creation_failed',
                            reason: 'Already in a room.'
                        }), { binary: true });
                        return;
                    }

                    try {
                        const newRoom = await this.createRoom(data.initialStorage, data.size, ws.clientId);

                        // Check if client/creator is still connected - abort if not
                        if (!this.#clients.has(ws.clientId)) {
                            this.destroyRoom(newRoom.id);
                            if (this.#debug) console.log(`Room creation cancelled - client ${ws.clientId} disconnected during event callback.`);
                            return;
                        }

                        this.#rooms[newRoom.id].participants.push(ws.clientId) // Add client to the room
                        this.#clientRooms.set(ws.clientId, newRoom.id); // Add client to the client-room map
                        ws.send(encode({ type: 'room_created', state: newRoom.state, roomId: newRoom.id }), { binary: true });
                    } catch (error) {
                        console.error("PlaySocket error creating room:", error);
                        ws.send(encode({ type: 'room_creation_failed', reason: error.message }), { binary: true });
                    }
                    break;
                }

                case 'join_room': {
                    if (!data.roomId || !ws.clientId) return;
                    const roomId = data.roomId;
                    const room = this.#rooms[roomId];

                    const rejectJoin = (reason) => {
                        ws.send(encode({ type: 'join_rejected', reason }), { binary: true });
                    };

                    // Event callback
                    const joinAllowed = await this.#triggerEvent("clientJoinRequested", ws.clientId, roomId);
                    if (joinAllowed === false || typeof joinAllowed === 'string') return rejectJoin(typeof joinAllowed === 'string' ? joinAllowed : 'Denied.');

                    if (!room) return rejectJoin("Room not found.");
                    if (this.#clientRooms.get(ws.clientId)) return rejectJoin("Already in a room.");
                    if (room.participants.length >= room.size) return rejectJoin("Room full.");

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
                    this.#triggerEvent("clientJoinedRoom", ws.clientId, roomId);
                    break;
                }

                case 'update_property': {
                    const roomId = this.#clientRooms.get(ws.clientId);
                    const room = roomId ? this.#rooms[roomId] : null;

                    if (room && data.update) {
                        // Check if update is allowed via event callback (provide clone to ensure update integrity)
                        const updateAllowed = await this.#triggerEvent("storageUpdateRequested", { roomId, clientId: ws.clientId, update: structuredClone(data.update), storage: this.getRoomStorage(roomId) });
                        if (updateAllowed === false) {
                            ws.send(encode({
                                type: 'property_update_rejected',
                                state: room.crdtManager.getState
                            }), { binary: true });
                            return;
                        }

                        room.crdtManager.importPropertyUpdate(data.update); // Import update into server state

                        // Increment version for this room
                        const currentVersion = this.#roomVersions.get(roomId) + 1;
                        this.#roomVersions.set(roomId, currentVersion);

                        room.participants?.forEach(p => {
                            const client = this.#clients.get(p);
                            if (client) {
                                client.send(encode({
                                    type: 'property_updated',
                                    update: data.update,
                                    version: currentVersion
                                }), { binary: true });
                            }
                        });

                        this.#triggerEvent("storageUpdated", { roomId, clientId: ws.clientId, update: structuredClone(data.update), storage: this.getRoomStorage(roomId) });
                        if (this.#debug) console.log("Property update received and imported:", data.update);
                    }
                    break;
                }

                case 'request': {
                    if (!ws.clientId) return;
                    const roomId = this.#clientRooms.get(ws.clientId) || null;
                    this.#triggerEvent("requestReceived", { roomId, clientId: ws.clientId, name: data.request.name, data: data.request.data });
                    break;
                }

                case 'disconnect':
                    // Client signals to server that it will will willfully disconnect soon
                    ws.willfulDisconnect = true;
                    break;
            }
        } catch (error) {
            console.error('PlaySocket error in message handler:', error);
        }
    }

    /**
     * Generate a readable, 6 digit ID
     * @returns {string} - Id
     */
    #generateId() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789';
        return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    }

    /**
     * If the client that disconnected (and is now in the reconnection-phase) was the room host,
     * pick a new room host immediately to avoid host-less phase (in case important logic is attached to the host)
     * @param {string} roomId - ID of the room that the disconnected client was in
     * @param {string} clientId - ID of the disconnected client
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
     * @param {string} connectionId - Random connection UUID which is different from the client ID
     * @param {string} actionType - A string describing the action
     * @returns {boolean} - Whether or not the action can be allowed, true means allowed, false means limited
     * @private
     */
    #checkRateLimit(connectionId, actionType) {
        const now = Date.now();

        if (!this.#rateLimits.has(connectionId)) {
            this.#rateLimits.set(connectionId, { points: this.#rateLimitMaxPoints, lastReset: now });
            return true;
        }

        const limit = this.#rateLimits.get(connectionId);

        // Reset points if interval has passed (1s)
        if (now - limit.lastReset > 1000) {
            limit.points = this.#rateLimitMaxPoints;
            limit.lastReset = now;
        }

        const pointCost = actionType == "create_room" ? 5 : 1;
        if (limit.points < pointCost) return false;

        limit.points -= pointCost;
        return true;
    }

    /**
     * Handle client disconnection
     * @param {WebSocket} ws - WebSocket client
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
     * @param {WebSocket} ws - WebSocket client
     */
    #disconnectClient(ws) {
        this.#pendingDisconnects.delete(ws.clientId);
        this.#clientTokens.delete(ws.clientId);
        let roomId = this.#clientRooms.get(ws.clientId);
        const room = this.#rooms[roomId];

        if (room) {
            room.participants = room.participants.filter(p => p !== ws.clientId); // Remove client from room
            this.#clientRooms.delete(ws.clientId);

            if (room.participants?.length === 0 && room.host !== "server") {
                this.destroyRoom(roomId) // Destroy room if now empty & not created by server
                roomId = null; // If room was destroyed, set roomId to null
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

        this.#triggerEvent("clientDisconnected", ws.clientId, roomId);
    }

    /**
     * Register an event callback
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
     */
    onEvent(event, callback) {
        const validEvents = ["clientRegistered", "clientRegistrationRequested", "clientDisconnected", "clientJoinedRoom", "clientJoinRequested", "roomCreated", "roomCreationRequested", "requestReceived", "storageUpdated", "storageUpdateRequested", "roomDestroyed"];
        if (!validEvents.includes(event)) {
            console.warn(`Invalid PlaySocket event type "${event}"`);
            return;
        };
        if (!this.#callbacks.has(event)) this.#callbacks.set(event, []);
        this.#callbacks.get(event).push(callback);
    }

    /**
     * Kick a player from the server
     * @param {string} clientId - Client ID
     * @param {string} [reason] - Optional reason
     */
    kick(clientId, reason) {
        const client = this.#clients.get(clientId);
        if (client) {
            client.willfulDisconnect = true;
            client.send(encode({ type: 'kicked', reason }), { binary: true });
            client.close();
        }
    }

    /**
     * Trigger an event to registered callbacks
     * @param {string} event - Event name
     * @param {...*} args - Arguments
     * @returns {any} - Undefined if no callbacks, true if all callbacks ran, what the first callback with a return statement returns if present
     * @private
     */
    async #triggerEvent(event, ...args) {
        const callbacks = this.#callbacks.get(event);
        if (!callbacks) return;

        for (const callback of callbacks) {
            try {
                const result = await callback(...args);
                if (result != null) return result; // Return any non-null/undefined result
            } catch (error) {
                console.error(`PlaySocket ${event} callback error:`, error);
            }
        }
        return true;
    }

    /**
     * Get snapshot of a room's storage
     * @param {string} roomId - ID of the room to get the storage from
     * @returns {object|undefined} - Storage object or undefined if the room doesn't exist
     */
    getRoomStorage(roomId) {
        const room = this.#rooms[roomId];
        if (room) return room.crdtManager.getPropertyStore;
    }

    /**
     * Update a value in a room's storage
     * @param {string} roomId - Room ID
     * @param {string} key - Storage key
     * @param {'set' | 'array-add' | 'array-add-unique' | 'array-remove-matching' | 'array-update-matching'} type - Operation type
     * @param {*} value - New value or value to operate on
     * @param {*} updateValue - New value for update-matching
     */
    updateRoomStorage(roomId, key, type, value, updateValue) {
        if (this.#debug) console.log(`Playsocket server property update for room ${roomId}, key ${key}, operation ${type}, value ${value} and updateValue ${updateValue}.`);
        const room = this.#rooms[roomId];
        if (room) {
            const propertyUpdate = room.crdtManager.updateProperty(key, type, value, updateValue);
            const currentVersion = this.#roomVersions.get(roomId) + 1;
            this.#roomVersions.set(roomId, currentVersion); // Increment version for this room

            room.participants?.forEach(p => {
                const client = this.#clients.get(p);
                if (client) {
                    client.send(encode({
                        type: 'property_updated',
                        update: propertyUpdate,
                        version: currentVersion
                    }), { binary: true });
                }
            });
            this.#triggerEvent("storageUpdated", { roomId, clientId: null, update: structuredClone(propertyUpdate), storage: this.getRoomStorage(roomId) });
        }
    }

    /**
     * Create a room from the server
     * @async
     * @param {object} [initialStorage] - Optional initial storage object
     * @param {number} [size] - Max. room size, up to 500
     * @param {string} [host] - Host ID, defaults to "server" (when set to "server", room will not be deleted if all clients leave)
     * @returns {Promise<object>} Object containing room state and room ID
     */
    async createRoom(initialStorage, size, host = "server") {
        // Event callback with potential initial storage modifications
        const reviewedStorage = await this.#triggerEvent("roomCreationRequested", { clientId: host, initialStorage: structuredClone({ ...initialStorage }) });
        if (typeof reviewedStorage === 'object') initialStorage = reviewedStorage;
        if (reviewedStorage === false) throw new Error("Room creation denied.");

        let newRoomId;

        for (let i = 0; i < 100; i++) {
            const id = this.#generateId();
            if (!this.#rooms[id]) {
                newRoomId = id;
                break;
            }
        }

        if (!newRoomId) throw new Error("No available ID found.")
        const roomCrdtManager = new CRDTManager(this.#debug);

        if (initialStorage) Object.entries(initialStorage)?.forEach(([key, value]) => {
            roomCrdtManager.updateProperty(key, "set", value);
        });

        this.#roomVersions.set(newRoomId, 0);
        this.#rooms[newRoomId] = {
            participants: [],
            host,
            size: Math.min(Number(size), MAX_ROOM_SIZE) || MAX_ROOM_SIZE,
            crdtManager: roomCrdtManager
        };

        this.#triggerEvent("roomCreated", newRoomId);
        if (this.#debug) console.log(`Room ${newRoomId} created with initial storage:`, initialStorage);
        return { state: roomCrdtManager.getState, id: newRoomId };
    }

    /**
     * Destroy a room
     * @param {string} roomId - Room ID
     */
    destroyRoom(roomId) {
        const room = this.#rooms[roomId];
        if (!room) return; // Return if room does not exist

        // Disconnect participants if still in room
        const participants = room.participants;
        participants.forEach((clientId) => {
            this.kick(clientId, "Room destroyed by server.");
        });

        // Delete the room
        delete this.#rooms[roomId];
        this.#roomVersions.delete(roomId); // Delete room version (used to ensure all clients are up-2-date)
        this.#triggerEvent("roomDestroyed", roomId);
        if (this.#debug) console.log("Deleted room with id " + roomId + ".");
    }

    /**
     * Close all client connections, then close the websocket and http server
     */
    stop() {
        clearInterval(this.#heartbeatInterval);
        if (this.#wss) {
            this.#clients.forEach((client, clientId) => this.kick(clientId, "Server restart."));
            this.#wss.close();
        }
        if (this.#server && this.#ownsServer) this.#server.close(() => { console.log('PlaySocket server stopped.'); });
        this.#pendingDisconnects.forEach((data) => {
            clearTimeout(data.timeout);
        });
    }

    get getRooms() { return { ...this.#rooms } }
}