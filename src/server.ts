import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { createServer, type Server } from 'node:http';
import { decode, encode } from '@msgpack/msgpack';
import CRDTManager, { type Operation, type PropertyUpdateData } from './crdtManager.ts';
import type { Buffer } from 'node:buffer';
import { clearTimeout, setTimeout } from 'node:timers';
import type { KeysWhereValueIsArray } from './SharedTypes.ts';

type HttpServer = Server;
type Room<T extends Record<string, unknown>> = {
    participants: string[];
    host: string;
    maxSize: number;
    crdtManager: CRDTManager<T>;
};

export type ServerOptions = {
    server?: HttpServer;
    port?: number;
    path?: string;
    debug?: boolean;
    rateLimit?: number;
};
type WebSocketExtension = {
    clientId: string;
    connectionId: string;
    isAlive?: boolean;
    willfulDisconnect?: boolean;
    isTerminating?: boolean;
};

type EventHandler<T> = {
    'clientRegistered': (clientId: string, customData: unknown) => void;
    'clientRegistrationRequested': (
        clientId: string,
        customData: unknown
    ) => boolean | string | Promise<boolean | string>;
    'clientDisconnected': (clientId: string, roomId: string | null) => void;
    'clientJoinedRoom': (clientId: string, roomId: string) => void;
    'clientJoinRequested': (clientId: string, roomId: string) => boolean | string | Promise<boolean | string>;
    'roomCreated': (roomId: string) => void;
    'roomCreationRequested': (
        data: { roomId: string; clientId: string; initialStorage: T }
    ) => T | boolean | Promise<T | boolean>;
    'requestReceived': (data: { roomId: string | null; clientId: string; name: string; data: object }) => void;
    'storageUpdated': (data: { roomId: string; clientId: string | null; update: object; storage: T }) => void;
    'storageUpdateRequested': (
        data: { roomId: string; clientId: string; update: object }
    ) => boolean | Promise<boolean>;
    'roomDestroyed': (roomId: string) => void;
};

/** PlaySocketServer - WebSocket server for PlaySocket multiplayer library */
export default class PlaySocketServer<T extends Record<string, unknown> = Record<string, unknown>> {
    #server: HttpServer;
    #ownsServer = false;
    #rateLimitMaxPoints: number;
    #wss: WebSocketServer & { clients: Set<WebSocket & WebSocketExtension> };

    #clients = new Map<string, WebSocket & WebSocketExtension>(); // ClientId -> WebSocket instance
    #rooms: Record<string, Room<T>> = {};
    #clientRooms = new Map<string, string>(); // ClientId -> RoomId
    #rateLimits = new Map<string, { points: number; lastReset: number }>(); // Rate limiting storage
    #callbacks = new Map<keyof T, Function[]>(); // Event -> [callback functions]
    #heartbeatInterval: number;
    #pendingDisconnects = new Map<string, { timeout: NodeJS.Timeout; roomId?: string }>(); // ClientId -> {timeout, roomId}
    #clientTokens = new Map<string, string>(); // ClientId -> Token
    #roomVersions = new Map<string, number>(); // RoomId -> Version

    // Debug
    #debug = false;

