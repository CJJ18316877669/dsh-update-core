/**
 * Serialises all writes to one result file and stores a snapshot at enqueue
 * time. Direct, overlapping writeFile calls can expose truncated JSON or let
 * an older progress update overwrite a newer terminal state.
 */
export class SerialJsonWriter {
  #queue = Promise.resolve();
  #lastError = null;

  constructor(file, writeJson, options = {}) {
    this.file = file;
    this.writeJson = writeJson;
    this.onError = options.onError || (() => {});
  }

  write(value) {
    const snapshot = JSON.parse(JSON.stringify(value));
    const operation = this.#queue.then(() => this.writeJson(this.file, snapshot));
    this.#queue = operation.catch((error) => {
      this.#lastError = error;
      this.onError(error);
    });
    return this.#queue;
  }

  async flush() {
    await this.#queue;
    if (this.#lastError) {
      const error = this.#lastError;
      this.#lastError = null;
      throw error;
    }
  }
}
