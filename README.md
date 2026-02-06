# PlaySocket Client

A reactive, optimistic WebSocket library that simplifies game & app development by abstracting away complex sync logic.

## Why use PlaySocket?

PlaySocket eliminates the traditional complexity of collaborative experiences:

- **Streamlined architecture**: No additional backend code is required, but server-authoritative behavior supported
- **State synchronization**: Built-in storage system keeps the full state synchronized across all clients, always conflict-free and in order
- **Resilient & secure connections**: Automatic reconnection handling & strict rate-limiting
- **Lightweight**: Uses WebSockets for efficient, predictable, reliable communication and has little dependencies

## Installation

```bash
npm install playsocketjs
```

## Usage examples

Note that in production, you should **always try...catch** promises, such as socket.init() – they can reject!

Initializing the client:
```javascript
import PlaySocket from 'playsocketjs';

// Create a new instance
const socket = new PlaySocket('unique-client-id', { // You can pass no ID to let the server pick one
    endpoint: 'wss://example.com/socket'
});

// Set up event handlers (optional)
socket.onEvent('status', status => console.log('Status:', status));
socket.onEvent('error', status => console.log('Error:', status));

const clientId = await socket.init(); // Initialize the socket
```

Creating a room:
```javascript
// Create a new room
const roomId = await socket.createRoom();

// Optionally, with initial storage
const roomId = await socket.createRoom({
  players: ["this-player"],
  latestPlayer: null,
});
```

Joining a room:
```javascript
await socket.joinRoom('room-id'); // Join an existing room
```

Leaving a room:
```javascript
socket.destroy(); // To leave the room, destroy the instance
```

Using the storage update event for reactivity:
```javascript
const reactiveVariable = useState(); // Or $state(), reactive(), depending on your framework
socket.onEvent('storageUpdated', storage => (reactiveVariable = storage)); // Assign on update
```

Interfacing with the synchronized storage (examples):
```javascript
const currentState = socket.getStorage; // Synchronous, local access
socket.updateStorage('players', 'array-add-unique', { username: 'Player4', level: 2 }); // Special method to enable conflict-free additions for arrays
socket.updateStorage('latestPlayer', 'set', 'Player4'); // Regular synced storage update
```

Sending traditional requests to the server:
```javascript
socket.sendRequest('chosen-request-name', { fact: "You can build server-authoritative logic using this!" })
```

## API reference

### Constructor

Creates a new PlaySocket instance with a specified ID and configuration options.
The ID can be set to `null` to let the server pick a unique one.

```javascript
new PlaySocket(id?: string, options: PlaySocketOptions)
```

#### Configuration options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `endpoint` | string | `undefined` | WebSocket server endpoint (e.g., 'wss://example.com/socket') (required) |
| `customData` | object | `{}` | Arbitrary data to pass to the "clientRegistered" server event |
| `debug` | boolean | `false` | Set to true to enable extra logging |

### Methods

| Method | Parameters | Return type | Description |
|--------|------------|-------------|-------------|
| `init()` | - | `Promise<string>` | Initialize the WebSocket connection – Returns a promise which resolves with the client's ID |
| `createRoom()` | `initialStorage?: object, size?: number` | `Promise<string>` | Create a new room and become host – Returns a promise which resolves with the room ID. The room participant maximum is 100 |
| `joinRoom()` | `roomId: string` | `Promise<void>` | Join an existing room |
| `destroy()` | - | `void` | Use this to leave a room and close the connection |
| `updateStorage()` | `key: string, type: 'set' \| 'array-add' \| 'array-add-unique' \| 'array-remove-matching' \| 'array-update-matching', value: any, updateValue?: any` | `void` | Update a key in the shared storage (max. 100 keys). Array operation types allow for conflict-free simultaneous array updates. For '-matching' operations, value becomes the value to match, and updateValue the replacement |
| `sendRequest()` | `name: string, data?: any` | `void` | Send requests to the server with optional custom data (handle them in the `requestReceived` server event) |
| `onEvent()` | `event: string, callback: Function` | `void` | Register an event callback |

### Event types

| Event | Callback parameter | Description |
|-------|-------------------|-------------|
| `status` | `status: string` | Connection status updates |
| `error` | `error: string` | Error events |
| `instanceDestroyed` | - | Destruction event - triggered by manual .destroy() method invocation or by fatal errors and disconnects |
| `storageUpdated` | `storage: object` | Storage state changes |
| `hostMigrated` | `roomId: string` | Host changes |
| `clientConnected` | `clientId: string` | New client connected to the room |
| `clientDisconnected` | `clientId: string, roomId?: string` | Client disconnected from the room |

### Properties (Read-only)

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | Client's unique identifier on the WebSocket server |
| `isHost` | boolean | If this user is currently assigned the host role |
| `connectionCount` | number | Number of active client connections in room (without yourself) |
| `getStorage` | object | Retrieve storage object |

&nbsp;

# PlaySocket Server

PlaySocket includes a server implementation that can be set up in seconds.

