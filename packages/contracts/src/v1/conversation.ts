/**
 * Agent and conversation shapes of API v1: messages, history, `agent/status`, and the
 * `agent/start` request.
 *
 * Protects: the chat model of docs/research/02 §5. The UI deduplicates realtime
 * messages by `${createdAt}|${message.slice(0, 60)}`, so `createdAt` must be stable per
 * message; a build group runs `starting → building* → finished | error | limit-reached`.
 */
import { z } from "zod";
import { AgentProcessStatusSchema } from "./status";

export const MessageAuthorSchema = z.enum(["user", "agent"]);
export type MessageAuthor = z.infer<typeof MessageAuthorSchema>;

export const MessageTypeSchema = z.enum([
  "regular",
  "starting",
  "building",
  "finished",
  "error",
  "limit-reached",
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

/** A user attachment as persisted on a message (`files`) or sent to `agent/start`. */
export const AgentInputFileSchema = z.object({
  name: z.string(),
  url: z.string(),
  imageDescription: z.string(),
});
export type AgentInputFile = z.infer<typeof AgentInputFileSchema>;

/** One entry of `secretKeysNeeded`, keyed by variable name. */
export const SecretKeyRequestSchema = z.object({
  isProvided: z.boolean(),
  description: z.string(),
});
export type SecretKeyRequest = z.infer<typeof SecretKeyRequestSchema>;

export const ConversationMessageSchema = z.object({
  author: MessageAuthorSchema,
  /** Light markdown: **bold**, [text](url), `code`. */
  message: z.string(),
  messageType: MessageTypeSchema,
  /** ISO timestamp, strictly increasing per project (dedupe key). */
  createdAt: z.string(),
  /** On the final message of a run that produced a version. */
  versionId: z.string().optional(),
  secretKeysNeeded: z.record(z.string(), SecretKeyRequestSchema).optional(),
  /** Never emitted by the engine (05 §2.1); kept for Totalum parity. */
  gitDiffUrl: z.string().optional(),
  files: z.array(AgentInputFileSchema).optional(),
});
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

/** `GET P/agent/full-conversation`. `totalCount`/`hasMore` absent when not windowed. */
export const ConversationHistorySchema = z.object({
  conversation: z.array(ConversationMessageSchema),
  totalCount: z.number().int().optional(),
  hasMore: z.boolean().optional(),
});
export type ConversationHistory = z.infer<typeof ConversationHistorySchema>;

/** `GET P/agent/status`. `init` must be visible before `agent/start` answers. */
export const AgentStatusSchema = z.object({
  projectId: z.string(),
  status: AgentProcessStatusSchema,
  startedAt: z.string().nullable(),
  realtimeConversation: z.array(ConversationMessageSchema),
  creditsSpent: z.number().optional(),
  /** Whole minutes; an estimate, never a deadline. */
  expectedMinutes: z.number().nullish(),
  /** `startedAt + expectedMinutes`; `null` without an estimate. */
  expectedFinishAt: z.string().nullish(),
});
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentModelSchema = z.enum(["opus", "sonnet"]);
export type AgentModel = z.infer<typeof AgentModelSchema>;

export const AgentEffortSchema = z.enum(["low", "medium", "high", "xhigh"]);
export type AgentEffort = z.infer<typeof AgentEffortSchema>;

/** Per-run hints; only the keys the user changed are sent. */
export const AgentRunOptionsSchema = z.object({
  model: AgentModelSchema.optional(),
  effort: AgentEffortSchema.optional(),
  fastMode: z.boolean().optional(),
});
export type AgentRunOptions = z.infer<typeof AgentRunOptionsSchema>;

/** `POST P/agent/start`. The UI reads only `ok` from the answer. */
export const AgentStartRequestSchema = AgentRunOptionsSchema.extend({
  prompt: z.string().min(1),
  inputFiles: z.array(AgentInputFileSchema),
});
export type AgentStartRequest = z.infer<typeof AgentStartRequestSchema>;

/** `GET P/agent/full-conversation` query (the UI sends none today). */
export const ConversationQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  offsetFromEnd: z.coerce.number().int().nonnegative().optional(),
});
export type ConversationQuery = z.infer<typeof ConversationQuerySchema>;
