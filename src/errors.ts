export class WipStreamError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WipStreamError";
    this.code = code;
  }
}

export function fail(code: string, message: string): never {
  throw new WipStreamError(code, message);
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
