import { NextResponse } from "next/server";
import { type DomainError, type Result } from "@/lib/result";
import { logger } from "@/lib/logger";

/** JSON error shape for every API route: `{ error: { code, message, details? } }`. */
export function errorResponse(error: DomainError): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    },
    { status: error.status },
  );
}

/** Map a use-case result to a response: 200 (or `status`) with the value, or the error's status. */
export function resultResponse<T>(result: Result<T, DomainError>, status = 200): NextResponse {
  return result.ok ? NextResponse.json(result.value, { status }) : errorResponse(result.error);
}

/** Last-resort handler for unexpected failures: log with a correlation id, answer 500. */
export function unexpectedErrorResponse(error: unknown): NextResponse {
  const correlationId = crypto.randomUUID();
  logger.error({ err: error, correlationId }, "unexpected error");
  return NextResponse.json(
    { error: { code: "INTERNAL", message: "Something went wrong", details: { correlationId } } },
    { status: 500 },
  );
}
