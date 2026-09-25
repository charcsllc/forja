/**
 * Log shapes of API v1 (`GET P/backend/dev/logs`, `GET P/backend/prod/logs`).
 *
 * Protects: dev logs are one text blob; prod logs follow a Cloudflare-like shape where
 * every field is optional (the UI normalises it in `lib/logs.ts`), so the prod schema
 * only pins the query and lets the payload through.
 */
import { z } from "zod";

export const DevLogsResultSchema = z.object({ logs: z.string() });
export type DevLogsResult = z.infer<typeof DevLogsResultSchema>;

/** Always send `from`, or only the last 6 h come back. */
export const ProdLogsQuerySchema = z.object({
  getOnlyLastLogs: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  regexSearch: z.string().optional(),
});
export type ProdLogsQuery = z.infer<typeof ProdLogsQuerySchema>;

export const ProdLogsResultSchema = z.record(z.string(), z.unknown());
export type ProdLogsResult = z.infer<typeof ProdLogsResultSchema>;
