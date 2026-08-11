/**
 * Mock for @anthropic-ai/sdk — intercepts Anthropic API calls at the module level.
 *
 * Usage in tests:
 *   import { mockAnthropicResponse, mockAnthropicError, resetAnthropicMock } from "../mocks/anthropic-api-mock";
 *
 *   // Set up a canned response
 *   mockAnthropicResponse({ text: '{"needs_reply": true, "reason": "Direct question"}' });
 *
 *   // Now any service that calls `anthropic.messages.create(...)` will get this response.
 */

export interface MockMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: Array<{ type: "text"; text: string }>;
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence";
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

// State for the mock
let responseQueue: Array<MockMessageResponse | Error> = [];
let defaultResponse: MockMessageResponse | null = null;
let capturedRequests: Array<{
  model: string;
  messages: unknown[];
  system?: unknown;
  max_tokens?: number;
  tools?: unknown[];
}> = [];

function buildResponse(
  text: string,
  model: string = "claude-sonnet-4-20250514",
): MockMessageResponse {
  return {
    id: `msg_mock_${Date.now()}`,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 0,
    },
  };
}

/**
 * Set a canned text response. All subsequent calls to messages.create() return this.
 */
export function mockAnthropicResponse(opts: { text: string; model?: string }): void {
  defaultResponse = buildResponse(opts.text, opts.model);
}

/**
 * Queue multiple responses (consumed in order). Falls back to defaultResponse when exhausted.
 */
export function queueAnthropicResponses(responses: Array<{ text: string; model?: string }>): void {
  for (const r of responses) {
    responseQueue.push(buildResponse(r.text, r.model));
  }
}

/**
 * Queue an error to be thrown on the next call.
 */
export function mockAnthropicError(error: Error): void {
  responseQueue.push(error);
}

/**
 * Get all captured request payloads.
 */
export function getCapturedRequests(): typeof capturedRequests {
  return [...capturedRequests];
}

type CapturedContentBlock = { type: string; text?: string };

function firstUserBlocks(index: number): CapturedContentBlock[] {
  const req = capturedRequests[index];
  if (!req) throw new Error(`No captured request at index ${index}`);
  const messages = req.messages as Array<{ role: string; content: unknown }>;
  const first = messages.find((m) => m.role === "user");
  if (!first) throw new Error(`Captured request ${index} has no user message`);
  return typeof first.content === "string"
    ? [{ type: "text", text: first.content }]
    : (first.content as CapturedContentBlock[]);
}

/**
 * The instruction text as the model actually receives it.
 *
 * llm-service folds `system` into the leading content block of the first user
 * message (gateways that bridge to the Claude Code CLI drop `system` outright),
 * so assertions about the prompt read from there rather than from `.system`.
 */
export function getSentInstructions(index = 0): string {
  return firstUserBlocks(index)[0]?.text ?? "";
}

/** Every text block of the first user message, joined — instructions plus the
 *  email payload that follows them. */
export function getSentUserText(index = 0): string {
  return firstUserBlocks(index)
    .map((b) => b.text ?? "")
    .join("\n");
}

/**
 * Reset all mock state.
 */
export function resetAnthropicMock(): void {
  responseQueue = [];
  defaultResponse = null;
  capturedRequests = [];
}

/**
 * Mock Anthropic class that replaces the real SDK.
 * Services create `new Anthropic()` and call `this.anthropic.messages.create(...)`.
 */
export class MockAnthropic {
  messages = {
    create: async (params: {
      model: string;
      messages: unknown[];
      system?: unknown;
      max_tokens?: number;
      tools?: unknown[];
    }): Promise<MockMessageResponse> => {
      capturedRequests.push(params);

      // Dequeue first, fall back to default
      if (responseQueue.length > 0) {
        const next = responseQueue.shift()!;
        if (next instanceof Error) throw next;
        return next;
      }

      if (defaultResponse) {
        return defaultResponse;
      }

      // No response configured — fail loudly
      throw new Error(
        "[MockAnthropic] No response configured. Call mockAnthropicResponse() or queueAnthropicResponses() before invoking services.",
      );
    },
  };
}
