export class InFlightOperations {
  #count = 0;
  #drainWaiters: Array<() => void> = [];

  /** Records one operation as in flight; the returned callback ends it and ignores later calls. */
  begin(): () => void {
    this.#count += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.#count -= 1;
      if (this.#count === 0) {
        for (const wake of this.#drainWaiters.splice(0)) wake();
      }
    };
  }

  drained(): Promise<void> {
    if (this.#count === 0) return Promise.resolve();
    return new Promise((resolve) => this.#drainWaiters.push(resolve));
  }
}
