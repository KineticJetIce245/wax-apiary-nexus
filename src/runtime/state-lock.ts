/**
 * One short, synchronous critical section for the PheromoneField.
 *
 * JavaScript cannot interleave synchronous work, so this is a contract check
 * and a re-entrancy guard rather than a queuing mutex: a state transaction must
 * never await, and the lock refuses a callback that returns a promise. A live
 * keeper of the lock is therefore never held across an activation, a native
 * prompt, or a guard wait.
 */
export class StateLock {
  private held = false;

  runSync<T>(action: () => T): T {
    if (this.held) {
      throw new Error('state lock is not re-entrant');
    }
    this.held = true;
    try {
      const result = action();
      if (typeof (result as { then?: unknown } | null)?.then === 'function') {
        throw new Error('state lock action must be synchronous');
      }
      return result;
    } finally {
      this.held = false;
    }
  }
}
