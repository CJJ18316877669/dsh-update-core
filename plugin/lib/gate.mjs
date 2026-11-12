/**
 * Synchronous single-flight gate. Acquisition must not happen after an await:
 * two HTTP requests otherwise both observe an idle gate.
 */
export class UpdateGate {
  #busy = false;

  get busy() {
    return this.#busy;
  }

  tryAcquire() {
    if (this.#busy) return false;
    this.#busy = true;
    return true;
  }

  release() {
    this.#busy = false;
  }
}
