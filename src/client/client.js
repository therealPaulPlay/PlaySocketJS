import { encode, decode } from "@msgpack/msgpack";
import CRDTManager from "../universal/crdtManager";

const ERROR_PREFIX = "PlaySocket error: ";
const WARNING_PREFIX = "PlaySocket warning: ";
const LOG_PREFIX = "PlaySocket log: ";
const TIMEOUT_MS = 3000; // 3 second timeout for WS messages

/**
 * PlaySocket Client
 */
export default class PlaySocket {
    // Core properties
    #id; // Unique client ID
    #sessionToken; // Unique session token
    #endpoint;
    #socket; // WebSocket connection
    #initialized = false; // Initialization status
    #customData;

    // Room properties
    #roomHost;
    #inRoom; // If the client is currently in  a room or not
    #connectionCount = 0;
    #crdtManager;
    #roomVersion = 0; // Update version (used to compare local vs. remote state to detect package loss)

    // Event handling
    #callbacks = new Map(); // Event callbacks

    // Async server operations
    #pendingJoin;
    #pendingCreate;
    #pendingRegistration;
    #pendingConnect;
    #pendingReconnect;

    // Timeouts or intervals
    #reconnectTimeout;
    #reconnectCount = 0;
    #isReconnecting = false;

    // Debug
    #debug = false;

    /**
     * Create a new PlaySocket instance
     * @param {string} id - Unique identifier for this client
     * @param {object} options - Connection options
     * @param {string} options.endpoint - WebSocket endpoint path
     * @param {object} [options.customData] - Custom registration data
     * @param {boolean} [options.debug=false] - Enable debug logging
     */
    constructor(id, options = {}) {
        this.#id = id;
        if (options.endpoint) this.#endpoint = options.endpoint;
        if (options.customData) this.#customData = { ...options.customData };
        if (options.debug) this.#debug = true; // Enabling extra logging
        this.#crdtManager = new CRDTManager(this.#debug);
    }

