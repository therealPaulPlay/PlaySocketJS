/**
 * PlaySocket - WebSocket-based multiplayer for games
 */

const ERROR_PREFIX = "PlaySocket error: ";
const WARNING_PREFIX = "PlaySocket warning: ";
const TIMEOUT_MS = 5000; // 5 second timeout for operations

export default class PlaySocket {
    // Core properties
    #id; // Unique client ID
    #sessionToken; // Unique session token
    #endpoint;
    #socket; // WebSocket connection
    #initialized = false; // Initialization status
    #customData;

    // Room properties
    #storage = {}; // Shared storage object
    #roomHost;
    #roomId; // ID of the host (client only)
    #connectionCount = 0;

    // Event handling
    #callbacks = new Map(); // Event callbacks

    // Async server operations
    #pendingJoin;
    #pendingHost;
    #pendingRegistration;
    #pendingConnect;
    #pendingReconnect;

    // Timeouts or intervals
    #reconnectTimeout;
    #reconnectCount = 0;
    #isReconnecting = false;

    /**
     * Create a new PlaySocket instance
     * @param {string} id - Unique identifier for this client
     * @param {object} options - Connection options
     * @param {string} options.endpoint - WebSocket endpoint path
     * @param {object} [options.customData] - Custom registration data
     */
    constructor(id, options = {}) {
        this.#id = id;
        if (options.endpoint) this.#endpoint = options.endpoint;
        if (options.customData) this.#customData = { ...options.customData };
    }

    /**
     * Helper to create timeout promises for create room, join room etc.
     * @private
     */
    #createTimeout(operation) {
        return new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${operation} timed out`)), TIMEOUT_MS)
        );
    }

    /**
     * Register an event callback
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
     */
    onEvent(event, callback) {
        const validEvents = [
            "status", "error", "instanceDestroyed", "storageUpdated", "hostMigrated", "clientConnected", "clientDisconnected"
        ];
        if (!validEvents.includes(event)) return console.warn(WARNING_PREFIX + `Invalid event type "${event}".`);
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
        await Promise.race([
            new Promise(async (resolve, reject) => {
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
                const message = JSON.parse(event.data);
                if (!message.type) return;

                switch (message.type) {
                    case 'join_accepted':
                        // Connected to room
                        if (this.#pendingJoin) {
                            this.#storage = message.storage;
                            this.#connectionCount = message.participantCount - 1; // Counted without the user themselves
                            this.#roomHost = message.host;
                            this.#triggerEvent("status", `Connected to room.`);
                            this.#triggerEvent("storageUpdated", { ...this.#storage });
                            this.#pendingJoin.resolve();
                        }
                        break;

                    case 'join_rejected':
                        // Connection to room failed
                        if (this.#pendingJoin) {
                            this.#triggerEvent("status", "Connection rejected: " + message.reason);
                            this.#pendingJoin.reject(new Error("Connection rejected: " + message.reason));
                        }
                        break;

                    case 'reconnected':
                        // Successfully reconnected
                        if (this.#pendingReconnect) {
                            this.#isReconnecting = false;
                            this.#reconnectCount = 0;
                            if (message.roomData) {
                                this.#storage = message.roomData.storage;
                                this.#connectionCount = message.roomData.participantCount - 1; // Counted without the user themselves
                                this.#setHost(message.roomData.host);
                                this.#triggerEvent("storageUpdated", { ...this.#storage });
                            } else {
                                if (this.#roomId) {
                                    this.#triggerEvent("error", "Reconnected, but room no longer exists.");
                                    return this.destroy();
                                }
                            }
                            this.#triggerEvent("status", "Reconnected.");
                            this.#pendingReconnect.resolve();
                        }
                        break;

                    case 'reconnection_failed':
                        if (this.#pendingReconnect) {
                            this.#triggerEvent("status", `Reconnection failed: ${message.reason}`);
                            this.#pendingReconnect.reject(new Error("Reconnection failed: " + message.reason));
                        }
                        break;

                    case 'room_created':
                        if (this.#pendingHost) {
                            this.#pendingHost.resolve(this.#roomId);
                            this.#triggerEvent("status", `Room created${this.#pendingHost.maxSize ? ` with max size ${this.#pendingHost.maxSize}.` : '.'}`);
                            this.#triggerEvent("storageUpdated", { ...this.#storage });
                        }
                        break;

                    case 'room_creation_failed':
                        if (this.#pendingHost) {
                            this.#pendingHost.reject(new Error("Failed to create room: " + message.reason));
                            this.#triggerEvent("error", "Failed to create room: " + message.reason);
                        }
                        break;

                    case 'id_taken':
                        if (this.#pendingRegistration) {
                            this.#pendingRegistration.reject(new Error("This id is already in use"));
                            this.#triggerEvent("error", "This id is taken.");
                        }
                        break;

                    case 'registered':
                        if (this.#pendingRegistration) {
                            this.#sessionToken = message.sessionToken;
                            this.#initialized = true;
                            this.#pendingRegistration.resolve();
                            this.#triggerEvent("status", "Connected to server.");
                        }
                        break;

