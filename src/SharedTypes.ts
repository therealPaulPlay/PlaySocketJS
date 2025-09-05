export type KeysWhereValueIsArray<T> = {
	[K in keyof T]: T[K] extends unknown[] ? K : never;
}[keyof T];
