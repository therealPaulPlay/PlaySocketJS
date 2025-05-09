// Custom conflict-free replicated data type system with vector clocks

const CONSOLE_PREFIX = "CRDT Manager: ";

class CRDTManager {
    // Storage
    #replicaId;
    #keyOperations = new Map();

    // Vector clock
    #vectorClock = new Map();

    // Local only
    #propertyStore = {}; // Current local values per key, as object
    #lastPropertyStore = {}; // Last property store to compare against

    // Local Garbage Collection
    #lastGCCheck = 0;
    #opUuuidTimestamp = new Map(); // Map every operation to a timestamp for garbage collection

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

            this.#opUuuidTimestamp.clear(); // Reset the uuid timestamps since it might contain uuid's that no longer exist in the new state
            this.#keyOperations = new Map(keyOperations); // Rebuild the map
            this.#vectorClock = new Map(vectorClock); // Also rebuild the map here
            if (!this.#vectorClock.has(this.#replicaId)) this.#vectorClock.set(this.#replicaId, 0); // Reset own vector clock if it wasn't present in the imported state

            // Map operation uuids to timestamp
            this.#keyOperations.forEach((value, key) => {
                value?.forEach((operation) => {
                    this.#opUuuidTimestamp.set(operation?.uuid, Date.now());
                })
            });

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
            operations: [...(this.#keyOperations.get(key) || [])],
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

            // Get COPY of current ops (or empty array if none yet)
            const currentOps = [...(this.#keyOperations.get(key) || [])];

            // Merge vector clocks (always take max value)
            if (vectorClock) {
                for (const [id, counter] of vectorClock) {
                    if (!this.#vectorClock.has(id) || this.#vectorClock.get(id) < counter) {
                        this.#vectorClock.set(id, counter);
                    }
                }
            }

            // Add new operations (diff) in correct order
            const existingUuids = new Set(currentOps.map(op => op.uuid));
            if (operations?.length) {
                for (const op of operations) {
                    if (op?.uuid && !existingUuids.has(op.uuid)) {
                        currentOps.push({ ...op }); // Add operation
                        this.#opUuuidTimestamp.set(op?.uuid, Date.now()); // Add timestamp for gc
                    }
                }
            }

            // Sort, update operations & local value
            this.#keyOperations.set(key, this.#sortByVectorClock(currentOps));
            this.#processLocalProperty(key);

            this.#checkGarbageCollection(); // Check if GC should run

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

            // Assign shallow COPY of currennt ops or fall back to empty array
            const currentOps = [...(this.#keyOperations.get(key) || [])];

            // Add operation
            const newOp = this.#createOperation({ operation, value, updateValue }, Array.from(this.#vectorClock.entries()));
            currentOps.push(newOp);

            // Sort and process
            this.#keyOperations.set(key, this.#sortByVectorClock(currentOps));
            this.#opUuuidTimestamp.set(newOp.uuid, Date.now());
            this.#processLocalProperty(key);

            this.#checkGarbageCollection(); // Check if GC should run

        } catch (error) {
            console.error(CONSOLE_PREFIX + `Failed to add operation for key "${key}":`, error);
        }
    }

    #checkGarbageCollection() {
        const MIN_GC_DELAY = 1000; // Minimum 1s delay between garbage collection runs
        const MIN_AGE_FOR_GC = 5000; // Garbage collect ops that are older than 5s

        if (Date.now() - this.#lastGCCheck < MIN_GC_DELAY) return;
        this.#lastGCCheck = Date.now()

        for (const [key, operations] of this.#keyOperations.entries()) {
            if (operations?.length < 5) continue; // Min op amount per key for garbage collection to run (otherwise not worth it)

            let retainCount = operations.length;
            operations.forEach((op, index) => {
                // Count how many ops, from last to latest, are >10s old in a row
                if (op.uuid && this.#opUuuidTimestamp.has(op.uuid) && (Date.now() - this.#opUuuidTimestamp.get(op.uuid)) > MIN_AGE_FOR_GC) {
                    const removeCount = index + 1;
                    retainCount = operations.length - removeCount;
                    this.#opUuuidTimestamp.delete(op.uuid); // Remove from timestamps if set to be deleted
                }
            });

            if (retainCount < operations.length) {
                const retainOps = operations.slice(-retainCount); // newest ops
                const removeOps = operations.slice(0, -retainCount); // oldest ops (start =  idx 0, end = retainCount counted from right side)
                const baselineVectorClock = removeOps[removeOps.length - 1]?.vectorClock || []; // Use the vector clock from the last operation that we remove/overwrite 

                // Calculate the value at the point where retained operations start
                let baselineValue = null;
                for (const op of removeOps) {
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
                const compactOp = this.#createOperation({ operation: "set", value: baselineValue }, baselineVectorClock);

                // Combine compact op with retained operations
                this.#keyOperations.set(key, [compactOp, ...retainOps]);
            }
        }
    }

    /**
     * Create an operation object
     * @param {Object} data 
     * @param {Array} vectorClock 
     * @returns {Object} - Operation object
     */
    #createOperation(data, vectorClock) {
        const newOperation = {
            data,
            vectorClock,
            source: this.#replicaId,
            uuid: crypto.randomUUID()
        }
        this.#opUuuidTimestamp.set(newOperation.uuid, Date.now());
        return newOperation;
    }

    /**
     * Process a property's value by applying all operations and set it in the property store
     * @param {string} key 
     */
    #processLocalProperty(key) {
        try {
            const ops = this.#keyOperations.get(key);
            if (!ops?.length) return;

            // Apply all operations in order
            let value = null;

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
            if (operation === "set") return value;

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
            return JSON.parse(JSON.stringify(this.#propertyStore)); // Return full copy
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

    // Get state (can be imported using importState, converts the maps to arrays for serialization)
    get getState() {
        return {
            keyOperations: [...this.#keyOperations.entries()],
            vectorClock: [...this.#vectorClock.entries()]
        };
    }
}

module.exports = { CRDTManager };