                    case 'storage_sync':
                        if (message.key) {
                            if (JSON.stringify(this.#storage[message.key]) !== JSON.stringify(message.value)) {
                                this.#storage[message.key] = message.value;
                                this.#triggerEvent("storageUpdated", { ...this.#storage });
                            }
                        }
                        break;

                    case 'client_disconnected':
                        this.#connectionCount = message.participantCount - 1; // Counted without the user themselves
                        this.#setHost(message.host);

                        this.#triggerEvent("clientDisconnected", message.client);
                        this.#triggerEvent("status", `Client ${message.client} disconnected.`);
                        break;

                    case 'client_connected':
                        this.#connectionCount = message.participantCount - 1; // Counted without the user themselves
                        this.#triggerEvent("clientConnected", message.client);
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
        if (this.#reconnectCount++ >= 3) {
            this.#triggerEvent("error", "Disconnected from server.");
            return this.destroy();
        }

        this.#triggerEvent("status", `Attempting to reconnect... (${this.#reconnectCount})`);
        this.#isReconnecting = true;
        try {
            await this.#connect();
            await Promise.race([
                new Promise(async (resolve, reject) => {
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
            this.#triggerEvent("status", "Reconnection failed: " + error.message);
            this.#reconnectTimeout = setTimeout(() => this.#attemptReconnect(), 500);
        }
    }

    /**
     * Update the host in case a new one was chosen
     * @param {string} hostId - Client id of new host
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
     * @private
     */
    #sendToServer(data) {
        if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
            return console.error(ERROR_PREFIX + "Cannot send message - not connected.");
        }
        try {
            this.#socket.send(JSON.stringify(data));
        } catch (error) {
            console.error(ERROR_PREFIX + "Error sending message:", error);
            this.#triggerEvent("error", "Error sending message: " + error.message);
        }
    }

    /**
     * Create a new room and become host
     * @param {object} initialStorage - Initial state
     * @param {number} maxSize - Max number of participants
     * @returns {Promise} Resolves with room ID
     */
    async createRoom(initialStorage = {}, maxSize) {
        if (!this.#initialized) {
            this.#triggerEvent("error", "Cannot create room - not initialized");
            return Promise.reject(new Error("Not initialized"));
        }

        return Promise.race([
            new Promise((resolve, reject) => {
                this.#storage = initialStorage;
                this.#roomId = this.#id; // Create room with your own ID as the room ID to mimic p2p
                this.#roomHost = this.#id;
                this.#pendingHost = { maxSize, resolve, reject };

                this.#sendToServer({
                    type: 'create_room',
                    storage: { ...initialStorage },
                    size: maxSize,
                    from: this.#id,
                });
            }),
            this.#createTimeout("Room creation")
        ]).finally(() => {
            this.#pendingHost = null;
        });
    }

    /**
     * Join an existing room
     * @param {string} roomId - ID of the room
     * @returns {Promise} Resolves when connected
     */
    async joinRoom(roomId) {
        if (!this.#initialized) {
            this.#triggerEvent("error", "Cannot join room - not initialized");
            return Promise.reject(new Error("Not initialized"));
        }

        return Promise.race([
            new Promise((resolve, reject) => {
                this.#roomId = roomId;
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
     * @param {*} value - New value
     */
    updateStorage(key, value) {
        if (JSON.stringify(this.#storage[key]) === JSON.stringify(value)) return; // Prevent updates without changes
        this.#sendToServer({
            type: 'room_storage_update',
            key,
            value
        });
        // Optimistic update
        this.#storage[key] = value;
        this.#triggerEvent("storageUpdated", { ...this.#storage });
    }

    /**
     * Update an array in storage with special operations
     * @param {string} key - Storage key
     * @param {string} operation - Operation type: add, add-unique, remove-matching, update-matching
     * @param {*} value - Value to operate on
     * @param {*} updateValue - New value for update-matching
     */
    updateStorageArray(key, operation, value, updateValue) {
        const updatedArray = this.#handleArrayUpdate(key, operation, value, updateValue);
        if (JSON.stringify(this.#storage[key]) === JSON.stringify(updatedArray)) return; // Prevent updates without changes
        this.#sendToServer({
            type: 'room_storage_array_update',
            key,
            operation,
            value,
            updateValue
        });
        // Optimistic update
        this.#storage[key] = updatedArray;
        this.#triggerEvent("storageUpdated", { ...this.#storage });
    }

    /**
     * Handle array operations client-side
     * @private
     */
    #handleArrayUpdate(key, operation, value, updateValue) {
        let array = (!this.#storage[key] || !Array.isArray(this.#storage[key])) ? [] : [...this.#storage[key]];
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

            default:
                console.error(ERROR_PREFIX + `Unknown array operation: ${operation}`);
        }

        return array;
    }

    /**
     * Destroy the PlaySocket instance and disconnect
     */
    destroy() {
        this.#initialized = false; // Set this immediately to prevent automatic reconnection

        if (this.#socket) {
            // Signal to the server that it can immediately disconnect this user
            if (this.#socket.readyState === WebSocket.OPEN) this.#sendToServer({ type: 'disconnect' });
            this.#socket.close();
            this.#socket = null;

            // Trigger events
            this.#triggerEvent("status", "Destroyed.");
            this.#triggerEvent("instanceDestroyed");
        }

        // Reset state
        clearTimeout(this.#reconnectTimeout);
        this.#roomHost = null;
        this.#storage = {};
        this.#roomId = null;
        this.#connectionCount = 0;
        this.#isReconnecting = false;
        this.#reconnectCount = 0;
    }

    // Public getters
    get connectionCount() { return this.#connectionCount; }
    get getStorage() { return JSON.parse(JSON.stringify(this.#storage)); }
    get isHost() { return this.#id == this.#roomHost; }
    get id() { return this.#id; }
}