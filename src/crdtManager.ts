// Custom conflict-free replicated data type system with vector clocks

const CONSOLE_PREFIX = 'PlaySocket CRDT manager: ';

export type Operation = {
	vectorClock: [string, number][]; // Replace with VectorClock type?
	source: string;
	uuid: string;
	data: {
		type: 'set' | 'array-add' | 'array-add-unique' | 'array-remove-matching' | 'array-update-matching';
		value: unknown;
		updateValue?: unknown;
	};
};
type VectorClock = Map<string, number>;
export type PropertyUpdateData<T> = {
	key: keyof T;
	operation: Operation;
	vectorClock: [string, number][]; // Replace with VectorClock type?
};

export type State<T> = {
	keyOperations: Map<keyof T, Operation[]>;
	vectorClock: VectorClock;
};

// CRDT Manager class
export default class CRDTManager<T extends Record<string, unknown> = Record<string, unknown>> {
	// Storage
	#replicaId: string;
	#keyOperations: State<T>['keyOperations'] = new Map();
	#vectorClock: State<T>['vectorClock'] = new Map();

	#propertyStore = {} as T;
	#lastPropertyStore = {} as T;

	// Local Garbage Collection
	#lastGCCheck: number = 0;
	#opUuidTimestamp = new Map<string, number>(); // Map every operation to a timestamp for garbage collection

	// Debug
	#debug = false;

	/** Create a new instance */
	constructor(debug: boolean) {
		if (debug) this.#debug = true;
		this.#replicaId = crypto.randomUUID();
		this.#vectorClock.set(this.#replicaId, 0);
	}