    /**
     * Helper to create timeout promises for create room, join room etc.
     * @param {string} name - Name of the timeout
     * @returns {Promise} - Promise that rejects after the timeout
     * @private
     */
    #createTimeout(name) {
        return new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${name} timed out`)), TIMEOUT_MS)
        );
    }

    /**
     * Register an event callback
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
     */
    onEvent(event, callback) {
        const validEvents = ["status", "error", "instanceDestroyed", "storageUpdated", "hostMigrated", "clientJoined", "clientLeft"];
        if (!validEvents.includes(event)) {
            console.warn(WARNING_PREFIX + `Invalid event type "${event}".`);
            return;
        };
        if (!this.#callbacks.has(event)) this.#callbacks.set(event, []);
        this.#callbacks.get(event).push(callback);
    }

    /**
     * Trigger an event to registered callbacks
     * @param {string} event - Event name
     * @param {...*} args - Arguments
     * @private
     */
    #triggerEvent(event, ...args) {
        const callbacks = this.#callbacks.get(event);
        callbacks?.forEach(callback => {
            try {
                callback(...args);
            } catch (error) {
                console.error(ERROR_PREFIX + `${event} callback error:`, error);
            }
        });
    }

    /**
     * Initialize the PlaySocket instance by connecting to the WS server
     * @returns {Promise} Resolves when connection is established
     */
    async init() {
        if (this.#initialized) return Promise.reject(new Error("Already initialized"));
        if (!this.#endpoint) return Promise.reject(new Error("No websocket endpoint provided"));
        this.#triggerEvent("status", "Initializing...");

        // Connect to WS server
        await this.#connect();

        // Register with server
        const id = await Promise.race([
            new Promise((resolve, reject) => {
                this.#pendingRegistration = { resolve, reject }; // Resolve or reject depending on answer to registration msg

                // Register with server
                this.#sendToServer({
                    type: 'register',
                    id: this.#id,
                    customData: this.#customData || undefined
                });
            }),
            this.#createTimeout("Registration")
        ]).finally(() => {
            this.#pendingRegistration = null;
        });

        // If the server sent out an id, store and return that
        if (id) this.#id = id;
        return this.#id;
    }

    /**
     * Connect to the WS server and
     * @returns {Promise} Resolves when the connection was established
     * @private 
     */
    async #connect() {
        return Promise.race([
            new Promise((resolve, reject) => {
                this.#pendingConnect = { reject };
                this.#socket = new WebSocket(this.#endpoint);
                this.#socket.binaryType = 'arraybuffer'; // Important for MessagePack binary data
                this.#setupSocketHandlers(); // Message & close events
                this.#socket.onopen = resolve;
            }),
            this.#createTimeout("Connection attempt")
        ]).finally(() => {
            this.#pendingConnect = null;
        });
    }

    /**
     * Set up WebSocket message & close handlers
     * @private
     */
    #setupSocketHandlers() {
        this.#socket.onmessage = (event) => {
            try {
                const message = decode(new Uint8Array(event.data));
                if (!message.type) return;

                switch (message.type) {
                    case 'registration_failed':
                        if (this.#pendingRegistration) {
                            this.#pendingRegistration.reject(new Error("Failed to register: " + message.reason));
                            this.#triggerEvent("error", "Failed to register: " + message.reason);
                        }
                        break;

                    case 'registered':
                        if (this.#pendingRegistration) {
                            this.#sessionToken = message.sessionToken;
                            this.#initialized = true;
                            this.#pendingRegistration.resolve(message.id);
                            this.#triggerEvent("status", "Connected to server.");
                        }
                        break;

                    case 'join_accepted':
                        // Connected to room
                        if (this.#pendingJoin) {
                            if (this.#debug) console.log(LOG_PREFIX + "State received for join:", message.state);
                            this.#inRoom = true;
                            this.#crdtManager.importState(message.state);
                            this.#connectionCount = message.participantCount - 1; // Counted without the user themselves
                            this.#roomHost = message.host;
                            this.#roomVersion = message.version;
                            this.#triggerEvent("storageUpdated", this.storage);
                            this.#triggerEvent("status", `Connected to room.`);
                            this.#pendingJoin.resolve();
                        }
                        break;

                    case 'join_rejected':
                        // Connection to room failed
                        if (this.#pendingJoin) {
                            this.#triggerEvent("status", "Failed to join room: " + message.reason);
                            this.#pendingJoin.reject(new Error("Failed to join room: " + message.reason));
                        }
                        break;

                    case 'reconnected':
                        // Successfully reconnected
                        if (this.#pendingReconnect) {
                            this.#isReconnecting = false;
                            this.#reconnectCount = 0;
                            if (message.roomData) {
                                if (this.#debug) console.log(LOG_PREFIX + "State received for reconnect:", message.roomData.state);
                                this.#crdtManager.importState(message.roomData.state);
                                this.#roomVersion = message.roomData.version;
                                this.#connectionCount = message.roomData.participantCount - 1; // Counted without the user themselves
                                this.#setHost(message.roomData.host); // Set host before in case there are .isHost checks in the storageUpdate fallback
                                this.#triggerEvent("storageUpdated", this.storage);
                            } else if (this.#inRoom) {
                                // If no room data received, but client thinks they were in a room...
                                this.#triggerEvent("error", "Reconnected, but room no longer exists.");
                                return this.destroy();
                            }
                            this.#triggerEvent("status", "Reconnected.");
                            this.#pendingReconnect.resolve();
                        }
                        break;

                    case 'reconnection_failed':
                        if (this.#pendingReconnect) this.#pendingReconnect.reject(new Error("Server rejected reconnection: " + message.reason));
                        break;

                    case 'room_created':
                        if (this.#pendingCreate) {
                            this.#inRoom = true;
                            this.#triggerEvent("status", `Room created.`);
                            this.#crdtManager.importState(message.state);
                            this.#triggerEvent("storageUpdated", this.storage);
                            this.#pendingCreate.resolve(message.roomId);
                        }
                        break;

                    case 'room_creation_failed':
                        if (this.#pendingCreate) {
                            this.#triggerEvent("error", "Failed to create room: " + message.reason);
                            this.#pendingCreate.reject(new Error("Failed to create room: " + message.reason));
                        }
                        break;

                    case 'property_updated':
                        this.#roomVersion++; // Increment room version
                        if (this.#debug) console.log(LOG_PREFIX + "Property update received:", message.update);
                        this.#crdtManager.importPropertyUpdate(message.update);
                        if (this.#crdtManager.didPropertiesChange) this.#triggerEvent("storageUpdated", this.storage);
                        if (this.#roomVersion != message.version && this.#initialized && this.#socket?.readyState === WebSocket.OPEN) {
                            this.#triggerEvent("error", "Detected skipped update – forcing reconnect.");
                            this.#socket?.close();
                        }
                        break;

                    case 'property_update_rejected':
                        this.#triggerEvent("error", "Property update rejected. Re-syncing state.");
                        this.#crdtManager.importState(message.state);
                        this.#triggerEvent("storageUpdated", this.storage);
                        break;

                    case 'kicked':
                        this.#triggerEvent("error", `Kicked out of room: ${message.reason || "No reason provided."}`);
                        this.destroy();
                        break;

                    case 'host_migrated':
                        this.#setHost(message.newHost);
                        break;

                    case 'client_left':
                        this.#connectionCount = message.participantCount - 1; // Counted without the user themselves
                        this.#triggerEvent("clientLeft", message.client);
                        this.#triggerEvent("status", `Client ${message.client} disconnected.`);
                        break;

                    case 'client_joined':
                        this.#connectionCount = message.participantCount - 1; // Counted without the user themselves
                        this.#triggerEvent("clientJoined", message.client);
                        this.#triggerEvent("status", `Client ${message.client} connected.`);
                        break;
                }
            } catch (error) {
                console.error(ERROR_PREFIX + "Error handling message:", error);
            }
        };

        // Handle socket errors
        this.#socket.onerror = () => {
            this.#triggerEvent("error", "WebSocket error.");
            if (this.#pendingConnect) this.#pendingConnect.reject(new Error("WebSocket error"));
        }

        // Handle socket close & attempt reconnect
        this.#socket.onclose = () => {
            if (!this.#initialized || this.#isReconnecting) return;
            this.#triggerEvent("status", "Disconnected.");
            this.#reconnectCount = 0;
            this.#attemptReconnect();
        }
    };

    /**
     * Attempt to reconnect with a fixed number of retries
     * @private
     */
    async #attemptReconnect() {
        this.#reconnectCount++;
        if (this.#reconnectCount > 9) {
            this.#triggerEvent("error", "Disconnected from server.");
            this.destroy();
            return;
        }

        this.#triggerEvent("status", `Attempting to reconnect... (${this.#reconnectCount})`);
        this.#isReconnecting = true;
        try {
            await this.#connect();
            await Promise.race([
                new Promise((resolve, reject) => {
                    this.#pendingReconnect = { resolve, reject };
                    this.#sendToServer({
                        type: 'reconnect',
                        id: this.#id,
                        sessionToken: this.#sessionToken
                    });
                }),
                this.#createTimeout("Reconnection request")
            ]).finally(() => {
                this.#pendingReconnect = null;
            });
        } catch (error) {
            if (!this.#initialized) return;
            this.#triggerEvent("status", "Reconnection failed: " + error.message);
            this.#reconnectTimeout = setTimeout(() => this.#attemptReconnect(), 500);
        }
    }

