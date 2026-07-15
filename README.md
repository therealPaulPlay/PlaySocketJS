# PlaySocket

An optimistic-first WebSocket synchronization library. Built for creating multiplayer games & collaborative experiences with reactive web frameworks.

## Why use PlaySocket?

PlaySocket makes developing shared experiences a breeze:

- **Optimistic-first**: Updates apply locally right away and merge conflict-free across clients. Calling `updateStorage()` triggers the `storageUpdated` event instantly, without waiting for a server roundtrip.
- **Fast prototyping**: No backend code beyond init is required, though server-authoritative validation and behavior are supported for production apps.
- **Built for reactivity**: Assign the synced storage to a reactive variable via a callback, ideal for React, Svelte & co.
- **Resilient & secure**: Automatic reconnection handling & strict rate-limiting.
- **Lightweight**: Uses WebSockets, has few dependencies, and utilizes `MessagePack` for maximum efficiency.

<!-- docs-start -->

## Installation

Install PlaySocket with your package manager of choice to get started.

```bash
npm install playsocketjs
```

&nbsp;

## PlaySocket Client

The client-side part of PlaySocket.

### Examples

> [!NOTE]
> In production, you should **always try...catch** promises such as `socket.init()` as they can reject. These examples omit the error handling to keep them simple.

Initializing the client:
```javascript
import PlaySocket from 'playsocketjs';

// Create a new instance
// Omit the ID to let the server pick one
const socket = new PlaySocket('unique-client-id', {
    endpoint: 'wss://example.com/socket'
});

// Set up the event handlers you need
socket.onEvent('status', status => console.log(status));
socket.onEvent('error', error => console.error(error));
...

const clientId = await socket.init(); // Connect
```

Creating a room:
```javascript
// Create a new room
const roomId = await socket.createRoom();

// Optionally, with initial storage
const roomId = await socket.createRoom({
  players: [{ name: "Player-1", level: 35 }],
  latestPlayer: null,
});
```

Joining a room:
```javascript
await socket.joinRoom('room-id'); // Join an existing room
```

Leaving a room:
```javascript
socket.destroy(); // Destroy the instance to leave
```

Using the storage update event with reactivity:
```javascript
// Assign to useState(), $state(), reactive() etc. on update
const [reactiveVar, setReactiveVar] = useState(); 
socket.onEvent('storageUpdated', storage => {
    setReactiveVar(storage);
});
```

```jsx
<p>Players: {reactiveVar.players?.join(", ")}</p>
```

Interfacing with the synchronized storage:
```javascript
const currentState = socket.storage; // Read-only access

socket.updateStorage('players', 'array-add-unique', { username: 'Player4', level: 2 });
socket.updateStorage('latestPlayer', 'set', 'Player4');
socket.updateStorage('playerInfo', 'set', '{ date: "22-6-2026 }');
socket.updateStorage('playerInfo', 'object-set-key', 'color', 'red')

console.log(socket.storage.players); // Log players array
```

Sometimes it's convenient to send a traditional request to the server. For example, when you want to opt out of optimistic updates, or when
the validation logic would be too complex otherwise:
```javascript
socket.sendRequest('my-request-name', { fact: "You can build traditional client-server logic like this." })
```

### API reference

#### Constructor

Create a new PlaySocket instance with a specified ID and configuration options.
The ID can be set to `null` to let the server pick a unique one.

