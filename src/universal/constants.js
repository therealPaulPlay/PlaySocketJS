/**
 * Heartbeat ping interval in milliseconds
 * Also used as the minimum age for CRDT garbage collection - operations are
 * retained for at least one heartbeat cycle to ensure even slow clients can never 
 * be desynced as a result of gc
 */
export const HEARTBEAT_INTERVAL = 5000;

/**
 * Library version, must match package.json
 */
export const VERSION = "4.3.0";

/**
 * Logging prefixes
 */
export const ERROR_PREFIX = "PlaySocket error: ";
export const WARNING_PREFIX = "PlaySocket warning: ";
export const LOG_PREFIX = "PlaySocket log: ";
