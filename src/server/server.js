import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { encode, decode } from "@msgpack/msgpack";
import CRDTManager, { getUpdateDetails } from "../universal/crdtManager.js";
import packageData from "../../package.json" with { type: "json" };
import { HEARTBEAT_INTERVAL } from "../universal/constants.js";

const MAX_ROOM_SIZE = 500;
export const RECONNECT_GRACE_PERIOD = 5000; // Exported for use in tests

/**
 * @typedef {import("node:http").Server} HttpServer
 * @typedef {import("../universal/crdtManager.js").PropertyUpdateType} PropertyUpdateType
 * @typedef {import("../universal/crdtManager.js").PropertyUpdate} PropertyUpdate
 * @typedef {import("../universal/crdtManager.js").CRDTState} CRDTState
 */

/** @typedef {import("ws").WebSocket} WebSocket */ // Includes custom properties from ws-extensions.d.ts

/**
 * @typedef {object} ClientMessage
 * @property {string} type - Message type
 */

/** @typedef {{ points: number, lastReset: number }} RateLimit */

/**
 * @typedef {object} Room
 * @property {string[]} participants - Client IDs of the room participants
 * @property {string | null} host - Client ID of the room host ("server" for server-owned rooms, null if the room currently has no host)
 * @property {number} size - Max. number of participants
 * @property {CRDTManager} crdtManager - CRDT manager holding the room storage
 */

/**
 * PlaySocket Server
 */
