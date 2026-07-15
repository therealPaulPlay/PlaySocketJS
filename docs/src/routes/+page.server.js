import { highlight } from "$lib/server/highlight.js";

const clientInventoryExample = `import PlaySocket from 'playsocketjs';

const socket = new PlaySocket("michael's-id", {
    endpoint: "wss://example.com/socket"
});

socket.onEvent("storageUpdated", (storage) => {
	console.log("Current inventory:", storage.inventory);
}

// Assuming Lana has created a room
await socket.init();
await socket.joinRoom("lana's-room-id");

socket.updateStorage("inventory", "array-add", "rope");`;

const serverInventoryExample = `import PlaySocketServer from 'playsocketjs/server';

const server = new PlaySocketServer({ path: "/socket" });`;

export async function load() {
	return {
		clientInventoryExample: await highlight(clientInventoryExample),
		serverInventoryExample: await highlight(serverInventoryExample),
	};
}
