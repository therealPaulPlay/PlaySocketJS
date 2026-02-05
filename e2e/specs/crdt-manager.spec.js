import { test, expect } from '@playwright/test';
import CRDTManager from '../../src/universal/crdtManager.js';
import { HEARTBEAT_INTERVAL } from '../../src/universal/constants.js';

test.describe('CRDTManager', () => {

    test('updateProperty with set stores correct value', () => {
        const crdt = new CRDTManager();
        crdt.updateProperty('score', 'set', 42);
        expect(crdt.getPropertyStore.score).toBe(42);
    });

    test('updateProperty with all array operations', () => {
        const crdt = new CRDTManager();
        crdt.updateProperty('items', 'set', []);

        crdt.updateProperty('items', 'array-add', 'apple');
        expect(crdt.getPropertyStore.items).toEqual(['apple']);

        crdt.updateProperty('items', 'array-add', 'banana');
        expect(crdt.getPropertyStore.items).toEqual(['apple', 'banana']);

        crdt.updateProperty('items', 'array-add-unique', 'apple'); // apple already exists in array
        expect(crdt.getPropertyStore.items).toEqual(['apple', 'banana']);

        crdt.updateProperty('items', 'array-add-unique', 'cherry');
        expect(crdt.getPropertyStore.items).toEqual(['apple', 'banana', 'cherry']);

        crdt.updateProperty('items', 'array-remove-matching', 'banana');
        expect(crdt.getPropertyStore.items).toEqual(['apple', 'cherry']);

        // array-update-matching with objects
        crdt.updateProperty('players', 'set', [{ id: 'a', score: 0 }]);
        crdt.updateProperty('players', 'array-update-matching', { id: 'a', score: 0 }, { id: 'a', score: 10 });
        expect(crdt.getPropertyStore.players).toEqual([{ id: 'a', score: 10 }]);
    });

    test('array operations on non-array, then set, then array again', () => {
        const crdt = new CRDTManager();

        // Start with a non-array value
        crdt.updateProperty('data', 'set', 'hello');
        expect(crdt.getPropertyStore.data).toBe('hello');

        // Array-add on non-array auto-converts to array
        crdt.updateProperty('data', 'array-add', 'world');
        expect(crdt.getPropertyStore.data).toEqual(['world']);

        crdt.updateProperty('data', 'array-add', 'foo');
        expect(crdt.getPropertyStore.data).toEqual(['world', 'foo']);

        // Set back to a primitive
        crdt.updateProperty('data', 'set', 42);
        expect(crdt.getPropertyStore.data).toBe(42);

        // Array operation again on the primitive
        crdt.updateProperty('data', 'array-add', 'bar');
        expect(crdt.getPropertyStore.data).toEqual(['bar']);
    });

    test('importPropertyUpdate merges operations correctly', () => {
        const crdt1 = new CRDTManager();
        const crdt2 = new CRDTManager();

        const update1 = crdt1.updateProperty('score', 'set', 10);
        crdt2.importPropertyUpdate(update1);

        expect(crdt2.getPropertyStore.score).toBe(10);
    });

    test('importPropertyUpdate merges into existing property', () => {
        const crdt1 = new CRDTManager();
        const crdt2 = new CRDTManager();

        // Both start with the same initial state
        const init = crdt1.updateProperty('items', 'set', ['a', 'b']);
        crdt2.importPropertyUpdate(init);
        expect(crdt2.getPropertyStore.items).toEqual(['a', 'b']);

        // crdt2 independently adds items
        crdt2.updateProperty('items', 'array-add', 'local1');
        crdt2.updateProperty('items', 'array-add', 'local2');

        // crdt1 independently adds items
        const r1 = crdt1.updateProperty('items', 'array-add', 'remote1');
        const r2 = crdt1.updateProperty('items', 'array-add', 'remote2');

        // Import crdt1's operations into crdt2
        crdt2.importPropertyUpdate(r1);
        crdt2.importPropertyUpdate(r2);

        // crdt2 should have all items merged
        const store = crdt2.getPropertyStore;
        expect(store.items).toContain('a');
        expect(store.items).toContain('b');
        expect(store.items).toContain('local1');
        expect(store.items).toContain('local2');
        expect(store.items).toContain('remote1');
        expect(store.items).toContain('remote2');
    });

    test('getState and importState round-trip preserves state', () => {
        const crdt1 = new CRDTManager();
        crdt1.updateProperty('name', 'set', 'test');
        crdt1.updateProperty('items', 'set', ['a', 'b']);
        crdt1.updateProperty('items', 'array-add', 'c');

        const state = crdt1.getState;
        const crdt2 = new CRDTManager();
        crdt2.importState(state);

        expect(crdt2.getPropertyStore).toEqual(crdt1.getPropertyStore);
        expect(crdt2.getPropertyStore.name).toBe('test');
        expect(crdt2.getPropertyStore.items).toEqual(['a', 'b', 'c']);
    });

    test('didPropertiesChange returns true after change, false when unchanged', () => {
        const crdt = new CRDTManager();
        crdt.updateProperty('x', 'set', 1);
        expect(crdt.didPropertiesChange).toBe(true);
        expect(crdt.didPropertiesChange).toBe(false); // no change since last check

        crdt.updateProperty('x', 'set', 2);
        expect(crdt.didPropertiesChange).toBe(true);
        expect(crdt.didPropertiesChange).toBe(false);

        // Same value set again
        crdt.updateProperty('x', 'set', 2);
        expect(crdt.didPropertiesChange).toBe(false);
    });

    test('getPropertyStore returns deep clone', () => {
        const crdt = new CRDTManager();
        crdt.updateProperty('data', 'set', { nested: { value: 1 } });

        const store1 = crdt.getPropertyStore;
        store1.data.nested.value = 999; // mutate the clone

        const store2 = crdt.getPropertyStore;
        expect(store2.data.nested.value).toBe(1); // original unaffected
    });

    test('vector clock sorting produces deterministic order', () => {
        const crdt1 = new CRDTManager();
        const crdt2 = new CRDTManager();

        // Create concurrent operations
        const update1 = crdt1.updateProperty('val', 'set', 'from1');
        const update2 = crdt2.updateProperty('val', 'set', 'from2');

        // Import both into a third manager
        const crdt3 = new CRDTManager();
        crdt3.importPropertyUpdate(update1);
        crdt3.importPropertyUpdate(update2);

        const crdt4 = new CRDTManager();
        crdt4.importPropertyUpdate(update2);
        crdt4.importPropertyUpdate(update1);

        // Both should converge to same value regardless of import order
        expect(crdt3.getPropertyStore.val).toBe(crdt4.getPropertyStore.val);
    });

    test('garbage collection compacts old operations while preserving value', async () => {
        const crdt = new CRDTManager();

        // Add 6 operations (above the min threshold of 5)
        for (let i = 0; i < 6; i++) {
            crdt.updateProperty('counter', 'set', i);
        }
        expect(crdt.getPropertyStore.counter).toBe(5);

        // Before GC: should have 6 operations for 'counter'
        const opsBefore = new Map(crdt.getState.keyOperations).get('counter');
        expect(opsBefore.length).toBe(6);

        // Wait for operations to become eligible for GC (>Heartbeat seconds old)
        await new Promise(r => setTimeout(r, HEARTBEAT_INTERVAL + 1000));

        // Trigger GC by adding another operation (GC runs on update)
        crdt.updateProperty('counter', 'set', 100);
        expect(crdt.getPropertyStore.counter).toBe(100);

        // After GC: old ops should be compacted (1 compact + 1 new = 2)
        const opsAfter = new Map(crdt.getState.keyOperations).get('counter');
        expect(opsAfter.length).toBeLessThan(opsBefore.length);
    });

    test('GC does not run with fewer than 5 operations', async () => {
        const crdt = new CRDTManager();
        crdt.updateProperty('x', 'set', 1);
        crdt.updateProperty('x', 'set', 2);
        crdt.updateProperty('x', 'set', 3);

        const opsBefore = new Map(crdt.getState.keyOperations).get('x');
        expect(opsBefore.length).toBe(3);

        await new Promise(r => setTimeout(r, HEARTBEAT_INTERVAL + 1000));

        crdt.updateProperty('x', 'set', 4);
        expect(crdt.getPropertyStore.x).toBe(4);

        // GC should NOT have run — still 4 ops (3 old + 1 new, below threshold)
        const opsAfter = new Map(crdt.getState.keyOperations).get('x');
        expect(opsAfter.length).toBe(4);
    });

    test('sanitization strips HTML tags from strings', () => {
        const crdt = new CRDTManager();
        crdt.updateProperty('msg', 'set', '<script>alert("xss")</script>');
        expect(crdt.getPropertyStore.msg).toBe('scriptalert("xss")/script');
    });

    test('sanitization enforces 50KB value limit', () => {
        const crdt = new CRDTManager();
        const largeValue = 'x'.repeat(60000);
        // Should throw or fail silently - value should not be stored
        crdt.updateProperty('big', 'set', largeValue);
        expect(crdt.getPropertyStore.big).toBeUndefined();
    });

    test('sanitization handles nested objects and arrays', () => {
        const crdt = new CRDTManager();
        crdt.updateProperty('nested', 'set', {
            text: '<b>bold</b>',
            arr: ['<i>italic</i>', { inner: '<div>test</div>' }]
        });
        const result = crdt.getPropertyStore.nested;
        expect(result.text).toBe('bbold/b');
        expect(result.arr[0]).toBe('iitalic/i');
        expect(result.arr[1].inner).toBe('divtest/div');
    });

    test('key limit of 100 is enforced on importPropertyUpdate', () => {
        const crdt1 = new CRDTManager();
        const crdt2 = new CRDTManager();

        // Fill up to 100 keys
        for (let i = 0; i < 100; i++) {
            crdt2.updateProperty(`key${i}`, 'set', i);
        }

        // 101st key via import should be rejected
        const update = crdt1.updateProperty('extraKey', 'set', 'overflow');
        crdt2.importPropertyUpdate(update);
        expect(crdt2.getPropertyStore.extraKey).toBeUndefined();
    });

    test('vector clock merging takes max of each replica counter', () => {
        const crdt1 = new CRDTManager();
        const crdt2 = new CRDTManager();

        crdt1.updateProperty('a', 'set', 1);
        crdt1.updateProperty('a', 'set', 2);
        crdt1.updateProperty('a', 'set', 3);

        crdt2.updateProperty('b', 'set', 10);

        const update = crdt1.updateProperty('a', 'set', 4);
        crdt2.importPropertyUpdate(update);

        // crdt2 should now have crdt1's clock value merged
        const state = crdt2.getState;
        const clockMap = new Map(state.vectorClock);
        
        // crdt1's replica should have counter 4 in crdt2's clock
        const crdt1ReplicaId = new Map(update.vectorClock).keys().next().value;
        expect(clockMap.get(crdt1ReplicaId)).toBeGreaterThanOrEqual(4);
    });
});
