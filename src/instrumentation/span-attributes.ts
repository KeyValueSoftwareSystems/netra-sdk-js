// TODO: Replace this temporary implementation with the official OpenTelemetry GenAI semantic conventions
// when they are published for the JavaScript SDK.

export const SpanAttributes = {
  LLM_SYSTEM: "gen_ai.system",

  LLM_REQUEST_TYPE: "llm.request.type",
  LLM_REQUEST_MODEL: "gen_ai.request.model",
  LLM_REQUEST_MAX_TOKENS: "gen_ai.request.max_tokens",
  LLM_REQUEST_TEMPERATURE: "gen_ai.request.temperature",
  LLM_REQUEST_TOP_P: "gen_ai.request.top_p",
  LLM_REQUEST_REASONING: "gen_ai.request.reasoning",
  LLM_REQUEST_REASONING_EFFORT: "gen_ai.request.reasoning_effort",

  LLM_RESPONSE_MODEL: "gen_ai.response.model",

  LLM_USAGE_PROMPT_TOKENS: "gen_ai.usage.prompt_tokens",
  LLM_USAGE_COMPLETION_TOKENS: "gen_ai.usage.completion_tokens",
  LLM_USAGE_CACHE_READ_INPUT_TOKENS: "gen_ai.usage.cache_read_input_tokens",
  LLM_USAGE_REASONING_TOKENS: "gen_ai.usage.reasoning_tokens",
  LLM_USAGE_TOTAL_TOKENS: "llm.usage.total_tokens",

  LLM_FREQUENCY_PENALTY: "llm.frequency_penalty",
  LLM_PRESENCE_PENALTY: "llm.presence_penalty",
  LLM_CHAT_STOP_SEQUENCES: "llm.chat.stop_sequences",
  LLM_IS_STREAMING: "llm.is_streaming",
  LLM_COMPLETIONS: "gen_ai.completion",
  LLM_PROMPTS: "gen_ai.prompt",

  LLM_RESPONSE_DURATION: "llm.response.duration",
  LLM_PERFORMANCE_TTFT: "gen_ai.performance.time_to_first_token",
  LLM_PERFORMANCE_RELATIVE_TTFT: "gen_ai.performance.relative_time_to_first_token",
} as const;
