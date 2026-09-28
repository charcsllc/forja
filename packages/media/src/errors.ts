/**
 * Errors thrown by `ImageSourcingPort.find`.
 *
 * Protects: the agent runtime can tell "nothing usable was found" (the imagery role then
 * makes a placeholder) from "the request was malformed" and "the run was cancelled"
 * without parsing messages. Messages never contain keys or full provider URLs with keys.
 */
export type ImageSourcingErrorCode = "invalid_request" | "not_found" | "aborted";

export class ImageSourcingError extends Error {
  readonly code: ImageSourcingErrorCode;
  /** One line per provider or candidate that was tried and why it was not used. */
  readonly attempts: string[];
  constructor(code: ImageSourcingErrorCode, message: string, attempts: string[] = []) {
    super(message);
    this.name = "ImageSourcingError";
    this.code = code;
    this.attempts = attempts;
  }
}