export default class PlaySocketServer {
    /** @type {HttpServer} */
    #server;
    #ownsServer = false;
    #rateLimitMaxPoints;
    #wss;
    /** @type {Map<string, WebSocket>} */
    #clients = new Map(); // ClientId -> WebSocket instance
    /** @type {Record<string, Room>} */
    #rooms = {};
    /** @type {Map<string, string>} */
    #clientRooms = new Map(); // ClientId -> RoomId
    /** @type {Map<string, RateLimit>} */
    #rateLimits = new Map(); // Rate limiting storage
    /** @type {Map<string, Function[]>} */
    #callbacks = new Map(); // Event -> [callback functions]
    #heartbeatInterval;
    /** @type {Map<string, { timeout: ReturnType<typeof setTimeout> }>} */
    #pendingDisconnects = new Map(); // ClientId -> {timeout}
    /** @type {Map<string, string>} */
    #clientTokens = new Map(); // ClientId -> Token
    /** @type {Map<string, number>} */
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
     * @param {import("ws").ServerOptions["verifyClient"]} [options.verifyClient] - Optional callback to verify client connections before upgrade. Receives (info, callback) where info contains { req, origin } and callback is (verified, code?, message?) => void
     */
    constructor(options = {}) {
        const { server, port = 3000, path = "/", debug = false, rateLimit = 20, verifyClient } = options;

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
            path,
            ...(verifyClient && { verifyClient })
        });

        // Set up ws event handlers
        this.#wss.on("connection", ws => {
            ws.uuid = crypto.randomUUID();
            ws.isAlive = true;
            ws.on("pong", () => { ws.isAlive = true; });
            ws.on("message", msg => this.#handleMessage(ws, msg));
            ws.on("close", () => this.#handleDisconnection(ws));
            ws.on("error", (error) => {
                console.error(`PlaySocket WebSocket connection error for client ${ws.clientId || "unknown"}:`, error); // Catch conn errors
            });
        });

        // Log & catch server-level errors
        this.#wss.on("error", (error) => {
            console.error("PlaySocket WebSocket server error:", error);
        });

        // Start heartbeat
        this.#heartbeatInterval = setInterval(() => {
            this.#wss.clients.forEach(ws => {
                if (!ws.isAlive) return ws.terminate();
                ws.isAlive = false;
                ws.ping();
            });
        }, HEARTBEAT_INTERVAL);
    }

    /**
     * Handle WebSocket message
     * @param {WebSocket} ws - WebSocket client
     * @param {import("ws").RawData} message - Message encoded with messagepack
     */
    async #handleMessage(ws, message) {
        if (ws.isTerminating) return;
        try {
            const data = /** @type {ClientMessage & Record<string, any>} */ (decode(/** @type {Uint8Array} */(message)));

            // Apply rate limiting to all connections (including unregistered)
            if (!this.#checkRateLimit(ws.uuid, data.type)) {
                if (!ws.isTerminating) {
                    ws.isTerminating = true; // Prevent multiple terminate calls (it is async)
                    ws.terminate();
                    console.error(`PlaySocket connection ${ws.uuid} terminated due to rate limit violations.`);
                    return;
                }
            }

            switch (data.type) {
                case "register": {
                    // Ensure client uses the same version as server
                    if (data.version !== packageData.version) {
                        ws.send(encode({ type: "registration_failed", reason: `Version mismatch (client ${data.version ? "v" + data.version : "legacy"}, server v${packageData.version}). Please reload the page, an update may have been released.` }), { binary: true });
                        return;
                    }

                    // Register client ID if provided & check for a duplicate
                    if (data.id && (this.#clients.get(data.id) || data.id === "server")) {
                        ws.send(encode({ type: "registration_failed", reason: "ID is taken." }), { binary: true });
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
                            ws.send(encode({ type: "registration_failed", reason: "No available ID found." }), { binary: true });
                            throw new Error("Failed to generate unique ID!");
                        }
                    }

                    // Event callback
                    const registrationAllowed = await this.#triggerEvent("clientRegistrationRequested", data.id, data.customData);
                    if (registrationAllowed === false || typeof registrationAllowed === "string") {
                        ws.send(encode({
                            type: "registration_failed",
                            reason: typeof registrationAllowed === "string" ? registrationAllowed : null
                        }), { binary: true });
                        return;
                    }

                    ws.clientId = data.id; // Adds the provided id to the ws object as clientId
                    this.#clients.set(data.id, ws);
                    const sessionToken = this.#generateSessionToken();
                    this.#clientTokens.set(data.id, sessionToken); // Token is used when reconnecting to prevent impersonation attacks
                    ws.send(encode({ type: "registered", id: data.id, sessionToken }), { binary: true });
                    this.#triggerEvent("clientRegistered", data.id, data.customData);
                    break;
                }

                case "reconnect": {
                    // If user is pending disconnect, respond (otherwise it's too late)
                    const pd = this.#pendingDisconnects.get(data.id);
                    if (pd && data.sessionToken) {
                        if (data.sessionToken !== this.#clientTokens.get(data.id)) {
                            ws.send(encode({
                                type: "reconnection_failed",
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
                            // If the room has no host (they were the only one and disconnected), restore them as host
                            if (formerRoom.host === null) formerRoom.host = data.id;
                            if (this.#debug) console.log(`State sent for reconnection for room ${formerRoomId}:`, formerRoom.crdtManager.state);
                            roomData = {
                                state: formerRoom.crdtManager.state,
                                participantCount: formerRoom.participants.length,
                                host: formerRoom.host,
                                version: this.#roomVersions.get(formerRoomId)
                            }
                        }

                        ws.send(encode({ type: "reconnected", roomData }), { binary: true });
                    } else {
                        ws.send(encode({ type: "reconnection_failed", reason: "Client unknown to server." }), { binary: true });
                    }
                    break;
                }

                case "create_room": {
                    if (!ws.clientId) return;

                    if (this.#clientRooms.get(ws.clientId)) {
                        ws.send(encode({
                            type: "room_creation_failed",
                            reason: "Already in a room."
                        }), { binary: true });
                        return;
                    }

                    // Event callback with potential initial storage modifications
                    const reviewedStorage = await this.#triggerEvent("roomCreationRequested", { clientId: ws.clientId, initialStorage: structuredClone({ ...data.initialStorage }) });
                    if (typeof reviewedStorage === "object") data.initialStorage = reviewedStorage;
                    if (reviewedStorage === false || typeof reviewedStorage === "string") {
                        ws.send(encode({ type: "room_creation_failed", reason: typeof reviewedStorage === "string" ? reviewedStorage : null }), { binary: true });
                        return;
                    }

                    try {
                        // Verify client is still connected and abort if not
                        if (!this.#clients.has(ws.clientId)) {
                            if (this.#debug) console.log(`Room creation cancelled - client ${ws.clientId} disconnected during event callback.`);
                            return;
                        }

                        const newRoom = this.createRoom(data.initialStorage, data.size, ws.clientId); // Create room

                        this.#rooms[newRoom.id].participants.push(ws.clientId) // Add client to the room
                        this.#clientRooms.set(ws.clientId, newRoom.id); // Add client to the client-room map
                        ws.send(encode({ type: "room_created", state: newRoom.state, roomId: newRoom.id, participantCount: this.#rooms[newRoom.id].participants.length }), { binary: true });
                    } catch (error) {
                        console.error("PlaySocket error creating room:", error);
                        ws.send(encode({ type: "room_creation_failed", reason: error.message }), { binary: true });
                    }
                    break;
                }

                case "join_room": {
                    if (!data.roomId || !ws.clientId) return;
                    const roomId = data.roomId;

                    /** @param {string} reason */
                    const rejectJoin = (reason) => {
                        ws.send(encode({ type: "join_rejected", reason }), { binary: true });
                    };

                    // Event callback
                    const joinAllowed = await this.#triggerEvent("clientJoinRequested", ws.clientId, roomId);
                    if (joinAllowed === false || typeof joinAllowed === "string") return rejectJoin(typeof joinAllowed === "string" ? joinAllowed : null);

                    // Verify client is still connected and abort if not
                    if (!this.#clients.has(ws.clientId)) {
                        if (this.#debug) console.log(`Room join cancelled - client ${ws.clientId} disconnected during event callback.`);
                        return;
                    }

                    try {
                        this.#joinRoom(ws.clientId, roomId);
                    } catch (error) {
                        rejectJoin(error.message);
                    }

                    break;
                }

                case "update_property": {
                    const roomId = this.#clientRooms.get(ws.clientId);
                    const room = roomId ? this.#rooms[roomId] : null;

                    if (room && data.update) {
                        // Check if update is allowed via event callback (provide clone to ensure update integrity)
                        const updateAllowed = await this.#triggerEvent("storageUpdateRequested", { roomId, clientId: ws.clientId, update: structuredClone(data.update), storage: this.getRoomStorage(roomId) });
                        if (updateAllowed === false || typeof updateAllowed === "string") {
                            ws.send(encode({
                                type: "property_update_rejected",
                                reason: typeof updateAllowed === "string" ? updateAllowed : null,
                                update: data.update
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
                                    type: "property_updated",
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

                case "request": {
                    if (!ws.clientId) return;
                    const roomId = this.#clientRooms.get(ws.clientId) || null;
                    const requestSuccess = await this.#triggerEvent("requestReceived", { roomId, clientId: ws.clientId, name: data.request.name, data: data.request.data });
                    if (requestSuccess === false || typeof requestSuccess === "string") ws.send(encode({ type: "request_failed", request: data.request, reason: typeof requestSuccess === "string" ? requestSuccess : null }), { binary: true });
                    else ws.send(encode({ type: "request_succeeded", request: data.request }), { binary: true });
                    break;
                }

                case "disconnect":
                    // Client signals to server that it will will willfully disconnect soon
                    ws.willfulDisconnect = true;
                    break;
            }
        } catch (error) {
            console.error("PlaySocket error in message handler:", error);
        }
    }

    /**
     * Generate a readable, 6 digit ID
     * @returns {string} - Id
     */
    #generateId() {
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789";
        return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    }

    /**
     * Migrate the host role to another participant
     * @param {string} roomId - ID of the room
     * @param {string} clientId - ID of the current host
     */
    #migrateHost(roomId, clientId) {
        const room = this.#rooms[roomId];
        if (!room) throw new Error("Room not found.");
        if (room.host !== clientId) throw new Error("Client is not the host.");

        const remainingParticipants = room.participants.filter(p => p !== clientId);

        if (remainingParticipants.length >= 1) {
            // Inform all participants about the new host
            room.host = remainingParticipants[0];
            remainingParticipants.forEach(p => {
                const client = this.#clients.get(p);
                if (client) client.send(encode({
                    type: "host_migrated",
                    newHost: room.host,
                }), { binary: true });
            });
        } else room.host = null; // The next person to join will become the host
    }

    /**
     * Generate a random token to prevent malicious reconnect attempts
     * @returns {string} - Token
     */
    #generateSessionToken() {
        let token = "";
        for (let i = 0; i < 16; i++) token += Math.floor(Math.random() * 16).toString(16);
        return token;
    }

    /**
     * Check rate limit using token bucket algorithm
     * @param {string} connUuid - Connection UUID (which is different from the client ID)
     * @param {string} actionType - A string describing the action
     * @returns {boolean} - Whether or not the action can be allowed, true means allowed, false means limited
     */
    #checkRateLimit(connUuid, actionType) {
        const now = Date.now();

        if (!this.#rateLimits.has(connUuid)) {
            this.#rateLimits.set(connUuid, { points: this.#rateLimitMaxPoints, lastReset: now });
            return true;
        }

        const limit = this.#rateLimits.get(connUuid);

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
     */
    #handleDisconnection(ws) {
        this.#rateLimits.delete(ws.uuid);

        if (ws.clientId) {
            this.#clients.delete(ws.clientId); // Immediately remove from active clients (otherwise, server would try to message this client)

            // If client was in a room, check if they were the host & migrate
            const roomId = this.#clientRooms.get(ws.clientId);
            if (roomId != null && this.#rooms[roomId]?.host === ws.clientId) this.#migrateHost(roomId, ws.clientId);

            if (ws.willfulDisconnect) this.#disconnectClient(ws); // Immediate disconnection
            else {
                // Pending complete disconnection with 5s grace period to allow for reconnections
                this.#pendingDisconnects.set(ws.clientId, {
                    timeout: setTimeout(() => {
                        this.#disconnectClient(ws);
                    }, RECONNECT_GRACE_PERIOD)
                });
            }
        }
    }

    /**
     * Disconnect a client
     * @param {WebSocket} ws - WebSocket client
     */
    #disconnectClient(ws) {
        this.#pendingDisconnects.delete(ws.clientId);
        this.#clientTokens.delete(ws.clientId);
        const roomId = this.#clientRooms.get(ws.clientId);
        if (roomId && this.#rooms[roomId]) this.#leaveRoom(ws.clientId, roomId);
        this.#triggerEvent("clientDisconnected", ws.clientId);
    }

    /**
     * Register an event callback
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
     * @returns {Function} - Unsubscribe
     */
    onEvent(event, callback) {
        const validEvents = ["clientRegistered", "clientRegistrationRequested", "clientDisconnected", "clientJoinedRoom", "clientLeftRoom", "clientJoinRequested", "roomCreated", "roomCreationRequested", "requestReceived", "storageUpdated", "storageUpdateRequested", "roomDestroyed"];
        if (!validEvents.includes(event)) {
            console.warn(`Invalid PlaySocket event type "${event}"`);
            return () => { };
        };
        if (!this.#callbacks.has(event)) this.#callbacks.set(event, []);
        this.#callbacks.get(event).push(callback);

        return () => {
            const removeIndex = this.#callbacks.get(event)?.indexOf(callback) ?? -1;
            if (removeIndex === -1) return;
            this.#callbacks.get(event).splice(removeIndex, 1);
            if (!this.#callbacks.get(event).length) this.#callbacks.delete(event);
        }
    }

    /**
     * Trigger an event to registered callbacks
     * @param {string} event - Event name
     * @param {...*} args - Arguments
     * @returns {Promise<any>} - The first non-null callback return value if present (all callbacks run, a throwing callback counts as returning false), otherwise true
     */
    async #triggerEvent(event, ...args) {
        const syncOnlyEvents = ["storageUpdateRequested"]; // Async storage validation could mess up GC and would lead to potentially poor UX (slow sync)
        const callbacks = this.#callbacks.get(event);
        if (!callbacks) return;

        let firstResult;
        for (const callback of [...callbacks]) {
            try {
                let result = callback(...args);
                if (typeof result?.then === "function") {
                    if (syncOnlyEvents.includes(event)) {
                        result.catch(() => { });
                        console.error(`PlaySocket ${event} callbacks must be synchronous.`);
                        result = `${event} callback must be synchronous.`; // Rejection string to explicitly block this practice
                    } else result = await result;
                }
                if (firstResult == null && result != null) firstResult = result;
            } catch (error) {
                console.error(`PlaySocket ${event} callback error:`, error);
                if (firstResult == null) firstResult = false; // Fail closed (false blocks for most events)
            }
        }
        return firstResult ?? true;
    }

    /**
     * Kick a client from the server
     * @param {string} clientId - Client ID
     * @param {string} [reason] - Optional reason
     */
    kick(clientId, reason = null) {
        const client = this.#clients.get(clientId);
        if (!client) return; // Client not connected, skip
        client.willfulDisconnect = true;
        client.send(encode({ type: "kicked", reason }), { binary: true });
        client.close();
    }

    /**
     * Move client into a different room
     * @param {string} clientId - Client ID
     * @param {string} roomId - Room ID (Target)
     */
    move(clientId, roomId) {
        const client = this.#clients.get(clientId);
        const oldRoomId = this.#clientRooms.get(clientId);
        const oldRoom = this.#rooms[oldRoomId];
        const targetRoom = this.#rooms[roomId];
        if (!client && !this.#pendingDisconnects.has(clientId)) throw new Error("Client not found.");
        if (!oldRoomId) throw new Error("Client is not in a room.");
        if (!oldRoom) throw new Error("Client room not found.");
        if (oldRoomId === roomId) throw new Error("Client is already in target room.");
        if (!targetRoom) throw new Error("Target room not found.");
        if (targetRoom.participants.length >= targetRoom.size) throw new Error("Target room is full.");
        if (oldRoom.host === clientId) this.#migrateHost(oldRoomId, clientId);
        this.#leaveRoom(clientId, oldRoomId);
        this.#joinRoom(clientId, roomId);
    }

    /**
     * Get snapshot of a room's storage
     * @param {string} roomId - ID of the room to get the storage from
     * @returns {Record<string, any> | undefined} - Storage object or undefined if the room doesn't exist
     */
    getRoomStorage(roomId) {
        const room = this.#rooms[roomId];
        if (room) return room.crdtManager.propertyStore;
    }

    /**
     * Get the operation details from a storage update (e.g. in the "storageUpdateRequested" event)
     * @param {PropertyUpdate} update - Property update
     * @returns {{key: string | undefined, type: PropertyUpdateType | undefined, value: *, secondValue: *}} - Operation details
     */
    getUpdateDetails(update) {
        return getUpdateDetails(update);
    }

    /**
     * Update a value in a room's storage
     * @param {string} roomId - Room ID
     * @param {string} key - Storage key
     * @param {PropertyUpdateType} type - Operation type
     * @param {*} value - Value
     * @param {*} [secondValue] - Second value (needed for some operations)
     */
    updateRoomStorage(roomId, key, type, value, secondValue) {
        if (this.#debug) console.log(`Playsocket server property update for room ${roomId}, key ${key}, operation ${type}, value ${value} and secondValue ${secondValue}.`);
        const room = this.#rooms[roomId];
        if (room) {
            const propertyUpdate = room.crdtManager.updateProperty(key, type, value, secondValue);
            const currentVersion = this.#roomVersions.get(roomId) + 1;
            this.#roomVersions.set(roomId, currentVersion); // Increment version for this room

            room.participants?.forEach(p => {
                const client = this.#clients.get(p);
                if (client) {
                    client.send(encode({
                        type: "property_updated",
                        update: propertyUpdate,
                        version: currentVersion
                    }), { binary: true });
                }
            });
            this.#triggerEvent("storageUpdated", { roomId, clientId: null, update: structuredClone(propertyUpdate), storage: this.getRoomStorage(roomId) });
        }
    }

    /**
     * Create a room
     * @param {object} [initialStorage] - Optional initial storage object
     * @param {number} [size] - Max. room size, up to 500
     * @param {string} [host] - Host ID, defaults to "server" (when set to "server", room will not be deleted if all clients leave)
     * @returns {{ state: CRDTState, id: string }} Object containing room state and room ID
     */
    createRoom(initialStorage, size, host = "server") {
        let newRoomId;

        for (let i = 0; i < 100; i++) {
            const id = this.#generateId();
            if (!this.#rooms[id]) {
                newRoomId = id;
                break;
            }
        }

        if (!newRoomId) throw new Error("No available ID found.");
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
        return { state: roomCrdtManager.state, id: newRoomId };
    }

    /**
     * Make a client join a room
     * @param {string} clientId - Client ID
     * @param {string} roomId - Room ID
     */
    #joinRoom(clientId, roomId) {
        const room = this.#rooms[roomId];
        const client = this.#clients.get(clientId);
        if (!room) throw new Error("Room not found.");
        if (!client && !this.#pendingDisconnects.has(clientId)) throw new Error("Client not found.");
        if (this.#clientRooms.get(clientId)) throw new Error("Already in a room.");
        if (room.participants.length >= room.size) throw new Error("Room full.");

        room.participants.push(clientId);
        this.#clientRooms.set(clientId, roomId);

        // Notify joiner with initial storage (only if connected - pending disconnect clients get state on reconnect)
        if (client) {
            if (this.#debug) console.log("Room state sent for join:", room.crdtManager.state);
            client.send(encode({
                type: "join_accepted",
                roomId,
                state: room.crdtManager.state,
                participantCount: room.participants.length,
                host: room.host,
                version: this.#roomVersions.get(roomId)
            }), { binary: true });
        }

        // If the room has no host (previous host disconnected and was the only participant), make joiner the host
        // Set new host after join_accepted so hostMigrated event fires correctly on client
        const becameHost = room.host === null;
        if (becameHost) {
            room.host = clientId; // Change host
            if (client) {
                client.send(encode({
                    type: "host_migrated",
                    newHost: room.host,
                }), { binary: true });
            }
        }

        // Notify existing participants
        room.participants.forEach(p => {
            if (p === clientId) return;
            const client = this.#clients.get(p);
            if (client) {
                client.send(encode({
                    type: "client_joined",
                    client: clientId,
                    participantCount: room.participants.length
                }), { binary: true });
            }
        });
        this.#triggerEvent("clientJoinedRoom", clientId, roomId);
    }

    /**
     * Make a client leave a room
     * @param {string} clientId - Client ID
     * @param {string} roomId - Room ID
     */
    #leaveRoom(clientId, roomId) {
        const room = this.#rooms[roomId];
        if (!room) throw new Error("Room not found.");

        room.participants = room.participants.filter(p => p !== clientId); // Remove client from room
        this.#clientRooms.delete(clientId);
        this.#triggerEvent("clientLeftRoom", clientId, roomId); // Before potential room destruction to allow for accessing its data in callback

        if (room.participants.length === 0 && room.host !== "server") {
            this.destroyRoom(roomId); // Destroy room if now empty & not by server
        } else {
            // Notify remaining participants
            room.participants.forEach(p => {
                const client = this.#clients.get(p);
                if (client) client.send(encode({
                    type: "client_left",
                    client: clientId,
                    participantCount: room.participants.length
                }), { binary: true });
            });
        }
    }

    /**
     * Destroy a room
     * @param {string} roomId - Room ID
     */
    destroyRoom(roomId) {
        const room = this.#rooms[roomId];
        if (!room) throw new Error("Room not found.");

        // Disconnect clients if still in room
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
        if (this.#server && this.#ownsServer) this.#server.close(() => { console.log("PlaySocket server stopped."); });
        this.#pendingDisconnects.forEach((data) => {
            clearTimeout(data.timeout);
        });
    }

    get rooms() { return structuredClone(this.#rooms) }
}