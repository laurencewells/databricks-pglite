import { AsyncMutex } from "../async-mutex.js";

export class SidecarExecutionBarrier {
  readonly #mutex = new AsyncMutex();

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.#mutex.runExclusive(operation);
  }
}

export function createSocketDatabaseAdapter<T extends object>(
  database: T,
  barrier: SidecarExecutionBarrier,
): T & {
  runExclusive<TResult>(operation: () => Promise<TResult>): Promise<TResult>;
} {
  return new Proxy(database, {
    get(target, property) {
      if (property === "runExclusive") {
        return <TResult>(operation: () => Promise<TResult>) =>
          barrier.runExclusive(operation);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T & {
    runExclusive<TResult>(operation: () => Promise<TResult>): Promise<TResult>;
  };
}
