/**
 * PlaySocket Client - WebSocket-based multiplayer for games
 */

import { decode, encode } from '@msgpack/msgpack';
import CRDTManager, { type Operation, type PropertyUpdateData, type State } from './crdtManager.ts';

const ERROR_PREFIX = 'PlaySocket error: ';
const WARNING_PREFIX = 'PlaySocket warning: ';
const LOG_PREFIX = 'PlaySocket log: ';
const TIMEOUT_MS = 3000; // 3 second timeout for WS messages

type EventCallbacks<T extends Record<string, unknown>> = {
	status: (status: string) => void;
	error: (error: Error) => void;
	instanceDestroyed: () => void;
	storageUpdated: (storage: T) => void;
	hostMigrated: (newHostId: string) => void;
	clientConnected: (clientId: string) => void;
	clientDisconnected: (clientId: string) => void;
};

type Message<T extends Record<string, unknown>> = {
	type: string;
	size: number;
	reason?: string;
	id?: string;
	sessionToken: string;
	state: State<T>;
	participantCount: number;
	host: string;
	version: number;
	roomId?: string;
	update: PropertyUpdateData<T>;
	roomData?: { state: State<T>; version: number; participantCount: number; host: string };
	newHost: string;
	client?: string;
};
type ClientConstructorOptions<T> = {
	endpoint: string;
	customData?: T;
	debug?: boolean;
};

export default class PlaySocket<T extends Record<string, unknown>> {
	// Core properties
	#id; // Unique client ID
	#sessionToken: string | undefined; // Unique session token
	#endpoint;
	#socket: WebSocket | undefined; // WebSocket connection
	#initialized = false; // Initialization status
	#customData: T;

	// Room properties
	#roomHost: string | undefined;
	#inRoom: boolean | undefined; // If the client is currently in a room or not
	#connectionCount = 0;
	#crdtManager;
	#roomVersion = 0; // Update version (used to compare local vs. remote state to detect package loss)

	// Event handling
	#callbacks = new Map<keyof EventCallbacks<T>, Function[]>(); // Event callbacks

	// Async server operations
	#pendingJoin: { resolve: (value?: unknown) => void; reject: (error?: Error) => void } | undefined;
	#pendingCreate: { resolve: (roomId?: string) => void; reject: (error?: Error) => void } | undefined;
	#pendingRegistration: { resolve: (id?: string) => void; reject: (error?: Error) => void } | undefined;
	#pendingConnect: { reject: (error?: Error) => void } | null = null;
	#pendingReconnect: { resolve: (value?: unknown) => void; reject: (error?: Error) => void } | undefined;

	// Timeouts or intervals
	#reconnectTimeout: ReturnType<typeof setTimeout> | undefined;
	#reconnectCount = 0;
	#isReconnecting = false;

	// Debug
	#debug;

	/**
	 * Create a new PlaySocket instance
	 * @param id - Unique identifier for this client
	 * @param [options.customData] - Custom registration data
	 */
	constructor(id: string, options: ClientConstructorOptions<T>) {
		const { endpoint, customData = {} as T, debug } = options;
		this.#id = id;
		this.#endpoint = endpoint ?? '/';
		this.#customData = { ...customData };
		this.#debug = debug ?? false; // Enabling extra logging
		this.#crdtManager = new CRDTManager<T>(this.#debug);
	}

