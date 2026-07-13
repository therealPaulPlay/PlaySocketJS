// Custom properties that PlaySocketServer attaches to ws WebSocket instances,
// added to the ws module's own WebSocket type via declaration merging
import "ws";

declare module "ws" {
    interface WebSocket {
        connectionId: string;
        isAlive: boolean;
        clientId?: string;
        isTerminating?: boolean;
        willfulDisconnect?: boolean;
    }
}