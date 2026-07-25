import type { z } from "zod";

export class StateValidationError extends Error {
  override readonly name = "StateValidationError";
}

export class KvStateStore<T> {
  constructor(
    private readonly namespace: KVNamespace,
    private readonly key: string,
    private readonly schema: z.ZodType<T>,
  ) {}

  async get(): Promise<T | null> {
    const value: unknown = await this.namespace.get(this.key, "json");
    if (value === null) return null;

    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new StateValidationError(`Invalid state document at ${this.key}`);
    }
    return parsed.data;
  }

  async put(value: T): Promise<void> {
    const validated = this.schema.parse(value);
    await this.namespace.put(this.key, JSON.stringify(validated));
  }
}
