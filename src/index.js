/**
 * PlaySocket - WebSocket-based multiplayer for games
 */

const ERROR_PREFIX = "PlaySocket error: ";
const WARNING_PREFIX = "PlaySocket warning: ";

export default class PlaySocket {
    // Core properties
    #id; // Unique peer ID
    #endpoint = "wss://example.com/socket"; // Default endpoint
    #socket; // WebSocket connection
    #initialized = false; // Initialization status

    // Room properties
    #storage = {}; // Shared storage object
    #isHost = false; // Whether this peer is host
    #roomHost;
    #roomId; // ID of the host (client only)
    #connectionCount = 0;

    // Event handling
    #callbacks = new Map(); // Event callbacks

    // Async server operations
    #pendingJoin;
    #pendingHost;
    #pendingInit;

    /**
     * Create a new PlaySocket instance
     * @param {string} id - Unique identifier for this peer
     * @param {object} options - Connection options
     */
    constructor(id, options = {}) {
        this.#id = id;
        if (options.endpoint) this.#endpoint = options.endpoint;
    }

    /**
     * Register an event callback
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
     */
    onEvent(event, callback) {
        const validEvents = [
            "status", "error", "instanceDestroyed", "storageUpdated", "hostMigrated", "clientConnected", "clientDisconnected",
        ];
        if (!validEvents.includes(event)) return console.warn(WARNING_PREFIX + `Invalid event type "${event}."`);
        if (!this.#callbacks.has(event)) this.#callbacks.set(event, []);
        this.#callbacks.get(event).push(callback);
    }

    /**
     * Trigger an event to registered callbacks
     * @private
     */
    #triggerEvent(event, ...args) {
        const callbacks = this.#callbacks.get(event);
        if (!callbacks || callbacks.length === 0) return;
        callbacks.forEach(callback => {
            try {
                callback(...args);
            } catch (error) {
                console.error(ERROR_PREFIX + `${event} callback error:`, error);
            }
        });
    }

    /**
     * Initialize the PlaySocket instance by connecting to the WS server
     * @returns {Promise} Resolves when connected to server
     */
    async init() {
        return new Promise(async (resolve, reject) => {
            if (this.#initialized) return reject(new Error("Already initialized."));
            this.#triggerEvent("status", "Initializing...");
            await this.connect();
            resolve();
        });
    }

    async connect() {
        return new Promise((resolve, reject) => {
            this.#socket = new WebSocket(this.#endpoint);
            this.#setupSocketHandlers(); // Message & close events

            // Resolve or reject depending on answer to registration msg
            this.#pendingInit = {
                resolve: resolve,
                reject: reject
            }

            // Register with server
            this.#socket.onopen = () => {
                this.#initialized = true;
                this.#sendToServer({
                    type: 'register',
                    id: this.#id
                });
            };
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
                    case 'connection_accepted':
                        // Connected to room
                        if (this.#pendingJoin) {
                            this.#storage = message.storage;
                            this.#connectionCount = message.participantCount - 1;
                            this.#triggerEvent("status", `Connected to room.`);
                            this.#triggerEvent("storageUpdated", { ...this.#storage });
                            this.#pendingJoin.resolve();
                            this.#pendingJoin = null;
                        }
                        break;

                    case 'connection_rejected':
                        // Connection to room faiiled
                        if (this.#pendingJoin) {
                            this.#triggerEvent("outgoingPeerError", this.#roomId);
                            this.#triggerEvent("status", `Connection rejected: ${message.reason || 'Unknown reason'}`);
                            this.#pendingJoin.reject(new Error("Connection rejected."));
                            this.#pendingJoin = null;
                        }
                        break;

                    case 'room_created':
                        if (this.#pendingHost) {
                            this.#pendingHost.resolve();
                            this.#triggerEvent("status", `Room created${this.#pendingHost.maxSize ? ` with max size ${this.#pendingHost.maxSize}` : ''}`);
                            this.#triggerEvent("storageUpdated", { ...this.#storage });
                            this.#pendingHost = null;
                        }
                        break;

                    case 'room_taken':
                        if (this.#pendingHost) {
                            this.#pendingHost.reject(new Error("Room with this id exists."));
                            this.#triggerEvent("error", "Room with this id is taken.");
                            this.#pendingHost = null;
                        }
                        break;

                    case 'id_taken':
                        if (this.#pendingInit) {
                            this.#pendingInit.reject(new Error("This id is already being used."));
                            this.#triggerEvent("error", "This id is taken.");
                            this.#pendingInit = null;
                        }
                        break;
                    case 'registered':
                        if (this.#pendingInit) {
                            this.#pendingInit.resolve();
                            this.#triggerEvent("status", "Connected to server.");
                            this.#pendingInit = null;
                        }
                        break