	/** Import the entire state of the CRDT manager (this overwrites the old state) */
	importState(fullState: State<T>): void {
		try {
			const { keyOperations, vectorClock } = fullState;
			if (this.#debug) console.log(CONSOLE_PREFIX + 'Importing state:', fullState);

			// Resets
			this.#opUuidTimestamp.clear();
			this.#propertyStore = {} as T;
			this.#lastPropertyStore = {} as T;

			this.#keyOperations = new Map(keyOperations); // Rebuild the operations map
			this.#vectorClock = new Map(vectorClock); // Rebuild the vector clock map
			if (!this.#vectorClock.has(this.#replicaId)) this.#vectorClock.set(this.#replicaId, 0); // Add own vector clock if it wasn't present in the imported state

			// Map all operation uuids to current timestamp
			this.#keyOperations.forEach((value) => {
				value?.forEach((operation) => {
					this.#opUuidTimestamp.set(operation?.uuid, Date.now());
				});
			});

			// Process each key to update local values
			for (const key of this.#keyOperations.keys()) this.#processLocalProperty(key);
		} catch (error) {
			console.error(CONSOLE_PREFIX + 'Failed to import state:', error);
		}
	}

	/**
	 * Import property update
	 * @param data - Property update data
	 */
	importPropertyUpdate(data: PropertyUpdateData<T>): void {
		try {
			const { key, operation: rawOperation, vectorClock } = data;
			const operation = this.#sanitizeValue(rawOperation) as Operation;
			if (this.#debug) console.log(CONSOLE_PREFIX + 'Importing update:', data); // Debug

			// Check key limit to afeguard against too many keys
			if (this.#keyOperations.size >= 100 && !this.#keyOperations.has(key)) throw new Error('Key limit exceeded!');

			// Get COPY of current ops (or empty array if none yet)
			const currentOps = [...(this.#keyOperations.get(key) || [])];
			// Merge vector clocks (always take max value)
			for (const [id, counter] of vectorClock) {
				if (!this.#vectorClock.has(id) || this.#vectorClock.get(id)! < counter) {
					this.#vectorClock.set(id, counter);
				}
			}

			// Safeguard against massive vector clocks
			if (this.#vectorClock.size > 1000) this.#vectorClock = new Map([...this.#vectorClock].slice(-100));

			// Add new operation if it's not already added
			const existingUuids = new Set(currentOps.map((op) => op.uuid));
			if (operation.uuid && !existingUuids.has(operation.uuid)) {
				currentOps.push({ ...operation }); // Add operation
				this.#opUuidTimestamp.set(operation.uuid, Date.now()); // Add timestamp for gc
			}

			// Sort, update operations & local value
			this.#keyOperations.set(key, this.#sortByVectorClock(currentOps));
			this.#processLocalProperty(key);
			this.#checkGarbageCollection();
		} catch (error) {
			console.error(CONSOLE_PREFIX + 'Failed to import property update:', error);
		}
	}

	/**
	 * Update a property
	 * @param value - New value, or value to match for matching operations
	 * @param updateValue - New value to set ONLY when using update-matching operation
	 * @returns Returns the property update
	 */
	updateProperty(key: keyof T, type: Operation['data']['type'], value: unknown, updateValue?: unknown): PropertyUpdateData<T> | undefined {
		try {
			// Sanitize inputs
			value = this.#sanitizeValue(value);
			updateValue = this.#sanitizeValue(updateValue);

			// Debug log
			if (this.#debug) console.log(CONSOLE_PREFIX + `Updating property with key ${String(key)}, type ${type}, value ${value} and updateValue ${updateValue}.`);

			// Increment vector clock
			const counter = this.#vectorClock.get(this.#replicaId) || 0;
			this.#vectorClock.set(this.#replicaId, counter + 1);

			// Assign shallow COPY of currennt ops or fall back to empty array
			const currentOps = [...(this.#keyOperations.get(key) || [])];

			// Add operation
			const newOp = this.#createOperation({ type, value, updateValue }, Array.from(this.#vectorClock.entries()));
			currentOps.push(newOp);
			this.#keyOperations.set(key, currentOps); // Update the operations (no need to sort via vector clock since local updates are always the latest)
			this.#processLocalProperty(key); // Process local value
			this.#checkGarbageCollection();

			// Return the property update with the new operation (this can be imported using importPropertyUpdate)
			return {
				key,
				operation: { ...newOp },
				vectorClock: Array.from(this.#vectorClock.entries())
			};
		} catch (error) {
			console.error(CONSOLE_PREFIX + `Failed to add operation for key "${String(key)}":`, error);
			return undefined;
		}
	}

	// Check if garbage collected can be performed & run it
	#checkGarbageCollection() {
		const MIN_GC_DELAY = 1000; // Minimum 1s delay between garbage collection runs
		const MIN_AGE_FOR_GC = 5000; // Garbage collect ops that are older than 5s

		try {
			if (Date.now() - this.#lastGCCheck < MIN_GC_DELAY) return;
			this.#lastGCCheck = Date.now();

			for (const [key, operations] of this.#keyOperations.entries()) {
				if (operations?.length < 5) continue; // Min op amount per key for garbage collection to run (otherwise not worth it)

				let retainCount = operations.length;
				operations.forEach((op, index) => {
					// Count how many ops, from last to latest, are older than the min-age in a row
					if (op.uuid && this.#opUuidTimestamp.has(op.uuid) && (Date.now() - this.#opUuidTimestamp.get(op.uuid)!) > MIN_AGE_FOR_GC) {
						const removeCount = index + 1;
						retainCount = operations.length - removeCount;
						this.#opUuidTimestamp.delete(op.uuid); // Remove from timestamps if set to be deleted
					}
				});

				if (retainCount < operations.length) {
					if (this.#debug) console.log(CONSOLE_PREFIX + `Running garbage collection for key ${String(key)} with current operations:`, operations);
					const retainOps = operations.slice(-retainCount); // Newest ops
					const removeOps = operations.slice(0, -retainCount); // Oldest ops (start =  idx 0, end = retainCount counted from right side)
					const baselineVectorClock = removeOps[removeOps.length - 1]?.vectorClock || []; // Use the vector clock from the last operation that we remove/overwrite

					// Calculate the value at the point where retained operations start
					let baselineValue = null;
					for (const op of removeOps) {
						if (!op.data) continue;
						baselineValue = this.#handleOperation(
							baselineValue,
							op.data.type,
							op.data.value,
							op.data.updateValue
						);
					}

					// Create a compact operation with baseline value and appropriate vector clock
					const compactOp = this.#createOperation({ type: 'set', value: baselineValue }, baselineVectorClock);

					// Debug log
					if (this.#debug) console.log(CONSOLE_PREFIX + 'Operations after garbage collection for this key:', [compactOp, ...retainOps]);

					// Combine compact op with retained operations
					this.#keyOperations.set(key, [compactOp, ...retainOps]);
				}
			}
		} catch (error) {
			console.error(CONSOLE_PREFIX + 'Error running garbage collection:', error);
		}
	}

	/** Create an operation object */
	#createOperation(data: Operation['data'], vectorClock: Operation['vectorClock']): Operation {
		const newOperation = {
			data,
			vectorClock,
			source: this.#replicaId,
			uuid: crypto.randomUUID()
		} satisfies Operation;
		this.#opUuidTimestamp.set(newOperation.uuid, Date.now());
		return newOperation;
	}

	/**
	 * Process a property's value by applying all operations and set it in the property store
	 */
	#processLocalProperty(key: keyof T) {
		try {
			const ops = this.#keyOperations.get(key);
			if (!ops?.length) return;

			// Apply all operations in order
			let value: unknown = null;

			for (const op of ops) {
				if (!op.data) continue;
				value = this.#handleOperation(
					value,
					op.data.type,
					op.data.value,
					op.data.updateValue
				);
			}

			this.#propertyStore[key] = value as T[keyof T]; // Save locally
		} catch (error) {
			console.error(CONSOLE_PREFIX + `Failed to process property for key ${String(key)}:`, error);
		}
	}

	/**
	 * Sort by vector clock (causal order)
	 * @returns Sorted operations
	 */
	#sortByVectorClock(operations: Operation[]) {
		return [...operations].sort((a, b) => {
			const clockA = new Map(a.vectorClock || []);
			const clockB = new Map(b.vectorClock || []);

			// First sort by causal relationship
			let aGreater = false, bGreater = false;

			const allIds = new Set([...clockA.keys(), ...clockB.keys()]);
			for (const id of allIds) {
				const countA = clockA.get(id) ?? 0;
				const countB = clockB.get(id) ?? 0;

				if (countA > countB) aGreater = true;
				if (countA < countB) bGreater = true;
			}

			// Determine causal relationship (if one is greater, and the other is smaller, it's clear)
			if (aGreater && !bGreater) return 1; // a happens after b
			if (!aGreater && bGreater) return -1; // a happens before b

			// Concurrent (unclear): Compare highest counter in each (sort by which one is ahead)
			const maxA = Math.max(...Array.from(clockA.values()), 0);
			const maxB = Math.max(...Array.from(clockB.values()), 0);
			if (maxA !== maxB) return maxA - maxB;

			// Final tiebreak: Sort by ID of Replica that actually generated the operation
			return a.source.localeCompare(b.source);
		});
	}

	/**
	 * Handle an operation
	 * @param [updateValue] - New value for ONLY for 'matching' operations
	 * @returns - Value after the operation
	 */
	#handleOperation(curValue: unknown, type: Operation['data']['type'], value: Operation['data']['value'], updateValue?: Operation['data']['updateValue']): unknown {
		try {
			// Deep copy to avoid reference issues in case value is or contains object(s)
			curValue = structuredClone(curValue);

			// Set operation
			if (type === 'set') return value;

			if (!type.startsWith('array')) {
				throw new Error(`Unsupported operation type: ${type}`);
			}

			if (!Array.isArray(curValue)) curValue = [] as object[]; // Auto-convert to array if current value isn't one

			let curValueArr = curValue as unknown[]; // Type assertion

			// Comparison function
			const isObject = (foo: unknown) => typeof foo === 'object' && foo !== null;
			const compare = (item: unknown) => {
				if (isObject(value) && isObject(item)) return JSON.stringify(item) === JSON.stringify(value); // Deep comparison
				return item === value; // Value comparison
			};

			switch (type) {
				case 'array-add':
					curValueArr.push(value);
					break;
				case 'array-add-unique':
					if (!curValueArr.some(compare)) curValueArr.push(value);
					break;
				case 'array-remove-matching':
					curValueArr = curValueArr.filter((item) => !compare(item));
					break;
				case 'array-update-matching':
					{
						const index = curValueArr.findIndex(compare);
						if (index !== -1) curValueArr[index] = updateValue;
					}
					break;
			}

			return curValueArr;
		} catch (error) {
			console.error(CONSOLE_PREFIX + `Failed to handle operation with curValue ${curValue}:`, error);
			return curValue;
		}
	}

	/**
	 * Remove HTML to prevent XSS and enforce size limits
	 * @returns Sanitized object
	 */
	#sanitizeValue(value: string | unknown[] | unknown): typeof value {
		// Check total serialized size
		const jsonString = JSON.stringify(value);
		if (jsonString?.length > 50000) throw new Error('Value too large!'); // 50KB limit

		if (typeof value === 'string') return (value.includes('<') || value.includes('>')) ? value.replace(/[<>]/g, '') : value;
		if (Array.isArray(value)) return value.map((item) => this.#sanitizeValue(item));
		if (value && typeof value === 'object') {
			return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.#sanitizeValue(v)]));
		}
		return value;
	}

	// Get property store
	get getPropertyStore(): T {
		try {
			return structuredClone(this.#propertyStore); // Return deep clone
		} catch {
			console.error(CONSOLE_PREFIX + 'Failed to parse property store');
			return {} as T;
		}
	}

	// Check for changes in the local property store from last property update
	get didPropertiesChange(): boolean {
		try {
			if (JSON.stringify(this.#propertyStore) !== JSON.stringify(this.#lastPropertyStore)) {
				this.#lastPropertyStore = structuredClone(this.#propertyStore);
				return true;
			}
		} catch { /** ignore */ }
		return false;
	}

	// Get state (can be imported using importState, converts the maps to arrays for serialization)
	get getState(): {vectorClock: [string, number][]; keyOperations: [keyof T, Operation[]][]} { // Replace with State<T> type?
		return {
			keyOperations: [...this.#keyOperations.entries()],
			vectorClock: [...this.#vectorClock.entries()]
		};
	}
}
