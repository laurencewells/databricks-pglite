export class MutationsQuiescingError extends Error {
  constructor() {
    super("Database mutations are unavailable during shutdown");
    this.name = "MutationsQuiescingError";
  }
}

export class MutationDrain {
  #accepting = true;
  #active = 0;
  #drainWaiters: Array<() => void> = [];

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#accepting) throw new MutationsQuiescingError();
    this.#active += 1;
    try {
      return await operation();
    } finally {
      this.#active -= 1;
      if (this.#active === 0) {
        for (const resolve of this.#drainWaiters.splice(0)) resolve();
      }
    }
  }

  async quiesce(): Promise<void> {
    this.#accepting = false;
    if (this.#active === 0) return;
    await new Promise<void>((resolve) => this.#drainWaiters.push(resolve));
  }
}