                    case 'storage_sync':
                        if (message.storage && JSON.stringify(this.#storage) !== JSON.stringify(message.storage)) {
                            this.#storage = message.storage;
                            this.#triggerEvent("storageUpdated", { ...this.#storage });
                        }
                        break;

                    case 'client_disconnected':
                        this.#isHost = this.#id == message.updatedHost;
                        this.#connectionCount = message.participantCount - 1; // Counted without the user themselves

                        // If host has changed...
                        if (this.#roomHost != message.updatedHost) {
                            this.#roomHost = message.updatedHost;
                            this.#triggerEvent("hostMigrated", this.#roomHost);
                        }

                        this.#triggerEvent("clientDisconnected", message.client);
                        this.#triggerEvent("status", `Client ${message.client} disconnected.`);
                        break;

                    case 'client_connected':
                        this.#connectionCount = message.participantCount - 1;
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
            if (this.#pendingInit) this.#pendingInit.reject(new Error("WebSocket error."));
        }

        // Handle socket close & attempt reconnect
        this.#socket.onclose = () => {
            this.#triggerEvent("status", "Disconnected, attempting reconnect...");

            setTimeout(async () => {
                if (!this.#initialized || !this.#socket) return;
                try {
                    await this.connect(); // Will set status to connected if successful

                    // Rejoin room if needed
                    if (this.#roomId) {
                        this.#triggerEvent("status", "Rejoining room...");
                        await this.joinRoom(this.#roomId); // If this fails, it will be caught by the outer catch
                    }
                } catch (error) {
                    this.#triggerEvent("error", "WebSocket connection closed: " + error);
                    this.#socket = null;
                    this.destroy();
                }
            }, 1000);
        }
    };

    /**
     * Send a message to the server
     * @private
     */
    #sendToServer(data) {
        if (!this.#initialized || !this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
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
     * @param {number} maxSize - Max number of peers
     * @returns {Promise} Resolves with room ID
     */
    createRoom(initialStorage = {}, maxSize) {
        return new Promise((resolve, reject) => {
            if (!this.#initialized) {
                this.#triggerEvent("error", "Cannot create room - not initialized");
                return reject(new Error("Not initialized"));
            }

            this.#isHost = true;
            this.#storage = initialStorage;
            this.#roomId = this.#id; // Create room with your own ID as the room ID to mimic p2p
            this.#roomHost = this.#id;
            this.#pendingHost = {
                maxSize,
                resolve: resolve,
                reject: reject
            };

            this.#sendToServer({
                type: 'create_room',
                storage: initialStorage,
                size: maxSize,
                from: this.#id,
            });
        });
    }

    /**
     * Join an existing room
     * @param {string} roomId - ID of the room
     * @returns {Promise} Resolves when connected
     */
    joinRoom(roomId) {
        return new Promise((resolve, reject) => {
            if (!this.#initialized) {
                this.#triggerEvent("error", "Cannot join room - not initialized");
                return reject(new Error("Not initialized"));
            }

            this.#isHost = false;
            this.#roomId = roomId;
            this.#roomHost = roomId;
            this.#pendingJoin = {
                resolve: resolve,
                reject: reject
            };

            // Send connection request
            this.#triggerEvent("status", `Connecting to room ${roomId}...`);
            this.#sendToServer({
                type: 'join_room',
                roomId
            });
        });
    }

    /**
     * Update a value in the shared storage
     * @param {string} key - Storage key
     * @param {*} value - New value
     */
    updateStorage(key, value) {
        if (JSON.stringify(this.#storage[key]) === JSON.stringify(value)) return;
        this.#storage[key] = value;
        this.#triggerEvent("storageUpdated", { ...this.#storage });
        this.#sendToServer({
            type: 'room_storage_update',
            roomId: this.#roomId,
            key,
            value
        })
    }

    /**
     * Update an array in storage with special operations
     * @param {string} key - Storage key
     * @param {string} operation - Operation type: add, add-unique, remove-matching, update-matching
     * @param {*} value - Value to operate on
     * @param {*} updateValue - New value for update-matching
     */
    updateStorageArray(key, operation, value, updateValue) {
        this.#sendToServer({
            type: 'room_storage_array_update',
            roomId: this.#roomId,
            key,
            operation,
            value,
            updateValue
        });
        this.#handleArrayUpdate(key, operation, value, updateValue);
    }

    /**
     * Handle array operations
     * @private
     */
    #handleArrayUpdate(key, operation, value, updateValue) {
        if (!this.#storage[key] || !Array.isArray(this.#storage[key])) this.#storage[key] = [];
        let array = this.#storage[key];

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
                this.#storage[key] = array.filter(item => !compare(item));
                break;

            case 'update-matching':
                const index = array.findIndex(compare);
                if (index !== -1) array[index] = updateValue;
                break;

            default:
                console.error(ERROR_PREFIX + `Unknown array operation: ${operation}`);
                return;
        }

        this.#triggerEvent("storageUpdated", { ...this.#storage });
    }

    /**
     * Destroy the PlaySocket instance and disconnect
     */
    destroy() {
        if (this.#socket) {
            this.#socket.close();
            this.#socket = null;
        }

        // Reset state
        this.#initialized = false;
        this.#isHost = false;
        this.#roomHost = null;
        this.#storage = {};
        this.#roomId = null;
        this.#connectionCount = 0;

        this.#triggerEvent("status", "Destroyed.");
        this.#triggerEvent("instanceDestroyed");
    }

    // Public getters
    get connectionCount() { return this.#connectionCount }
    get getStorage() { return { ...this.#storage }; }
    get isHost() { return this.#isHost; }
    get id() { return this.#id; }
}