    /**
     * Update the host in case a new one was chosen
     * @param {string} hostId - Client ID of new host
     * @private
     */
    #setHost(hostId) {
        if (this.#roomHost != hostId) {
            this.#roomHost = hostId;
            this.#triggerEvent("hostMigrated", hostId);
        }
    }

    /**
     * Send a message to the server
     * @param {object} data - The data to send to the server
     * @private
     */
    #sendToServer(data) {
        if (!this.#socket || this.#socket?.readyState !== WebSocket.OPEN) {
            console.warn(WARNING_PREFIX + "Cannot send message - not connected.");
            return;
        }
        try {
            this.#socket.send(encode(data));
        } catch (error) {
            console.error(ERROR_PREFIX + "Error sending message:", error);
            this.#triggerEvent("error", "Error sending message: " + error.message);
        }
    }

    /**
     * Create a new room and become host
     * @param {object} initialStorage - Initial state
     * @param {number} size - Max number of participants
     * @returns {Promise} Resolves with room ID
     */
    async createRoom(initialStorage = {}, size) {
        if (!this.#initialized) {
            this.#triggerEvent("error", "Cannot create room - not initialized");
            return Promise.reject(new Error("Not initialized"));
        }

        return Promise.race([
            new Promise((resolve, reject) => {
                this.#roomHost = this.#id;
                this.#pendingCreate = { resolve, reject };
                this.#sendToServer({
                    type: 'create_room',
                    initialStorage,
                    size
                });
            }),
            this.#createTimeout("Room creation")
        ]).finally(() => {
            this.#pendingCreate = null;
        });
    }

    /**
     * Join an existing room
     * @param {string} roomId - ID of the room
     * @returns {Promise} - Resolves when connected
     */
    async joinRoom(roomId) {
        if (!this.#initialized) {
            this.#triggerEvent("error", "Cannot join room - not initialized");
            return Promise.reject(new Error("Not initialized"));
        }

        return Promise.race([
            new Promise((resolve, reject) => {
                this.#pendingJoin = { resolve, reject };

                // Send connection request
                this.#triggerEvent("status", `Connecting to room ${roomId}...`);
                this.#sendToServer({
                    type: 'join_room',
                    roomId
                });
            }),
            this.#createTimeout("Room join")
        ]).finally(() => {
            this.#pendingJoin = null;
        });
    }

    /**
     * Update a value in the shared storage
     * @param {string} key - Storage key
     * @param {'set' | 'array-add' | 'array-add-unique' | 'array-remove-matching' | 'array-update-matching'} type - Operation type
     * @param {*} value - New value or value to operate on
     * @param {*} updateValue - New value for update-matching
     */
    updateStorage(key, type, value, updateValue) {
        if (!this.#inRoom) {
            this.#triggerEvent("error", "Cannot update storage when not in a room.");
            return;
        };
        if (this.#debug) console.log(LOG_PREFIX + `Property update for key ${key}, operation ${type}, value ${value} and updateValue ${updateValue}.`);
        const propUpdate = this.#crdtManager.updateProperty(key, type, value, updateValue);
        this.#sendToServer({
            type: 'update_property',
            update: propUpdate
        });
        if (this.#crdtManager.didPropertiesChange) this.#triggerEvent("storageUpdated", this.storage); // Always trigger callback AFTER send in case msgs are sent in the callback (which would break the order)
    }

    /**
     * Send a custom request to the server
     * @param {string} name - Name of the request
     * @param {*} [data] - Custom data
     */
    sendRequest(name, data) {
        if (this.#debug) console.log(LOG_PREFIX + `Server request with name ${name} and data:`, data);
        this.#sendToServer({
            type: 'request',
            request: { name, data }
        });
    }

    /**
     * Destroy the PlaySocket instance and disconnect
     */
    destroy() {
        this.#initialized = false; // Set this immediately to prevent automatic reconnection

        if (this.#socket) {
            // Signal to the server that it can immediately remove this user
            if (this.#socket.readyState === WebSocket.OPEN) this.#sendToServer({ type: 'disconnect' });
            this.#socket.close();
            this.#socket.onmessage = null;
            this.#socket.onerror = null;
            this.#socket.onclose = null;
            this.#socket = null;

            // Trigger events
            this.#triggerEvent("status", "Destroyed.");
            this.#triggerEvent("instanceDestroyed");
        }

        // Reset state
        clearTimeout(this.#reconnectTimeout);
        this.#roomHost = null;
        this.#inRoom = false;
        this.#connectionCount = 0;
        this.#isReconnecting = false;
        this.#reconnectCount = 0;
        this.#roomVersion = 0;

        // Reject timeouts if currently active
        if (this.#pendingJoin) this.#pendingJoin.reject();
        if (this.#pendingCreate) this.#pendingCreate.reject();
        if (this.#pendingRegistration) this.#pendingRegistration.reject();
        if (this.#pendingConnect) this.#pendingConnect.reject();
        if (this.#pendingReconnect) this.#pendingReconnect.reject();
    }

    // Public getters
    get connectionCount() { return this.#connectionCount; }
    get storage() { return this.#crdtManager.getPropertyStore; }
    get isHost() { return this.#id == this.#roomHost; }
    get id() { return this.#id; }
}