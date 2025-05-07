

/**
 * Custom conflict-free replicated data type system
 */

const CONSOLE_PREFIX = "CRDT Manager: ";

class CRDTManager {
    // Key operations history
    #keyOperations = new Map(); // Key -> [Operation history]

    // Current value replica
    #propertyStore = {}; // Current local values per key, as object
    #lastPropertyStore = {}; // Last property store to compare against

    // More
    #availableOperations = ["set", "array-add", "array-add-unique", "array-update-matching", "array-remove-matching"];

    /**
     * Import the entire state of the CRDT manager
     * Disclaimer: This overwrites the old state & doesn't merge it
     * @param {Object} state
     */
    importState(state) {
        try {
            const { keyOperations } = state;
            this.#keyOperations = new Map(keyOperations); // Rebuild the keyOperations Map

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
        return { key, operations: this.#keyOperations.get(key) };
    }

    /**
     * Import property for a single key and reconcile
     * @param {Object} data - Data to import
     */
    importProperty(data) {
        try {
            const { key, operations } = data;

            // Initialize the key if it doesn't exist yet
            if (!this.#keyOperations.has(key)) this.#keyOperations.set(key, []);

            const currentOperations = this.#keyOperations.get(key); // Get the current operations for this key
            const existingUUIDs = new Set(currentOperations.map(entry => entry.uuid)); // Create a set of existing UUIDs

            // Merge new operations that don't already exist (using UUID for uniqueness)
            if (operations && Array.isArray(operations)) {
                for (const entry of operations) {
                    if (entry && entry.uuid && !existingUUIDs.has(entry.uuid)) {
                        currentOperations.push({ ...entry });
                    }
                }
            }

            const sortedOperations = this.#orderOperationsByTimestamp(currentOperations); // Sort combined operations
            this.#keyOperations.set(key, sortedOperations); // Update the key operations with the sorted merged operations

            // Process the local property store key to update its value based on the merged operations
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
    updateProperty(key, timestamp, operation, value, updateValue) {
        this.#addOperationToKey(key, { operation, value, updateValue }, timestamp); // Add operation
        this.#processLocalProperty(key); // Re-process locally-stored value
    }

    /**
     * Add an operation to a key's operation history
     * @param {string} key 
     * @param {Object} data - Operation data (operation, value...)
     * @param {number} timestamp 
     */
    #addOperationToKey(key, data, timestamp) {
        try {
            let operations = this.#keyOperations.get(key) || [];

            // Push as an object containing both operation and timestamp
            operations.push({ data, timestamp, uuid: crypto.randomUUID() });
            operations = this.#orderOperationsByTimestamp(operations); // Sort

            // Store back the sorted history (in case it was previously undefined)
            this.#keyOperations.set(key, operations);

        } catch (error) {
            console.error(CONSOLE_PREFIX + `Failed to add operation for key "${key}":`, error);
        }
    }

    /**
     * Process a properties's value by applying all operations and set it in the property store
     * @param {string} key 
     */
    #processLocalProperty(key) {
        try {
            const keyOperations = this.#keyOperations.get(key); // Get history
            let keyValue;

            // Run every operation in order (oldest to newest)
            keyOperations?.forEach(element => {
                keyValue = this.#handleOperation(keyValue, element?.data?.operation, element?.data?.value, element?.data?.updateValue);
            });

            this.#propertyStore[key] = keyValue; // Assign the processed value to the local property store

        } catch (error) {
            console.error(CONSOLE_PREFIX + `Failed to process keystore key "${key}":`, error);
        }
    }

    /**
     * Sort by timestamp (ascending = oldest first)
     * @param {Array} operations 
     * @returns {Array}
     */
    #orderOperationsByTimestamp(operations) {
        operations = [...operations];
        const orderedOperations = operations.sort((a, b) => a.timestamp - b.timestamp);
        return orderedOperations;
    }


    /**
     * Handle a single operation
     * @private 
     * @param {*} curValue 
     * @param {string} operation 
     * @param {*} value 
     * @param {*} [updateValue]
     * @returns {*}
     */
    #handleOperation(curValue, operation, value, updateValue) {
        if (!this.#availableOperations.includes(operation)) {
            console.error(CONSOLE_PREFIX + `Unsupported operation "${operation}"`);
            return curValue;
        }
        try {
            // Destroy references
            curValue = JSON.parse(JSON.stringify(curValue || null));

            // Handle regular operations
            switch (operation) {
                case "set":
                    curValue = value;
                    return curValue;
            }

            // Handle array operations
            if (operation.includes("array")) {
                if (!curValue || !Array.isArray(curValue)) {
                    console.error(CONSOLE_PREFIX + "Can't perform array operation on non-array");
                    return;
                }
                const isObject = typeof value === 'object' && value !== null;
                const compare = (item) => isObject ? JSON.stringify(item) === JSON.stringify(value) : item === value;

                switch (operation) {
                    case 'array-add':
                        curValue.push(value);
                        return curValue;

                    case 'array-add-unique':
                        if (!curValue.some(compare)) curValue.push(value);
                        return curValue;

                    case 'array-remove-matching':
                        curValue = curValue.filter(item => !compare(item));
                        return curValue;

                    case 'array-update-matching':
                        const index = curValue.findIndex(compare);
                        if (index !== -1) curValue[index] = updateValue;
                        return curValue;
                }
            }

        } catch (error) {
            console.error(CONSOLE_PREFIX + `Failed to process operation with curValue ${curValue}, operation "${operation}", value ${value} and updateValue ${updateValue}`, error);
            return curValue;
        }
    }

    /**
     * Get object representation of current local key values
     */
    get getPropertyStore() {
        try {
            return JSON.parse(JSON.stringify(this.#propertyStore));
        } catch (error) {
            console.error(CONSOLE_PREFIX + "Failed to stringify and parse property store")
            return {};
        }
    }

    /**
     * Check if a change in the local property store occured since the last check
     */
    get didPropertiesChange() {
        try {
            if (JSON.stringify(this.#propertyStore) !== JSON.stringify(this.#lastPropertyStore)) {
                this.#lastPropertyStore = JSON.parse(JSON.stringify(this.#propertyStore));
                return true;
            }
        } catch (error) {
            console.error(CONSOLE_PREFIX + "Error checking for property change:", error);
        }
        return false;
    }

    /**
     * Get the current full state
     * This can be imported using importState
     */
    get getState() {
        // Convert operation  Map to a serializable array of entries
        const keyOperationsArray = [...this.#keyOperations.entries()];
        return { keyOperations: keyOperationsArray };
    }
}

module.exports = { CRDTManager }