/**
 * API module exports
 */

// Usage API
export { Usage } from "./usage";
export type {
  ListSpansParams,
  ListTracesParams,
  SessionUsageData,
  SpansPage,
  TenantUsageData,
  TraceSpan,
  TracesPage,
  TraceSummary,
} from "./usage";

// Evaluation API
export {
  Evaluation,
  EntryStatus,
  RunStatus,
  RunEntryContext,
} from "./evaluation";
export type {
  CreateDatasetParams,
  Dataset,
  DatasetEntry,
  DatasetItem,
  EvaluationScore,
  EvaluatorFunction,
  Run,
  TaskFunction,
  TestSuiteResult,
} from "./evaluation";

// Dashboard API
export {
  Dashboard,
  Aggregation,
  ChartType,
  DimensionField,
  FilterField,
  FilterType,
  GroupBy,
  Measure,
  metadataField,
  Operator,
  Scope,
} from "./dashboard";
export type {
  CategoricalDataPoint,
  DashboardData,
  Dimension,
  DimensionValue,
  Filter,
  FilterConfig,
  Metrics,
  NumberResponse,
  QueryDataParams,
  QueryResponse,
  SessionDetailsResponse,
  SessionDetailsToolCall,
  SessionDetailsTrace,
  TimeRange,
  TimeSeriesDataPoint,
  TimeSeriesResponse,
  TimeSeriesWithDimension,
} from "./dashboard";

// Prompts API
export { Prompts, PROMPT_CACHE_TTL_SECONDS } from "./prompts";
export type { GetPromptParams, PromptResponse } from "./prompts";

// Models API
export { Models, MODEL_PRICING_CACHE_TTL_SECONDS } from "./models";
export type {
  GetModelPricingParams,
  ModelPrice,
  ModelPricing,
} from "./models";

// Red-team API
export {
  Redteam,
  RedteamAuthError,
  RedteamConfigError,
  RedteamGenerationError,
  RedteamGenerationTimeoutError,
  RedteamHttpClient,
  RedteamRunError,
  executeHandler as executeRedteamHandler,
} from "./redteam";
export type {
  ConversationTurn as RedteamConversationTurn,
  CreateRunResponse as RedteamCreateRunResponse,
  RedteamAgentHandler,
  RedteamAgentResponse,
  RedteamResult,
  RedteamRunOptions,
  RedteamRunStatus,
  RedteamTaskResult,
  RedteamTurnType,
  RiskScore as RedteamRiskScore,
  RunProgress as RedteamRunProgress,
  RunPromptItem as RedteamRunPromptItem,
  RunPromptsResponse as RedteamRunPromptsResponse,
  RunResultItem as RedteamRunResultItem,
  RunResultsPage as RedteamRunResultsPage,
} from "./redteam";
