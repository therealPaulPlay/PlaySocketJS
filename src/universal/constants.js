/**
 * Heartbeat ping interval in milliseconds
 * Also used as the minimum age for CRDT garbage collection - operations are
 * retained for at least one heartbeat cycle to ensure even slow clients can never 
 * be desynced as a result of gc
 */
export const HEARTBEAT_INTERVAL = 5000;