    /** Create a new PlaySocketServer instance */
    constructor({ server, port = 3000, path = '/', debug = false, rateLimit = 20 }: ServerOptions = {}) {
        if (debug) this.#debug = true;
        this.#rateLimitMaxPoints = rateLimit;

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
        }) as WebSocketServer & { clients: Set<WebSocket & WebSocketExtension> };

        // Set up ws event handlers
        this.#wss.on('connection', (ws: WebSocket & WebSocketExtension) => {
            ws.connectionId = crypto.randomUUID();
            ws.isAlive = true;
            ws.on('pong', () => {
                ws.isAlive = true;
            });
            ws.on('message', (msg: ArrayBuffer | Buffer) => this.#handleMessage(ws, msg));
            ws.on('close', () => this.#handleDisconnection(ws));
            ws.on('error', (error) => {
                console.error(`PlaySocket WebSocket connection error for client ${ws.clientId ?? 'unknown'}:`, error); // Catch conn errors
            });
        });

        // Log & catch server-level errors
        this.#wss.on('error', (error) => {
            console.error('PlaySocket WebSocket server error:', error);
        });

        // Start heartbeat
        this.#heartbeatInterval = setInterval(() => {
            this.#wss.clients.forEach((ws: WebSocket & WebSocketExtension) => {
                if (!ws.isAlive) return ws.terminate();
                ws.isAlive = false;
                ws.ping();
            });
        }, 15000);
    }

    /**
     * Handle WebSocket message
     */
    async #handleMessage(ws: WebSocket & WebSocketExtension, message: ArrayBuffer | Buffer) {
        if (ws.isTerminating) return;
        try {
            type Data = {
                type: string;
                id: string;
                customData?: unknown;
                sessionToken?: string;
                roomId?: string;
                size?: number;
                initialStorage: T;
                update?: PropertyUpdateData<T>;
                request: { name: string; data: object };
            };
            const data = decode(message) as Data;

            // Apply rate limiting to all connections (including unregistered)
            if (!this.#checkRateLimit(ws.connectionId, data.type)) {
                if (!ws.isTerminating) {
                    ws.isTerminating = true; // Prevent multiple terminate calls (it is async)
                    ws.terminate();
                    return console.error(`Connection ${ws.connectionId} terminated due to rate limit violations.`);
                }
            }

            switch (data.type) {
                case "register": {
                    // Register client ID if provided & check for a duplicate
                    if (data.id && this.#clients.get(data.id)) {
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
                    ws.send(encode({ type: "registered", id: data.id, sessionToken }), { binary: true });
                    this.#triggerEvent("clientRegistered", data.id, data.customData);
                } break;

                case "reconnect": {
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
                        const formerRoomId = this.#clientRooms.get(data.id)!;
                        const formerRoom = this.#rooms[formerRoomId];
                        if (formerRoom) {
                            if (this.#debug) console.log(`State sent for reconnection for room ${formerRoomId}:`, formerRoom.crdtManager.getState);
                            roomData = {
                                state: formerRoom.crdtManager.getState,
                                participantCount: formerRoom.participants.length,
                                host: formerRoom.host,
                                version: this.#roomVersions.get(formerRoomId)
                            };
                        }

                        ws.send(encode({ type: "reconnected", roomData }), { binary: true });
                    } else {
                        ws.send(encode({ type: "reconnection_failed", reason: "Client unknown to server." }), { binary: true });
                    }
                } break;

                case "create_room": {
                    if (!ws.clientId) return;

                    let newRoomId;

                    if (this.#clientRooms.get(ws.clientId)) {
                        ws.send(encode({
                            type: 'room_creation_failed',
                            reason: 'Already in a room.'
                        }), { binary: true });
                        return;
                    }

                    // Generate room ID
                    for (let i = 0; i < 50; i++) {
                        const id = this.#generateId();
                        if (!this.#rooms[id]) {
                            newRoomId = id;
                            break;
                        }
                    }

                    if (!newRoomId) {
                        ws.send(encode({ type: "room_creation_failed", reason: "No available ID found." }), { binary: true });
                        throw new Error("Failed to generate unique room ID!");
                    }

                    const roomCrdtManager = new CRDTManager<T>(this.#debug); // Create the room's crdt manager

                    // Event callback with potential initial storage modifications
                    const reviewedStorage = await this.#triggerEvent("roomCreationRequested", { roomId: newRoomId, clientId: ws.clientId, initialStorage: structuredClone({ ...data.initialStorage }) });
                    if (typeof reviewedStorage === "object") data.initialStorage = reviewedStorage;
                    if (reviewedStorage === false) {
                        ws.send(encode({
                            type: 'room_creation_failed',
                            reason: 'Room creation denied.'
                        }), { binary: true });
                        return;
                    }

                    // Check if client/creator is still connected
                    if (!this.#clients.has(ws.clientId)) {
                        if (this.#debug) console.log(`Room creation cancelled - client ${ws.clientId} disconnected during event callback.`);
                        return; // Abort room creation if client is no longer connected
                    }

                    // Load initial storage if provided
                    if (data.initialStorage) {
                        Object.entries(data.initialStorage)?.forEach(([key, value]) => {
                            roomCrdtManager.updateProperty(key, "set", value);
                        });
                    }

                    // Create room
                    const maxSize = Math.min(Number(data.size), 100) ?? 100; // Max. limit is 100 clients / room
                    this.#roomVersions.set(newRoomId, 0); // Start with version 0
                    this.#rooms[newRoomId] = {
                        participants: [ws.clientId],
                        host: ws.clientId,
                        maxSize,
                        crdtManager: roomCrdtManager
                    };
                    this.#clientRooms.set(ws.clientId, newRoomId); // Add client to the room

                    ws.send(encode({ type: "room_created", state: roomCrdtManager.getState, roomId: newRoomId, size: maxSize }), { binary: true });
                    this.#triggerEvent("roomCreated", newRoomId);
                    if (this.#debug) console.log(`Room ${newRoomId} created with initial storage:`, data.initialStorage);
                } break;

                case "join_room": {
                    if (!data.roomId || !ws.clientId) return;
                    const roomId = data.roomId;
                    const room = this.#rooms[roomId];

                    const rejectJoin = (reason: string) => {
                        ws.send(encode({ type: "join_rejected", reason }), { binary: true });
                    };

                    // Event callback
                    const joinAllowed = await this.#triggerEvent("clientJoinRequested", ws.clientId, roomId);
                    if (joinAllowed === false || typeof joinAllowed === "string") return rejectJoin(typeof joinAllowed === "string" ? joinAllowed : "Denied.");

                    if (!room) return rejectJoin("Room not found.");
                    if (this.#clientRooms.get(ws.clientId)) return rejectJoin("Already in a room.");
                    if (room.participants.length >= room.maxSize) return rejectJoin("Room full.");

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
                    room.participants.forEach((p) => {
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
                } break;

                case "update_property": {
                    const updateRoomId = this.#clientRooms.get(ws.clientId);
                    const updateRoom = updateRoomId ? this.#rooms[updateRoomId] : null;

                    if (updateRoom && data.update) {
                        // Check if update is allowed via event callback (provide clone to ensure update integrity)
                        const updateAllowed = await this.#triggerEvent("storageUpdateRequested", { roomId: updateRoomId!, clientId: ws.clientId, update: structuredClone(data.update) });
                        if (updateAllowed === false) {
                            ws.send(encode({
                                type: 'property_update_rejected',
                                state: updateRoom.crdtManager.getState
                            }), { binary: true });
                            return;
                        }

                        updateRoom.crdtManager.importPropertyUpdate(data.update); // Import update into server state

                        // Increment version for this room
                        const currentVersion = this.#roomVersions.get(updateRoomId!)! + 1;
                        this.#roomVersions.set(updateRoomId!, currentVersion);

                        updateRoom.participants?.forEach((p) => {
                            const client = this.#clients.get(p);
                            if (client) {
                                client.send(encode({
                                    type: 'property_updated',
                                    update: data.update,
                                    version: currentVersion
                                }), { binary: true });
                            }
                        });

                        this.#triggerEvent("storageUpdated", { roomId: updateRoomId!, clientId: ws.clientId, update: structuredClone(data.update), storage: this.getRoomStorage(updateRoomId!)! });
                        if (this.#debug) console.log("Property update received and imported:", data.update);
                    }
                } break;

                case "request": {
                    if (!ws.clientId) return;
                    const requestorRoomId = this.#clientRooms.get(ws.clientId) ?? null;
                    this.#triggerEvent("requestReceived", { roomId: requestorRoomId, clientId: ws.clientId, name: data.request.name, data: data.request.data });
                } break;

                case "disconnect": {
                    // Client signals to server that it will will willfully disconnect soon
                    ws.willfulDisconnect = true;
                } break;
            }
        } catch (error) {
            console.error('Error in message handler:', error);
        }
    }

    /**
     * Generate a readable, 6 digit ID
     */
    #generateId() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789';
        return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    }

    /**
     * If the client that disconnected (and is now in the reconnection-phase) was the room host,
     * pick a new room host immediately to avoid host-less phase (in case important logic is attached to the host)
     */
    #changeHostIfDisconnected(roomId: string, clientId: string) {
        const room = this.#rooms[roomId];
        if (room && room.host === clientId && room.participants.length > 1) {
            const participantsWithoutClient = room.participants.filter((e) => e !== clientId);
            room.host = participantsWithoutClient[0]!; // Set new host

            // Inform all participants about the new host
            participantsWithoutClient.forEach((p) => {
                const client = this.#clients.get(p);
                if (client) client.send(encode({
                    type: 'host_migrated',
                    newHost: room.host,
                }), { binary: true });
            });
        }
    }

    /** Generate a random token to prevent malicious reconnect attempts */
    #generateSessionToken(): string {
        let token = '';
        for (let i = 0; i < 16; i++) token += Math.floor(Math.random() * 16).toString(16);
        return token;
    }

    /** Check rate limit using token bucket algorithm */
    #checkRateLimit(connectionId: string, operationType: string): boolean {
        const now = Date.now();

        if (!this.#rateLimits.has(connectionId)) {
            this.#rateLimits.set(connectionId, { points: this.#rateLimitMaxPoints, lastReset: now });
            return true;
        }

        const limit = this.#rateLimits.get(connectionId)!;

        // Reset points if interval has passed (1s)
        if (now - limit.lastReset > 1000) {
            limit.points = this.#rateLimitMaxPoints;
            limit.lastReset = now;
        }

        const pointCost = operationType == 'create_room' ? 5 : 1;
        if (limit.points < pointCost) return false;

        limit.points -= pointCost;
        return true;
    }

    /** Handle client disconnection */
    #handleDisconnection(ws: WebSocket & WebSocketExtension): void {
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
     */
    #disconnectClient(ws: WebSocket & { clientId: string }) {
        this.#pendingDisconnects.delete(ws.clientId);
        this.#clientTokens.delete(ws.clientId);
        const roomId = this.#clientRooms.get(ws.clientId)!;
        const room = this.#rooms[roomId];

        if (room) {
            room.participants = room.participants.filter((p) => p !== ws.clientId); // Remove client from room
            this.#clientRooms.delete(ws.clientId);

            if (room.participants?.length === 0) {
                delete this.#rooms[roomId]; // Delete room if now empty
                this.#roomVersions.delete(roomId); // Delete room version
                this.#triggerEvent('roomDestroyed', roomId);
                if (this.#debug) console.log('Deleted room with id ' + roomId + '.');
            } else {
                // Notify remaining participants
                room.participants.forEach((p) => {
                    const client = this.#clients.get(p);
                    if (client) client.send(encode({
                        type: 'client_disconnected',
                        client: ws.clientId,
                        participantCount: room.participants.length
                    }), { binary: true });
                });
            }
        }

        this.#triggerEvent('clientDisconnected', ws.clientId, roomId);
    }
    /**
     * Register an event callback
     * @param event - Event name
     * @param callback - Callback function
     */
    onEvent<K extends keyof EventHandler<T>>(event: K, callback: EventHandler<K>[K]): void {
        const validEvents = ['clientRegistered', 'clientRegistrationRequested', 'clientDisconnected', 'clientJoinedRoom', 'clientJoinRequested', 'roomCreated', 'roomCreationRequested', 'requestReceived', 'storageUpdated', 'storageUpdateRequested', 'roomDestroyed'];
        if (!validEvents.includes(event)) return console.warn(`Invalid PlaySocket event type "${event}"`);
        if (!this.#callbacks.has(event)) this.#callbacks.set(event, []);
        this.#callbacks.get(event)!.push(callback);
    }

    /**
     * Kick a player from the server
     */
    kick(clientId: string, reason?: string): void {
        const client = this.#clients.get(clientId)!;
        if (client) {
            client.willfulDisconnect = true;
            client.send(encode({ type: 'kicked', reason }), { binary: true });
            client.close();
        }
    }

    /**
     * Trigger an event to registered callbacks
     */
    async #triggerEvent<K extends keyof EventHandler<T>>(event: K, ...args: Parameters<EventHandler<T>[K]>) {
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
     */
    getRoomStorage(roomId: string): T | undefined {
        const room = this.#rooms[roomId];
        if (room) return room.crdtManager.getPropertyStore;
        return undefined;
    }

    /**
     * Update a value in a room's storage
     * @param updateValue - New value for update-matching
     */
    updateRoomStorage<K extends KeysWhereValueIsArray<T>, V extends Extract<T[K], unknown[]>, Op extends Operation['data']['type']>(
        roomId: string,
        key: Op extends 'set' ? keyof T : K,
        type: Op,
        value: Op extends 'set' ? T : V[number],
        updateValue?: unknown
    ): void {
        if (this.#debug) console.log(`Playsocket server property update for room ${roomId}, key ${String(key)}, operation ${type}, value ${value} and updateValue ${updateValue}.`);
        if (roomId in this.#rooms) {
            const room = this.#rooms[roomId]!;
            const propertyUpdate = room.crdtManager.updateProperty(key, type, value, updateValue);
            const currentVersion = this.#roomVersions.get(roomId)! + 1;
            this.#roomVersions.set(roomId, currentVersion); // Increment version for this room

            room.participants?.forEach((p) => {
                const client = this.#clients.get(p);
                if (client) {
                    client.send(encode({
                        type: 'property_updated',
                        update: propertyUpdate,
                        version: currentVersion
                    }), { binary: true });
                }
            });
            this.#triggerEvent('storageUpdated', { roomId, clientId: null, update: structuredClone(propertyUpdate)!, storage: this.getRoomStorage(roomId)! });
        }
    }

    /**
     * Close all client connections, then close the websocket and http server
     */
    stop(): void {
        clearInterval(this.#heartbeatInterval);
        if (this.#wss) {
            this.#clients.forEach((client) => {
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

    get getRooms(): Record<string, Room<T>> {
        return { ...this.#rooms };
    }
}
