/**
 * Dashboard API Models
 */

export enum Scope {
  SPANS = "Spans",
  TRACES = "Traces",
}

export enum ChartType {
  LINE_TIME_SERIES = "Line Time Series",
  BAR_TIME_SERIES = "Bar Time Series",
  HORIZONTAL_BAR = "Horizontal Bar",
  VERTICAL_BAR = "Vertical Bar",
  PIE = "Pie",
  NUMBER = "Number",
}

export enum Measure {
  LATENCY = "Latency",
  ERROR_RATE = "Error Rate",
  PII_COUNT = "PII Count",
  REQUEST_COUNT = "Request Count",
  TOTAL_COST = "Total Cost",
  VIOLATIONS = "Violations",
  TOTAL_TOKENS = "Total Tokens",
  AUDIO_DURATION = "Audio Duration",
  CHARACTER_COUNT = "Character Count",
  CUSTOM = "Custom",
}

export enum Aggregation {
  AVERAGE = "Average",
  P50 = "p50",
  P90 = "p90",
  P95 = "p95",
  P99 = "p99",
  MEDIAN = "Median (p50)",
  PERCENTAGE = "Percentage",
  TOTAL_COUNT = "Total Count",
}

export enum GroupBy {
  DAY = "day",
  HOUR = "hour",
  MINUTE = "minute",
}

export enum DimensionField {
  ENVIRONMENT = "environment",
  SERVICE = "service",
  MODEL_NAME = "model_name",
}

export enum Operator {
  EQUALS = "equals",
  NOT_EQUALS = "not_equals",
  CONTAINS = "contains",
  NOT_CONTAINS = "not_contains",
  STARTS_WITH = "starts_with",
  ENDS_WITH = "ends_with",
  GREATER_THAN = "greater_than",
  LESS_THAN = "less_than",
  GREATER_EQUAL_TO = "greater_equal_to",
  LESS_EQUAL_TO = "less_equal_to",
  ANY_OF = "any_of",
  NONE_OF = "none_of",
}

export enum FilterType {
  STRING = "string",
  NUMBER = "number",
  BOOLEAN = "boolean",
  ARRAY_OPTIONS = "arrayOptions",
  OBJECT = "object",
}

export enum FilterField {
  TOTAL_COST = "total_cost",
  SERVICE = "service",
  TENANT_ID = "tenant_id",
  USER_ID = "user_id",
  SESSION_ID = "session_id",
  ENVIRONMENT = "environment",
  LATENCY = "latency",
  MODEL_NAME = "model_name",
  MODELS = "models",
  METADATA = "metadata",
}

export enum SessionFilterField {
  TENANT_ID = "tenant_id",
}

export enum SessionOperator {
  ANY_OF = "any_of",
}

export enum SessionFilterType {
  ARRAY = "arrayOptions",
}

export enum SortField {
  SESSION_ID = "session_id",
  START_TIME = "start_time",
  TOTAL_REQUESTS = "totalRequests",
  TOTAL_COST = "totalCost",
}

export enum SortOrder {
  ASC = "asc",
  DESC = "desc",
}

/**
 * Create a metadata filter field
 * @param key The metadata key to filter on
 * @returns The formatted metadata field string
 * @example
 * metadataField("customer_tier") // returns "metadata['customer_tier']"
 */
export function metadataField(key: string): string {
  return `metadata['${key}']`;
}

export interface Filter {
  field: FilterField | string;
  operator: Operator;
  type: FilterType;
  value: any;
  key?: string;
}

export interface Metrics {
  measure: Measure;
  aggregation: Aggregation;
  metricName?: string;
}

export interface Dimension {
  field: DimensionField;
}

export interface FilterConfig {
  startTime: string;
  endTime: string;
  groupBy: GroupBy;
  filters?: Filter[];
}

export interface TimeRange {
  startTime: string;
  endTime: string;
}

export interface TimeSeriesDataPoint {
  date: string;
  value: number;
}

export interface DimensionValue {
  dimension: string;
  value: number;
}

export interface TimeSeriesWithDimension {
  date: string;
  values: DimensionValue[];
}

export interface TimeSeriesResponse {
  timeSeries: TimeSeriesWithDimension[];
  dimensions: string[];
}

export interface CategoricalDataPoint {
  dimension: string;
  value: number;
}

export interface NumberResponse {
  value: number;
}

export type DashboardData =
  | TimeSeriesDataPoint[]
  | TimeSeriesResponse
  | CategoricalDataPoint[]
  | NumberResponse
  | Record<string, any>;

export interface QueryResponse {
  timeRange: TimeRange;
  data: DashboardData;
}

export interface QueryDataParams {
  scope: Scope;
  chartType: ChartType;
  metrics: Metrics;
  filter: FilterConfig;
  dimension?: Dimension;
}

//Sessions
export interface SessionFilter {
  field: SessionFilterField;
  operator: SessionOperator;
  type: SessionFilterType;
  value: string[];
}

export interface SessionStatsResult {
  data: SessionStatsData[];
  hasNextPage: boolean;
  nextCursor?: string;
}

export interface SessionFilterConfig {
  startTime: string;
  endTime: string;
  filters?: SessionFilter[];
}

export interface SessionStatsData {
  session_id: string;
  session_start_time: string;
  totalRequests: number;
  totalCost: number;
  session_duration: string;
  cursor: string;
}
