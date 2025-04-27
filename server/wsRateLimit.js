const rateLimits = new Map();
const MAX_POINTS = 100;

// Check rate limit and consume points if allowed
function checkRateLimit(clientId, operationType) {
    const now = Date.now();

    // Initialize new clients
    if (!rateLimits.has(clientId)) {
        rateLimits.set(clientId, { points: MAX_POINTS, lastReset: now });
        return true;
    }

    const limit = rateLimits.get(clientId);

    // Reset points if interval has passed (5s)
    if (now - limit.lastReset > 5000) {
        limit.points = MAX_POINTS;
        limit.lastReset = now;
    }

    // Cost more points for critical operations
    const pointCost = ['create_room', 'join_room'].includes(operationType) ? 20 : 1;
    if (limit.points < pointCost) return false; // Check if enough points available

    // Consume points & return true
    limit.points -= pointCost;
    return true;
}

function removeFromRateLimits(clientId) {
    rateLimits.delete(clientId);
}

module.exports = { checkRateLimit, removeFromRateLimits };