# PlaySocket Client

A reactive, optimistic WebSocket library that simplifies game & app development by abstracting away complex sync logic.

## Why use PlaySocket?

PlaySocket eliminates the traditional complexity of collaborative experiences:

- **Streamlined architecture**: No additional backend code is required, but server-authoritative behavior supported
- **State synchronization**: Built-in storage system keeps the full state synchronized across all clients, always conflict-free and in order
- **Resilient & secure connections**: Automatic reconnection handling & strict rate-limiting
- **Lightweight**: Uses WebSockets for efficient, predictable, reliable communication and has little dependencies

## Installation

```bash
npm install playsocketjs
```

## Usage examples

Note that in production, you should **always try...catch** promises, such as socket.init() – they can reject!

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

## API Reference

### Constructor

Creates a new PlaySocket instance with a specified ID and configuration options.
The ID can be set to `null` to let the server pick a unique one.

```javascript
new PlaySocket(id?: string, options: PlaySocketOptions)
```

#### Configuration options
- `endpoint`: WebSocket server endpoint (e.g., 'wss://example.com/socket')
- `customData`: You can pass arbitrary data to the "clientRegistered" server event (optional)
- `debug`: Set this property to true to enable extra logging

### Methods

- `init()`: Initialize the WebSocket connection – Returns Promise (async) which resolves with the client's ID
- `createRoom(initialStorage?: object, maxSize?: number)`: Create a new room and become host – Returns Promise (async) which resolves with the room ID (matches the creator's ID). The absolute client maximum is 100
- `joinRoom(hostId: string)`: Join an existing room – Returns Promise (async)
- `destroy()`: Use this to leave a room and close the connection
- `updateStorage(key: string, type: 'set' | 'array-add' | 'array-add-unique' | 'array-remove-matching' | 'array-update-matching', value: any, updateValue?: any)`: Update the shared storage (max. 100 keys). Safely update arrays in storage by adding, removing, or updating items. UpdateValue is only required for the 'array-update-matching' operation type
- `sendRequest(name: string, data?: any)`: Send requests to the server with optional custom data (handle these in the `requestReceived` server event)
- `onEvent(event: string, callback: Function)`: Register an event callback

#### Event types

- `status`: Connection status updates (returns status `string`)
- `error`: Error events (returns error `string`)
- `instanceDestroyed`: Destruction event - triggered by manual .destroy() method invocation or by fatal errors and disconnects
- `storageUpdated`: Storage state changes (returns storage `object`)
- `hostMigrated`: Host changes (returns the new host's ID `string`)
- `clientConnected`: New client connected to the room (returns client's ID `string`)
- `clientDisconnected`: Client disconnected from the room (returns client's ID `string`, room ID (if available) `string`)

### Properties (Read-only)

- `id`: Client's unique identifier on the WebSocket server
- `isHost`: If this user is currently assigned the host role
- `connectionCount`: Number of active client connections in room (without yourself)
- `getStorage`: Retrieve storage object

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
const PlaySocketServer = require('playsocketjs/server');

const server = new PlaySocketServer(); // Create and start the server (default path is /socket)

// Gracefully disconnect all clients and close the server (optional)
function shutdown() {
    server.stop();
    process.exit(0);
}

// Handle both SIGINT (Ctrl+C) and SIGTERM (Docker stop)
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

// Handle both SIGINT (Ctrl+C) and SIGTERM (Docker stop)
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

## API Reference

### Constructor

```javascript
new PlaySocket(options: PlaySocketServerOptions)
```

Creates a new PlaySocket Server instance with configuration options.

### Configuration options

- `port`: Port to listen on (default: 3000, used only if no server provided)
- `path`: WebSocket endpoint path (default: '/')
- `server`: Existing http server (optional)
- `debug`: Set this property to true to enable extra logging

### Methods

- `stop`: Closes all active client connections, the websocket server and the underlying http server if it's standalone
- `kick(clientId: string, reason?: string)`: Kick a client by their clientID – this will close their connection and set an error message
- `onEvent(event: string, callback: Function)`: Register a server-side event callback
- `getRoomStorage(roomId: string)`: Get a snapshot of the current room storage (returns storage `object`)
- `updateRoomStorage(roomId: string, key: string, type: 'set' | 'array-add' | 'array-add-unique' | 'array-remove-matching' | 'array-update-matching', value: any, updateValue?: any)`: Update the shared room storage from the server.

#### Event types

- `clientRegistered`: Client registered with the server (returns the client's ID `string`, customData `object`)
- `clientRegistrationRequested`: Client requests to register (returns the client's ID `string`, customData `object`) – return `false` or a rejection reason `string` to block the registration
- `clientDisconnected`: Client disconnected from the server (returns the client's ID `string`)
- `clientJoinedRoom`: Client joined a room – note that clients can only leave by disconnecting (returns the client's ID `string`, room ID `string`)
- `roomCreated`: Client created a room (returns room ID `string`)
- `roomDestroyed`: Room was destroyed, this happens when all participants leave (returns room ID `string`)
- `roomCreationRequested`: Room creation requested by client (returns `object` containing the client's ID `string`, room ID `string` and the initialStorage `object`) – if you return an `object` in the callback, it will take that as the initial storage instead. If you return `false`, the creation will be denied
- `storageUpdateRequested`: Room storage property update requested by client (returns `object` containing the client's ID `string`, room ID `string` and the update `object`) – if you return `false` in the callback, the update will be blocked
- `requestReceived`: Request from client was received by the server (returns `object` containing client's ID `string`, if in room – room ID `string`, request name `string` and optional passed data of type `any`)

### Properties (Read-only)

- `getRooms`: Retrieve the rooms object

# License

MIT