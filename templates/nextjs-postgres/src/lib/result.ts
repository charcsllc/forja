/**
 * Business outcomes are values, not exceptions. Use cases return `Result<T, E>`; route
 * handlers and server actions map the error class to an HTTP status (see `lib/http.ts`).
 * Throw only for programming errors and infrastructure failures.
 */
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E = DomainError> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(result: Result<T, E>): result is Ok<T> => result.ok;
export const isErr = <T, E>(result: Result<T, E>): result is Err<E> => !result.ok;

/** Base class for every expected failure. `code` is stable and machine-readable. */
export class DomainError extends Error {
  /** HTTP status a handler should answer with; 422 = a domain rule refused the request. */
  readonly status: number = 422;

  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  override readonly status = 400;
  constructor(message = "The request is not valid", details?: unknown) {
    super("VALIDATION", message, details);
  }
}

export class NotAuthenticatedError extends DomainError {
  override readonly status = 401;
  constructor(message = "You need to sign in") {
    super("NOT_AUTHENTICATED", message);
  }
}

export class ForbiddenError extends DomainError {
  override readonly status = 403;
  constructor(message = "You are not allowed to do this") {
    super("FORBIDDEN", message);
  }
}

export class NotFoundError extends DomainError {
  override readonly status = 404;
  constructor(message = "Not found") {
    super("NOT_FOUND", message);
  }
}

export class ConflictError extends DomainError {
  override readonly status = 409;
  constructor(message = "This conflicts with the current state", details?: unknown) {
    super("CONFLICT", message, details);
  }
}

export class RateLimitedError extends DomainError {
  override readonly status = 429;
  constructor(message = "Too many requests, try again later") {
    super("RATE_LIMITED", message);
  }
}
