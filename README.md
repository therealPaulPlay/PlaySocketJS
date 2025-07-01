# PlaySocket

A WebSocket-based multiplayer library that simplifies game development by abstracting away the backend logic and moving it to the frontend.

## Why use PlaySocket?

PlaySocket eliminates the traditional complexity of multiplayer implementations:

- **Streamlined Architecture**: No additional backend code is required
- **State Synchronization**: Built-in storage system keeps game state synchronized across all users
- **Resilient & Secure Connections**: Automatic reconnection handling and rate limiting
- **Lightweight**: Uses WebSockets for efficient, predictable & reliable communication with little code required

## Installation

```bash
npm install playsocketjs
```

## Usage

Note that in production, you should **always try...catch** these promises, such as socket.init(), to ensure your application continues to run if errors occur.

```javascript
import PlaySocket from 'playsocketjs';

// Create a new instance
const socket = new PlaySocket('unique-client-id', {
    endpoint: 'wss://example.com/socket'
});

// Set up event handlers
socket.onEvent('status', status => console.log('Status:', status));
socket.onEvent('storageUpdated', storage => console.log('Storage update received:', storage));

// Initialize the socket
await socket.init();

// Create a new room
const roomId = await socket.createRoom();

// Optionally, you can create a room with an initial storage object
const roomId = await socket.createRoom({
  players: [],
  moreThings: {},
  latestPlayer: null,
});

// Join an existing room
await socket.joinRoom('room-id');

// Interact with the synced storage (available if in room)
const currentState = socket.getStorage;
socket.updateStorageArray('players', 'add-unique', { username: 'Player4', level: 2 }); // Special method to enable safe, simultaneous storage updates for arrays
socket.updateStorage('latestPlayer', 'Player4'); // Regular synced storage update

// To leave the room, destroy the instance
socket.destroy();
```

## API Reference

### Constructor

```javascript
new PlaySocket(id?: string, options: PlaySocketOptions)
```

Creates a new PlaySocket instance with a specified ID and configuration options.
Note: With PlaySocket, the id can be set to `null` to let the server pick a unique one.

#### Configuration options
- `endpoint`: WebSocket server endpoint (e.g., 'wss://example.com/socket')
- `customData`: You can pass arbitrary data to the "clientRegistered" server event (optional)
- `debug`: Set this property to true to enable extra logging

### Methods

#### Core

- `init()`: Initialize the WebSocket connection – Returns Promise (async) which resolves with the client's id
- `createRoom(initialStorage?: object, maxSize?: number)`: Create a new room and become host – Returns Promise (async) which resolves with the room id (matches the creator's id)
- `joinRoom(hostId: string)`: Join an existing room – Returns Promise (async)
- `destroy()`: Use this to leave a room and close the connection

#### State management

- `updateStorage(key: string, value: any)`: Update a value in the synchronized storage
- `updateStorageArray(key: string, operation: 'add' | 'add-unique' | 'remove-matching' | 'update-matching', value: any, updateValue?: any)`: Safely update arrays in storage by adding, removing, or updating items. This is necessary for when array updates might be happening simultaneously to ensure changes are being applied and not overwritten. Using add-unique instead of add ensures that this value can only be in the array once.
- `onEvent(event: string, callback: Function)`: Register an event callback

##### Event types

- `status`: Connection status updates (returns status `string`)
- `error`: Error events (returns error `string`)
- `instanceDestroyed`: Destruction event - triggered by manual .destroy() method invocation or by fatal errors and disconnects
- `storageUpdated`: Storage state changes (returns storage `object`)
- `hostMigrated`: Host changes (returns the new host's id `string`) – As compared to PlayPeerJS, the room id does NOT change when the host changes
- `clientConnected`: New client connected to the room (returns client-id `string`)
- `clientDisconnected`: Client disconnected from the room (returns client-id `string`)

### Properties (Read-only)

The `id` is used to distinguish the client from other clients on the WebSocket server. 
Using a UUID is recommended, but it is also fine to use any other random string. If you're using a public WebSocket server, including your application's name in the `id` can help to prevent overlap (e.g. your-app-012345abcdef). 

- `id`: Client's unique identifier
- `isHost`: If this user is currently assigned the host role
- `connectionCount`: Number of active client connections in room (without you)
- `getStorage`: Retrieve storage object

# PlaySocket Server

PlaySocket includes a server implementation that can be set up in seconds.

## Installation

To use the server component, you'll need to install playsocketjs and the ws package:

```bash
npm install playsocketjs ws
```

## Usage

Here are usage examples for a standalone server and an express application. The implementation is 
framework agnostic and the Express example can be adapted to any other backend solution.

### Standalone server

```javascript
const PlaySocketServer = require('playsocketjs/server');

// Create and start the server
const server = new PlaySocketServer();

// Gracefully disconnect all clients and close the server (optional)
function shutdown() {
    server.stop();
    process.exit(0);
}

// Handle both SIGINT (Ctrl+C) and SIGTERM (Docker stop)
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

### With Express.js

```javascript
const express = require('express');
const http = require('http');
const PlaySocketServer = require('playsocketjs/server');
const port = 3000;

const app = express();
const httpServer = http.createServer(app);

// Create PlaySocket server with your HTTP server
// You'll likely want to use a custom path in this scenario
const playSocketServer = new PlaySocketServer({
  server: httpServer,
  path: '/socket'
});

// Start the server
httpServer.listen(port, () => {
  console.log('Server running on port 3000');
});

// Gracefully disconnect all clients and close the server (optional)
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

##### Event types

- `clientRegistered`: Client registered with the server (returns the client's id `string`, customData `object`)
- `clientDisconnected`: Client disconnected from the server (returns the client's id `string`)
- `roomCreated`: Client created a room (returns room id `string`)
- `roomJoined`: Client joined a room (returns the client's id `string`, room id `string`)

### Properties (Read-only)

- `getRooms`: Retrieve the rooms object

# License

MIT

# Contributing

Please feel free to fork the repository and submit a Pull Request.