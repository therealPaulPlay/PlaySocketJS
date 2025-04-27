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
const hostId = await socket.createRoom({
    players: [],
});

// Or, join room
await socket.joinRoom('room-id'); // Same as the host's id

// Interact with the synced storage
const currentState = socket.getStorage;
socket.updateStorageArray('players', 'add-unique', { username: 'Player4', level: 2 }); // Special method to enable simultaneous storage updates for arrays
socket.updateStorage('latestPlayer', 'Player4'); // Regular synced storage update

// To leave the room, destroy the instance
socket.destroy();
```

## API Reference

### Constructor

```javascript
new PlaySocket(id: string, options: PlaySocketOptions)
```

Creates a new PlaySocket instance with a specified ID and configuration options.

#### Options object properties
- `endpoint`: WebSocket server endpoint (e.g., 'wss://your-server.com/socket')

### Methods

#### Core

- `init()`: Initialize the WebSocket connection (async)
- `createRoom(initialStorage?: object, maxSize?: number)`: Create a new room and become host (async)
- `joinRoom(hostId: string)`: Join an existing room. Returns promise (async)
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
- `hostMigrated`: Host changes (returns host id / room code `string`)
- `clientConnected`: New client connected to the room (returns client-id `string`)
- `clientDisconnected`: Client disconnected from the room (returns client-id `string`)

### Properties

The `id` is used to distinguish the client from other clients on the WebSocket server. 
Using a UUID is recommended, but it is also fine to use any other random string. If you're using a public WebSocket server, including your application's name in the `id` can help to prevent overlap (e.g. your-app-012345abcdef). 

- `id`: Client's unique identifier
- `isHost`: If this user is currently assigned the host role
- `connectionCount`: Number of active client connections in room (without you)
- `getStorage`: Retrieve storage object

## Server

PlaySocket requires a compatible WebSocket server. A simple implementation example is provided in this library under `/server`.

## License

MIT

## Contributing

Please feel free to fork the repository and submit a Pull Request.