```javascript
new PlaySocket(id?: string, options: PlaySocketOptions)
```

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `endpoint` | `string` | Yes | `undefined` | WebSocket server endpoint (e.g., wss://example.com/socket). |
| `customData` | `object` | No | `{}` | Arbitrary data to pass to the "clientRegistered" server event. |
| `debug` | `boolean` | No | `false` | Set to true to enable extra logging. |

#### Methods

| Name | Parameters | Return type | Description |
|--------|------------|-------------|-------------|
| `init()` | - | `Promise<string>` | Initialize the WebSocket connection, resolves with the client ID. |
| `createRoom()` | `initialStorage?: object, size?: number` | `Promise<string>` | Create a new room, resolves with the room ID. Max. 500 participants. |
| `joinRoom()` | `roomId: string` | `Promise<void>` | Join an existing room. |
| `destroy()` | - | `void` | Leave room, close the connection, and destroy the instance. |
| `updateStorage()` | `key: string, type: string, value: any, secondValue?: any` | `void` | Update a key in the shared storage. |
| `sendRequest()` | `name: string, data?: any` | `void` | Send a request to the server with optional attached data. |
| `onEvent()` | `event: string, callback: Function` | `void` | Register an event callback. |

#### Event types

| Event | Callback parameter | Description |
|-------|-------------------|-------------|
| `status` | `status: string` | Connection or room status updated. |
| `error` | `error: string` | Error occured. |
| `moved` | `roomId: string` | Moved to different room. |
| `instanceDestroyed` | - | Instance destruction event, triggered by destroy() invocation or by fatal errors. |
| `storageUpdated` | `storage: object` | Storage state changed. Does not trigger on no-op updates (e.g. setting color to red when it's already red). |
| `hostMigrated` | `roomId: string` | Host was changed. |
| `clientJoined` | `clientId: string` | A client joined the room. |
| `clientLeft` | `clientId: string, roomId?: string` | Client left the room. |

#### Properties (read-only)

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Client's unique ID. |
| `isHost` | `boolean` | Whether this client is currently assigned the host role. |
| `participantCount` | `number` | Number of active client connections in room. |
| `storage` | `object` | Retrieve the storage object. |

&nbsp;

## PlaySocket Server

The server-side part of PlaySocket.

### Examples

Using PlaySocket as a standalone server:

```javascript
import PlaySocketServer from 'playsocketjs/server';

// Path defaults to "/"
const server = new PlaySocketServer();

function shutdown() {
    server.stop(); // Gracefully disconnect all clients
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

Using PlaySocket together with Express.js (or other Backend frameworks):

```javascript
const express = require('express');
const http = require('http');
const PlaySocketServer = require('playsocketjs/server');

const app = express();
const httpServer = http.createServer(app);

// Create PlaySocket server with existing HTTP server
const playSocketServer = new PlaySocketServer({
  server: httpServer,
  path: '/socket'
});

// Start the server
httpServer.listen(3000, () => {
  console.log('Server running on port 3000');
});

function shutdown() {
    playSocketServer.stop(); // Gracefully disconnect clients
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

Validating an incoming storage update:

```javascript
const server = new PlaySocketServer();

server.onEvent("storageUpdateRequested", ({ roomId, clientId, update, storage }) => {
    // Block updates on all keys except for "players" and "chats"
    if (!["players", "chats"].includes(update.key)) return false;

    if (update.key === "chats") {
        const { type, value, secondValue } = server.getUpdateDetails(update);
        if (type !== "array-add") return false; // Only allow adding chats
        if (typeof value !== "string") return false; // Only allow strings
    }
});
```

Handling an incoming request:

```javascript
const server = new PlaySocketServer();

server.onEvent("requestReceived", async ({ roomId, clientId, name, data }) => {
    if (name === "add-player-request") {
        const players = server.getRoomStorage(roomId)?.players || [];
        if (players.find(p => p.id === clientId)) return; // Already added this client
        server.updateRoomStorage(roomId, "players", "array-add", { id: clientId, timestamp: Date.now() });
    }
});
```

Combining PlaySocket with a custom authentication system:

```javascript
const authedClients = [];
const server = new PlaySocketServer();

server.onEvent("clientRegistrationRequested", async (clientId, data) => {
    try {
        // Your custom auth logic...
        // For example, data could contain a session token provided by the client
        authedClients.push(clientId);
    } catch (error) {
        return "An error occured during auth."; // Blocks the registration
    }
});

server.onEvent("clientDisconnected", async (clientId) => {
    const removeIndex = authedClients.indexOf(clientId);
    if (removeIndex !== -1) authedClients.splice(removeIndex, 1);
});

```

### API reference

#### Constructor

Create a new PlaySocket Server instance with configuration options.

```javascript
new PlaySocketServer(options?: PlaySocketServerOptions)
```

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `port` | `number` | No | 3000 | Port to listen on (used only if no server provided). |
| `path` | `string` | No | '/' | WebSocket endpoint path. |
| `server` | `http.Server` | No | - | Existing http server. |
| `rateLimit` | `number` | No | 20 | Messages/second rate limit. |
| `debug` | `boolean` | No | false | Enable debug logging. |
| `verifyClient` | `function` | No | - | Callback to verify connections before WebSocket upgrade. |

**verifyClient callback**

The `verifyClient` option allows you to implement custom connection verification logic, such as rate limiting, before the WebSocket handshake completes.

```javascript
const server = new PlaySocketServer({
    server: httpServer,
    path: '/socket',
    verifyClient: (info, callback) => {
        const ip = info.req.headers['x-forwarded-for'];
        if (isRateLimited(ip)) { 
            return callback(false, 429, 'Too Many Requests');
        }
        callback(true);
    }
});
```

The callback signature is `callback(verified, code?, message?)` where `code` refers to an HTTP status code and `message` to a rejection reason.

#### Methods

> [!IMPORTANT]
> Rooms created by the server default to host ID "server". If that host string is used, the room will not be auto-deleted when all participants have left and you need to take care of its lifecycle.

| Name | Parameters | Return type | Description |
|--------|------------|-------------|-------------|
| `stop()` | - | `void` | Closes active client connections, the WS server, and the underlying http server (if it's standalone). |
| `kick()` | `clientId: string, reason?: string` | `void` | Kick a client by their client ID. |
| `move()` | `clientId: string, roomId: string` | `void` | Move a client that is already in a room to a different room. |
| `onEvent()` | `event: string, callback: Function` | `void` | Register a server-side event callback. |
| `getRoomStorage()` | `roomId: string` | `object` | Get a snapshot of the current room storage. |
| `getUpdateDetails()` | `update: object` | `object` | Get the details (`type`, `value` and `secondValue`) of a storage update for custom validation logic in the `storageUpdateRequested` event. |
| `updateRoomStorage()` | `roomId: string, key: string, type: string, value: any, secondValue?: any` | `void` | Update a key in the shared room storage. |
| `createRoom()` | `initialStorage?: object, size?: number, host?: string` | `object` | Create a room (returns object containing room ID and state).|
| `destroyRoom()` | `roomId: string` | `void` | Destroy a room & kick all participants. |

#### Event types

| Event | Callback parameters | Description | Return for action |
|-------|-------------------|-------------|--------------|
| `clientRegistered` | `clientId: string, customData: object` | Client registered with the server. | - |
| `clientRegistrationRequested` | `clientId: string, customData: object` | Client requests to register. | Return `false` or rejection reason `string` to block. |
| `clientDisconnected` | `clientId: string` | Client disconnected. | - |
| `clientJoinedRoom` | `clientId: string, roomId: string` | Client joined a room. | - |
| `clientJoinRequested` | `clientId: string, roomId: string` | Client requests to join a room. | Return `false` or rejection reason `string` to block. |
| `clientLeftRoom` | `clientId: string, roomId: string` | Client left a room. | - |
| `roomCreated` | `roomId: string` | Client created a room. | - |
| `roomDestroyed` | `roomId: string` | Room was destroyed. | - |
| `roomCreationRequested` | `{clientId: string, initialStorage: object}` | Client requests to create room. | Return `object` to override initial storage, `false` to block. |
| `storageUpdated` | `{clientId: string, roomId: string, update: object, storage: object}` | Room storage updated. | - |
| `storageUpdateRequested` | `{clientId: string, roomId: string, update: object, storage: object}` | Client requests storage update. | Return `false` to block the update. |
| `requestReceived` | `{clientId: string, roomId?: string, requestName: string, data?: any}` | Request from client. | - |

#### Properties (read-only)

| Property | Type | Description |
|----------|------|-------------|
| `rooms` | `object` | Retrieve the rooms object. |

## Storage updates in detail

Both `updateStorage()` and `updateRoomStorage()` work the same way. The only difference is that the latter takes `roomId` as the first argument and runs on the server. There's a limit of 100 storage keys.

Number, array and object operation types allow for conflict-free simultaneous updates. The set operation just replaces the property and ensures correct ordering. 

For `-matching` operations, `value` becomes the value to match, and `secondValue` the replacement. For object operations, `value` is the property key, and `secondValue` the property value. 

The following types exist:
- `set`
- `number-increment`
- `array-add`
- `array-add-unique`
- `array-update-matching`
- `array-remove-matching`
- `object-set-key`
- `object-remove-key`

Example for each type:
- `updateStorage("color", "set", "blue")`
- `updateStorage("score", "number-increment", "25")`
- `updateStorage("players", "array-add", { name: "Player1" })`
- `updateStorage("completedLevels", "array-add-unique", 14)`
- `updateStorage("names", "array-update-matching", "Leo_cool", "TheCoolerLeo")`
- `updateStorage("missingLevels", "array-remove-matching", 14)`
- `updateStorage("levelNames", "object-set-key", "evilSea", "Evil sea")`
- `updateStorage("levelNames", "object-remove-key", "darkOcean")`

<!-- docs-end -->

# License

MIT