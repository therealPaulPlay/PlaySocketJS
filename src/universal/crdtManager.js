// Custom conflict-free replicated data type system with vector clocks

const CONSOLE_PREFIX = "CRDT Manager: ";

class CRDTManager {
    // Storage
    #replicaId;
    #keyOperations = new Map();

    // Local only
    #propertyStore = {}; // Current local values per key, as object
    #lastPropertyStore = {}; // Last property store to compare against

    // Vector clock
    #vectorClock = new Map();

    // Available operations
    #availableOperations = ["set", "array-add", "array-add-unique", "array-update-matching", "array-remove-matching"];

    /**
     * Create a new instance
     * @param {string} [replicaId] - Choose a uuid (falls back to random uuid)
     */
    constructor(replicaId) {
        this.#replicaId = replicaId || crypto.randomUUID();
        this.#vectorClock.set(this.#replicaId, 0);
    }

    /**
     * Import the entire state of the CRDT manager (this overwrites the old state)
     * @param {Object} state
     */
    importState(state) {
        try {
            const { keyOperations, vectorClock } = state;
            this.#keyOperations = new Map(keyOperations); // Rebuild the map
            this.#vectorClock = new Map(vectorClock); // Also rebuild the map here
            if (!this.#vectorClock.has(this.#replicaId)) this.#vectorClock.set(this.#replicaId, 0); // Reset own vector clock if it wasn't present in the imported state

            // Process each key to update local values
            for (const key of this.#keyOperations.keys()) this.#processLocalProperty(key);

        } catch (error) {
            console.error(CONSOLE_PREFIX + "Failed to import state:", error);
        }
    }

    /**
     * Export only the last operation of a property for a single key
     * This can still be imported using importProperty
     * @param {string} key 
     * @returns {Object} - Data export
     */
    exportPropertyLastOpOnly(key) {
        const lastOp = this.#keyOperations.get(key)?.[this.#keyOperations.get(key)?.length - 1];
        return {
            key,
            operations: lastOp ? [lastOp] : [],
            vectorClock: Array.from(this.#vectorClock.entries())
        };
    }

    /**
     * Export property for a single key
     * @param {string} key 
     * @returns {Object} - Data export
     */
    exportProperty(key) {
        return {
            key,
            operations: this.#keyOperations.get(key) || [],
            vectorClock: Array.from(this.#vectorClock.entries())
        };
    }

    /**
     * Import property for a single key and merge changes
     * @param {Object} data - Data to import
     */
    importProperty(data) {
        try {
            const { key, operations, vectorClock } = data;

            // Get current ops (or init empty array if key does not exist yet)
            const currentOps = this.#keyOperations.get(key) || [];

            // Merge vector clocks (always take max value)
            if (vectorClock) {
                for (const [id, counter] of vectorClock) {
                    if (!this.#vectorClock.has(id) || this.#vectorClock.get(id) < counter) {
                        this.#vectorClock.set(id, counter);
                    }
                }
            }

            // Add new operations in correct order
            const existingUuids = new Set(currentOps.map(op => op.uuid));
            if (operations?.length) {
                for (const op of operations) {
                    if (op?.uuid && !existingUuids.has(op.uuid)) currentOps.push({ ...op });
                }
            }

            // Sort and update local value
            this.#keyOperations.set(key, this.#sortByVectorClock(currentOps));
            this.#processLocalProperty(key);

            // Check if garbage collection should run
            this.#checkGarbageCollection();

        } catch (error) {
            console.error(CONSOLE_PREFIX + "Failed to import property:", error);
        }
    }

    /**
     * Update a property
     * @param {string} key 
     * @param {string} operation 
     * @param {*} value 
     * @param {*} updateValue 
     */
    updateProperty(key, operation, value, updateValue) {
        try {
            // Increment vector clock
            const counter = this.#vectorClock.get(this.#replicaId) || 0;
            this.#vectorClock.set(this.#replicaId, counter + 1);

            // Init key if needed
            if (!this.#keyOperations.has(key)) this.#keyOperations.set(key, []);
            const ops = this.#keyOperations.get(key);

            // Add operation
            ops.push({
                data: { operation, value, updateValue },
                vectorClock: Array.from(this.#vectorClock.entries()),
                source: this.#replicaId,
                uuid: crypto.randomUUID()
            });

            // Sort and process
            this.#keyOperations.set(key, this.#sortByVectorClock(ops));
            this.#processLocalProperty(key);

            // Check if garbage collection should run
            this.#checkGarbageCollection();

        } catch (error) {
            console.error(CONSOLE_PREFIX + `Failed to add operation for key "${key}":`, error);
        }
    }

    // TODO: If many operations are sent across, clients might prematurely garbage collect leading to operations arriving late that occured
    // before the garbage collection and should have been evaluated earlier
    // if we only sync the last operation, this can then lead to desync – otherwise it can lead to "ignored" operations (still bad)
    #checkGarbageCollection() {
        const operationThreshold = 20; // Perform garbage collection if this threshold is reached
        const retainCount = 10; // How many ops to keep

        for (const [key, operations] of this.#keyOperations.entries()) {
            if (operations.length > operationThreshold) {
                const retainedOps = operations.slice(-retainCount); // newest ops
                const baselineOps = operations.slice(0, -retainCount); // oldest ops (start =  idx 0, end = retainCount counted from right side)

                // Use the vector clock from the last operation that we remove/overwrite with set (to ensure casual history)
                const baselineVectorClock = baselineOps[baselineOps.length - 1]?.vectorClock || [];

                // Calculate the value at the point where retained operations start
                let baselineValue = null;
                for (const op of baselineOps) {
                    if (!op.data) continue;
                    if (op.data.operation.startsWith('array') && !Array.isArray(baselineValue)) baselineValue = []; // Initialize array if required
                    baselineValue = this.#handleOperation(
                        baselineValue,
                        op.data.operation,
                        op.data.value,
                        op.data.updateValue
                    );
                }

                // Create a compact operation with baseline value and appropriate vector clock
                const compactOp = {
                    data: { operation: "set", value: baselineValue },
                    vectorClock: baselineVectorClock,
                    source: this.#replicaId,
                    uuid: crypto.randomUUID()
                };

                // Combine compact op with retained operations
                this.#keyOperations.set(key, [compactOp, ...retainedOps]);
            }
        }
    }

    /**
     * Process a property's value by applying all operations and set it in the property store
     * @param {string} key 
     */
    #processLocalProperty(key) {
        try {
            const ops = this.#keyOperations.get(key);
            if (!ops?.length) return;

            let value = null;

            // Apply all operations in order
            for (const op of ops) {
                if (!op.data) continue;
                if (op.data.operation.startsWith('array') && !Array.isArray(value)) value = []; // Initialize array if required
                value = this.#handleOperation(
                    value,
                    op.data.operation,
                    op.data.value,
                    op.data.updateValue
                );
            }

            this.#propertyStore[key] = value; // Save locally
        } catch (error) {
            console.error(CONSOLE_PREFIX + `Failed to process property for "${key}":`, error);
        }
    }

    // Sort by vector clock (causal order)
    #sortByVectorClock(operations) {
        return [...operations].sort((a, b) => {
            const clockA = new Map(a.vectorClock || []);
            const clockB = new Map(b.vectorClock || []);

            // First sort by causal relationship
            let aGreater = false, bGreater = false;

            const allIds = new Set([...clockA.keys(), ...clockB.keys()]);
            for (const id of allIds) {
                const countA = clockA.get(id) || 0;
                const countB = clockB.get(id) || 0;

                if (countA > countB) aGreater = true;
                if (countA < countB) bGreater = true;
            }

            // Determine causal relationship (if one is greater, and the other is smaller, it's clear)
            if (aGreater && !bGreater) return 1;     // a happens after b
            if (!aGreater && bGreater) return -1;    // a happens before b

            // Concurrent (unclear): Compare highest counter in each (sort by which one is ahead)
            const maxA = Math.max(...Array.from(clockA.values()), 0);
            const maxB = Math.max(...Array.from(clockB.values()), 0);
            if (maxA !== maxB) return maxA - maxB;

            // Final tiebreak: Sort by ID of Replica that actually generated the operation
            return a.source.localeCompare(b.source);
        });
    }

    // Handle an operation
    #handleOperation(curValue, operation, value, updateValue) {
        if (!this.#availableOperations.includes(operation)) {
            return curValue;
        }

        try {
            // Clone to avoid reference issues
            curValue = JSON.parse(JSON.stringify(curValue || null));

            // Set operation
            if (operation === "set") {
                return value;
            }

            // Array operations
            if (operation.startsWith('array')) {
                if (!Array.isArray(curValue)) curValue = []; // Auto-convert to array if current value isn't one

                // Comparison function
                const isObject = typeof value === 'object' && value !== null;
                const compare = (item) => {
                    if (isObject && typeof item === 'object' && item !== null) {
                        return JSON.stringify(item) === JSON.stringify(value); // Deep comparison
                    }
                    return item === value; // Value comparison
                };

                switch (operation) {
                    case 'array-add':
                        curValue.push(value);
                        break;
                    case 'array-add-unique':
                        if (!curValue.some(compare)) curValue.push(value);
                        break;
                    case 'array-remove-matching':
                        curValue = curValue.filter(item => !compare(item));
                        break;
                    case 'array-update-matching':
                        const index = curValue.findIndex(compare);
                        if (index !== -1) curValue[index] = updateValue;
                        break;
                }
            }

            return curValue;

        } catch (error) {
            console.error(CONSOLE_PREFIX + `Failed to process operation with curValue ${curValue}:`, error);
            return curValue;
        }
    }

    // Get property store
    get getPropertyStore() {
        try {
            return JSON.parse(JSON.stringify(this.#propertyStore));
        } catch {
            console.error(CONSOLE_PREFIX + "Failed to parse property store")
            return {};
        }
    }

    // Check for changes in the local property store
    get didPropertiesChange() {
        try {
            if (JSON.stringify(this.#propertyStore) !== JSON.stringify(this.#lastPropertyStore)) {
                this.#lastPropertyStore = JSON.parse(JSON.stringify(this.#propertyStore));
                return true;
            }
        } catch { }
        return false;
    }

    // Get full state (can be imported using importState)
    get getState() {
        // Convert Maps to arrays for serialization
        return {
            keyOperations: [...this.#keyOperations.entries()],
            vectorClock: [...this.#vectorClock.entries()]
        };
    }
}

module.exports = { CRDTManager };