	/**
	 * Helper to create timeout promises for create room, join room etc.
	 */
	#createTimeout(operation: string) {
		return new Promise((_, reject) => setTimeout(() => reject(new Error(`${operation} timed out`)), TIMEOUT_MS));
	}

	/**
	 * Register an event callback
	 * @param event - Event name
	 */
	onEvent<K extends keyof EventCallbacks<T>>(event: K, callback: EventCallbacks<T>[K]): void {
		const validEvents = ['status', 'error', 'instanceDestroyed', 'storageUpdated', 'hostMigrated', 'clientConnected', 'clientDisconnected'];
		if (!validEvents.includes(event)) return console.warn(WARNING_PREFIX + `Invalid event type "${event}".`);
		if (!this.#callbacks.has(event)) this.#callbacks.set(event, []);
		this.#callbacks.get(event)!.push(callback);
	}

	/**
	 * Trigger an event to registered callbacks
	 */
	#triggerEvent<K extends keyof EventCallbacks<T>>(event: K, ...args: Parameters<EventCallbacks<T>[K]>) {
		const callbacks = this.#callbacks.get(event);
		callbacks?.forEach((callback) => {
			try {
				callback(...args);
			} catch (error) {
				console.error(ERROR_PREFIX + `${event} callback error:`, error);
			}
		});
	}

	/**
	 * Initialize the PlaySocket instance by connecting to the WS server
	 * @returns Resolves when connection is established
	 */
	async init(): Promise<string> {
		if (this.#initialized) return Promise.reject(new Error('Already initialized'));
		if (!this.#endpoint) return Promise.reject(new Error('No websocket endpoint provided'));
		this.#triggerEvent('status', 'Initializing...');

		// Connect to WS server
		await this.#connect();

		// Register with server
		const id = await Promise.race([
			new Promise<string | undefined>((resolve, reject) => {
				this.#pendingRegistration = { resolve: resolve, reject }; // Resolve or reject depending on answer to registration msg

				// Register with server
				this.#sendToServer({
					type: 'register',
					id: this.#id,
					customData: this.#customData ?? undefined
				});
			}),
			this.#createTimeout('Registration')
		]).finally(() => {
			this.#pendingRegistration = undefined;
		}) as string | undefined;

		// If the server sent out an id, store and return that
		if (id) this.#id = id;
		return this.#id;
	}

	/**
	 * Connect to the WS server and
	 * @returns Resolves when the connection was established
	 */
	async #connect() {
		try {
			return await Promise.race([
				new Promise((resolve, reject) => {
					this.#pendingConnect = { reject };
					this.#socket = new WebSocket(this.#endpoint);
					this.#socket.binaryType = 'arraybuffer'; // Important for MessagePack binary data
					this.#setupSocketHandlers(); // Message & close events
					this.#socket.onopen = resolve;
				}),
				this.#createTimeout('Connection attempt')
			]);
		} finally {
			this.#pendingConnect = null;
		}
	}

	/**
	 * Set up WebSocket message & close handlers
	 */
	#setupSocketHandlers() {
		this.#socket!.onmessage = (event: MessageEvent) => {
			try {
				const message = decode(new Uint8Array(event.data)) as Message<T>;
				if (!message.type) return;

				switch (message.type) {
					case 'registration_failed':
						if (this.#pendingRegistration) {
							this.#pendingRegistration.reject(new Error('Failed to register: ' + message.reason));
							this.#triggerEvent('error', new Error('Failed to register: ' + message.reason));
						}
						break;

					case 'registered':
						if (this.#pendingRegistration) {
							this.#sessionToken = message.sessionToken;
							this.#initialized = true;
							this.#pendingRegistration.resolve(message.id);
							this.#triggerEvent('status', 'Connected to server.');
						}
						break;

					case 'join_accepted':
						// Connected to room
						if (this.#pendingJoin) {
							if (this.#debug) console.log(LOG_PREFIX + 'State received for join:', message.state);
							this.#inRoom = true;
							this.#crdtManager.importState(message.state);
							this.#connectionCount = message.participantCount - 1; // Counted without the user themselves
							this.#roomHost = message.host;
							this.#roomVersion = message.version;
							this.#triggerEvent('storageUpdated', this.getStorage);
							this.#triggerEvent('status', `Connected to room.`);
							this.#pendingJoin.resolve();
						}
						break;

					case 'join_rejected':
						// Connection to room failed
						if (this.#pendingJoin) {
							this.#triggerEvent('status', 'Failed to join room: ' + message.reason);
							this.#pendingJoin.reject(new Error('Failed to join room: ' + message.reason));
						}
						break;

					case 'reconnected':
						// Successfully reconnected
						if (this.#pendingReconnect) {
							this.#isReconnecting = false;
							this.#reconnectCount = 0;
							if (message.roomData) {
								if (this.#debug) {
									console.log(LOG_PREFIX + 'State received for reconnect:', message.roomData.state);
								}
								this.#crdtManager.importState(message.roomData.state);
								this.#roomVersion = message.roomData.version;
								this.#connectionCount = message.roomData.participantCount - 1; // Counted without the user themselves
								this.#setHost(message.roomData.host); // Set host before in case there are .isHost checks in the storageUpdate fallback
								this.#triggerEvent('storageUpdated', this.getStorage);
							} else if (this.#inRoom) {
								// If no room data received, but client thinks they were in a room...
								this.#triggerEvent('error', new Error('Reconnected, but room no longer exists.'));
								return this.destroy();
							}
							this.#triggerEvent('status', 'Reconnected.');
							this.#pendingReconnect.resolve();
						}
						break;

					case 'reconnection_failed':
						if (this.#pendingReconnect) {
							this.#pendingReconnect.reject(new Error('Server rejected reconnection: ' + message.reason));
						}
						break;

					case 'room_created':
						if (this.#pendingCreate) {
							this.#inRoom = true;
							this.#triggerEvent('status', `Room created with max. size ${message.size}.`);
							this.#crdtManager.importState(message.state);
							this.#triggerEvent('storageUpdated', this.getStorage);
							this.#pendingCreate.resolve(message.roomId);
						}
						break;

					case 'room_creation_failed':
						if (this.#pendingCreate) {
							this.#triggerEvent('error', new Error('Failed to create room: ' + message.reason));
							this.#pendingCreate.reject(new Error('Failed to create room: ' + message.reason));
						}
						break;

					case 'property_updated':
						this.#roomVersion++; // Increment room version
						if (this.#debug) console.log(LOG_PREFIX + 'Property update received:', message.update);
						this.#crdtManager.importPropertyUpdate(message.update);
						if (this.#crdtManager.didPropertiesChange) {
							this.#triggerEvent('storageUpdated', this.getStorage);
						}
						if (
							this.#roomVersion != message.version && this.#initialized &&
							this.#socket?.readyState === WebSocket.OPEN
						) {
							this.#triggerEvent('error', new Error('Detected skipped update – forcing reconnect.'));
							this.#socket?.close();
						}
						break;

					case 'property_update_rejected':
						this.#triggerEvent('error', new Error('Property update rejected. Re-syncing state.'));
						this.#crdtManager.importState(message.state);
						this.#triggerEvent('storageUpdated', this.getStorage);
						break;

					case 'server_stopped':
						this.#triggerEvent('error', new Error('Server restart.'));
						this.destroy();
						break;

					case 'kicked':
						this.#triggerEvent(
							'error',
							new Error(`Kicked out of room: ${message.reason ?? 'No reason provided.'}`)
						);
						this.destroy();
						break;

					case 'host_migrated':
						this.#setHost(message.newHost);
						break;

					case 'client_disconnected':
						this.#connectionCount = message.participantCount - 1; // Counted without the user themselves
						this.#triggerEvent('clientDisconnected', message.client!);
						this.#triggerEvent('status', `Client ${message.client} disconnected.`);
						break;

					case 'client_connected':
						this.#connectionCount = message.participantCount - 1; // Counted without the user themselves
						this.#triggerEvent('clientConnected', message.client!);
						this.#triggerEvent('status', `Client ${message.client} connected.`);
						break;
				}
			} catch (error) {
				console.error(ERROR_PREFIX + 'Error handling message:', error);
			}
		};

		// Handle socket errors
		this.#socket!.onerror = () => {
			this.#triggerEvent('error', new Error('WebSocket error.'));
			if (this.#pendingConnect) this.#pendingConnect.reject(new Error('WebSocket error'));
		};

		// Handle socket close & attempt reconnect
		this.#socket!.onclose = () => {
			if (!this.#initialized || this.#isReconnecting) return;
			this.#triggerEvent('status', 'Disconnected.');
			this.#reconnectCount = 0;
			this.#attemptReconnect();
		};
	}

	/**
	 * Attempt to reconnect with a fixed number of retries
	 */
	async #attemptReconnect() {
		this.#reconnectCount++;
		if (this.#reconnectCount > 9) {
			this.#triggerEvent('error', new Error('Disconnected from server.'));
			return this.destroy();
		}

		this.#triggerEvent('status', `Attempting to reconnect... (${this.#reconnectCount})`);
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
				this.#createTimeout('Reconnection request')
			]).finally(() => {
				this.#pendingReconnect = undefined;
			});
			// deno-lint-ignore no-explicit-any
		} catch (error: any) {
			if (!this.#initialized) return;
			if (!('message' in error)) {
				throw error;
			}
			this.#triggerEvent('status', 'Reconnection failed: ' + error.message);
			this.#reconnectTimeout = setTimeout(() => this.#attemptReconnect(), 500);
		}
	}

	/**
	 * Update the host in case a new one was chosen
	 * @param hostId - ID of new host
	 */
	#setHost(hostId: string) {
		if (this.#roomHost != hostId) {
			this.#roomHost = hostId;
			this.#triggerEvent('hostMigrated', hostId);
		}
	}

	/**
	 * Send a message to the server
	 */
	#sendToServer(data: unknown) {
		if (!this.#socket || this.#socket?.readyState !== WebSocket.OPEN) {
			return console.warn(WARNING_PREFIX + 'Cannot send message - not connected.');
		}
		try {
			this.#socket.send(encode(data));
			// deno-lint-ignore no-explicit-any
		} catch (error: any) {
			console.error(ERROR_PREFIX + 'Error sending message:', error);
			this.#triggerEvent('error', new Error('Error sending message: ' + error.message));
		}
	}

	/**
	 * Create a new room and become host
	 * @param initialStorage - Initial state
	 * @param maxSize - Max number of participants
	 * @returns Resolves with room ID
	 */
	createRoom(initialStorage: T | undefined = {} as T, maxSize: number): Promise<string> {
		if (!this.#initialized) {
			this.#triggerEvent('error', new Error('Cannot create room - not initialized'));
			return Promise.reject(new Error('Not initialized'));
		}

		return Promise.race([
			new Promise((resolve, reject) => {
				this.#roomHost = this.#id;
				this.#pendingCreate = { resolve, reject };
				this.#sendToServer({
					type: 'create_room',
					initialStorage,
					size: maxSize
				});
			}),
			this.#createTimeout('Room creation')
		]).finally(() => {
			this.#pendingCreate = undefined;
		}) as Promise<string>;
	}

	/**
	 * Join an existing room
	 * @param - ID of the room
	 * @returns Resolves when connected
	 */
	async joinRoom(roomId: string): Promise<unknown> {
		if (!this.#initialized) {
			this.#triggerEvent('error', new Error('Cannot join room - not initialized'));
			return Promise.reject(new Error('Not initialized'));
		}

		try {
			return await Promise.race([
				new Promise((resolve, reject) => {
					this.#pendingJoin = { resolve, reject };

					// Send connection request
					this.#triggerEvent('status', `Connecting to room ${roomId}...`);
					this.#sendToServer({
						type: 'join_room',
						roomId
					});
				}),
				this.#createTimeout('Room join')
			]);
		} finally {
			this.#pendingJoin = undefined;
		}
	}

	/**
	 * Update a value in the shared storage
	 * @param key - Storage key
	 * @param type - Operation type
	 * @param value - New value or value to operate on
	 * @param updateValue - New value for update-matching
	 */
	updateStorage<K extends KeysWhereValueIsArray<T>, V extends Extract<T[K], unknown[]>, Op extends Operation['data']['type']>(
		key: Op extends 'set' ? keyof T : K,
		type: Op,
		value: Op extends 'set' ? T : V[number],
		updateValue?: unknown
	): void {
		if (!this.#inRoom) return this.#triggerEvent('error', new Error('Cannot update storage when not in a room.'));
		if (this.#debug) {
			console.log(
				LOG_PREFIX +
					`Property update for key ${String(key)}, operation ${type}, value ${value} and updateValue ${updateValue}.`
			);
		}
		const propUpdate = this.#crdtManager.updateProperty(key, type, value, updateValue);
		this.#sendToServer({
			type: 'update_property',
			update: propUpdate
		});
		if (this.#crdtManager.didPropertiesChange) this.#triggerEvent('storageUpdated', this.getStorage); // Always trigger callback AFTER send in case msgs are sent in the callback (which would break the order)
	}

	/**
	 * Send a custom request to the server
	 * @param name - Name of the request
	 * @param {unknown} [data] - Custom data
	 */
	sendRequest(name: string, data?: unknown): void {
		if (this.#debug) console.log(LOG_PREFIX + `Server request with name ${name} and data:`, data);
		this.#sendToServer({
			type: 'request',
			request: { name, data }
		});
	}

	/**
	 * Destroy the PlaySocket instance and disconnect
	 */
	destroy(): void {
		this.#initialized = false; // Set this immediately to prevent automatic reconnection

		if (this.#socket) {
			// Signal to the server that it can immediately remove this user
			if (this.#socket.readyState === WebSocket.OPEN) this.#sendToServer({ type: 'disconnect' });
			this.#socket.close();
			this.#socket.onmessage = null;
			this.#socket.onerror = null;
			this.#socket.onclose = null;
			this.#socket = undefined;

			// Trigger events
			this.#triggerEvent('status', 'Destroyed.');
			this.#triggerEvent('instanceDestroyed');
		}

		// Reset state
		clearTimeout(this.#reconnectTimeout);
		this.#roomHost = undefined;
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
	get connectionCount(): number {
		return this.#connectionCount;
	}
	get getStorage(): T {
		return this.#crdtManager.getPropertyStore;
	}
	get isHost(): boolean {
		return this.#id == this.#roomHost;
	}
	get id(): string {
		return this.#id;
	}
}

type KeysWhereValueIsArray<T> = {
	[K in keyof T]: T[K] extends unknown[] ? K : never;
}[keyof T];