## Installation

To use the server component, you'll need to install playsocketjs and the ws package:

```bash
npm install playsocketjs ws
```

## Usage examples

Here are usage examples for a standalone server and an Express.js application.

### Standalone server

```javascript
import PlaySocketServer from 'playsocketjs/server'; // Both ES Module & CommonJS Module syntax is supported

const server = new PlaySocketServer(); // Create and start the server (default path is /)

// Gracefully disconnect all clients and close the server (optional)
function shutdown() {
    server.stop();
    process.exit(0);
}

// Handle both SIGINT and SIGTERM
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

### Together with Express.js (or other Backend frameworks)

```javascript
const express = require('express');
const http = require('http');
const PlaySocketServer = require('playsocketjs/server');

const app = express();
const httpServer = http.createServer(app);

// Create PlaySocket server with your HTTP server
const playSocketServer = new PlaySocketServer({
  server: httpServer,
  path: '/socket'
});

// Start the server
httpServer.listen(3000, () => {
  console.log('Server running on port 3000');
});

// Gracefully disconnect all clients and close the server (recommended)
function shutdown() {
    server.stop();
    process.exit(0);
}

// Handle both SIGINT and SIGTERM
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

## API reference

### Constructor

Creates a new PlaySocket Server instance with configuration options.

```javascript
new PlaySocket(options: PlaySocketServerOptions)
```

### Configuration options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | number | 3000 | Port to listen on (used only if no server provided) |
| `path` | string | '/' | WebSocket endpoint path |
| `server` | http.Server | - | Existing http server (optional) |
| `rateLimit` | number | 20 | Adjust the messages/second rate limit |
| `debug` | boolean | false | Set to true to enable extra logging |
| `verifyClient` | function | - | Optional callback to verify connections before WebSocket upgrade |

#### verifyClient callback

The `verifyClient` option allows you to implement custom connection verification logic, such as rate limiting, before the WebSocket handshake completes.

```javascript
const server = new PlaySocketServer({
    server: httpServer,
    path: '/socket',
    verifyClient: (info, callback) => {
        // info.req - the HTTP request object, info.origin - the Origin header value
        const ip = info.req.headers['x-forwarded-for'] || info.req.socket.remoteAddress;
        if (isRateLimited(ip)) return callback(false, 429, 'Too Many Requests');
        callback(true);
    }
});
```

The callback signature is `callback(verified, code?, message?)` where `code` and `message` are the optional HTTP response status for rejected connections.

### Methods

| Method | Parameters | Return type | Description |
|--------|------------|-------------|-------------|
| `stop()` | - | `void` | Closes all active client connections, the websocket server and the underlying http server if it's standalone |
| `kick()` | `clientId: string, reason?: string` | `void` | Kick a client by their clientID – this will close their connection and set an error message |
| `onEvent()` | `event: string, callback: Function` | `void` | Register a server-side event callback |
| `getRoomStorage()` | `roomId: string` | `object` | Get a snapshot of the current room storage |
| `updateRoomStorage()` | `roomId: string, key: string, type: 'set' \| 'array-add' \| 'array-add-unique' \| 'array-remove-matching' \| 'array-update-matching', value: any, updateValue?: any` | `void` | Update a key in the shared room storage from the server |
| `createRoom()` | `initialStorage?: object, size?: number, host?: string` | `object` | Create a room (returns object containing room ID and state)|
| `destroyRoom()` | `roomId: string` | `void` | Destroy a room & kick all participants |

### Event types

| Event | Callback parameters | Description | Return for action |
|-------|-------------------|-------------|--------------|
| `clientRegistered` | `clientId: string, customData: object` | Client registered with the server | - |
| `clientRegistrationRequested` | `clientId: string, customData: object` | Client requests to register | Return `false` or rejection reason `string` to block |
| `clientDisconnected` | `clientId: string` | Client disconnected from the server | - |
| `clientJoinedRoom` | `clientId: string, roomId: string` | Client joined a room (clients can only leave by disconnecting) | - |
| `clientJoinRequested` | `clientId: string, roomId: string` | Client requests to join a room | Return `false` or rejection reason `string` to block |
| `roomCreated` | `roomId: string` | Client created a room | - |
| `roomDestroyed` | `roomId: string` | Room was destroyed (happens when all participants leave, unless room host is "server") | - |
| `roomCreationRequested` | `{clientId: string, initialStorage: object}` | Room creation requested by client | Return `object` to override initial storage, `false` to deny |
| `storageUpdated` | `{clientId: string, roomId: string, update: object, storage: object}` | Room storage property updated | - |
| `storageUpdateRequested` | `{clientId: string, roomId: string, update: object, storage: object}` | Room storage property update requested by client | Return `false` to block the update |
| `requestReceived` | `{clientId: string, roomId?: string, requestName: string, data?: any}` | Request from client was received by the server | - |

### Properties (Read-only)

| Property | Type | Description |
|----------|------|-------------|
| `getRooms` | object | Retrieve the rooms object |

# License

MIT