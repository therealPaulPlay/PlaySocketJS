// Custom conflict-free replicated data type system with vector clocks

const CONSOLE_PREFIX = "CRDT Manager: ";

class CRDTManager {
    // Storage
    #keyOperations = new Map();
    #propertyStore = {}; // Current local values per key, as object
    #lastPropertyStore = {}; // Last property store to compare against

    // Vector clock
    #replicaId;
    #vectorClock = new Map();

    // Available operations
    #availableOperations = ["set", "array-add", "array-add-unique", "array-update-matching", "array-remove-matching"];

    // Initialize vector clock
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
            if (!this.#vectorClock.has(this.#replicaId)) this.#vectorClock.set(this.#replicaId, 0);

            // Process each key in the property store to update local values
            for (const key of this.#keyOperations.keys()) this.#processLocalProperty(key);
        } catch (error) {
            console.error(CONSOLE_PREFIX + "Failed to import state:", error);
        }
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
     * Import property for a single key and reconcile
     * @param {Object} data - Data to import
     */
    importProperty(data) {
        try {
            const { key, operations, vectorClock } = data;

            // Init key if needed
            if (!this.#keyOperations.has(key)) this.#keyOperations.set(key, []);
            const currentOps = this.#keyOperations.get(key); // Get current ops for this key

            // Merge vector clocks
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

            // Sort and update
            this.#keyOperations.set(key, this.#sortByVectorClock(currentOps));
            this.#processLocalProperty(key);
        } catch (error) {
            console.error(CONSOLE_PREFIX + "Failed to import property:", error);
        }
    }

    /**
     * Update a property
     * @param {string} key 
     * @param {number} timestamp 
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
                uuid: crypto.randomUUID()
            });

            // Sort and process
            this.#keyOperations.set(key, this.#sortByVectorClock(ops));
            this.#processLocalProperty(key);
        } catch (error) {
            console.error(CONSOLE_PREFIX + `Failed to add operation for key "${key}":`, error);
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

            // Determine causal relationship if one is greater than another
            if (aGreater && !bGreater) return 1;     // a happens after b
            if (!aGreater && bGreater) return -1;    // a happens before b

            // For concurrent operations (neither happens before the other), prioritize Set
            if (a.data?.operation === 'set' && b.data?.operation !== 'set') return -1;
            if (a.data?.operation !== 'set' && b.data?.operation === 'set') return 1;

            // Fallback: UUID as tiebreaker, sort by alphabetical order
            return a.uuid.localeCompare(b.uuid);
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
                // Auto-convert to array if current value isn't one
                if (!Array.isArray(curValue)) curValue = [];

                // Comparison function
                const isObject = typeof value === 'object' && value !== null;
                const compare = (item) => {
                    if (isObject && typeof item === 'object' && item !== null) {
                        return JSON.stringify(item) === JSON.stringify(value);
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