// Minimal Bun test typings so the test tsconfig can type-check without a bun-types dependency.
declare module "bun:test" {
  type Awaitable<T> = T | Promise<T>;

  interface Matchers<T> {
    toBe(expected: T): void;
    toBeCloseTo(expected: number, precision?: number): void;
    toBeGreaterThan(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeUndefined(): void;
    toEqual(expected: unknown): void;
  }

  export function describe(name: string, fn: () => Awaitable<void>): void;
  export function test(name: string, fn: () => Awaitable<void>): void;
  export function afterEach(fn: () => Awaitable<void>): void;
  export function expect<T>(actual: T): Matchers<T>;
}
