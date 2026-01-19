/**
 * Evaluation API Models
 */

export interface DatasetEntry {
  id: string;
  input: string;
  datasetId: string;
  expectedOutput?: any;
}

export interface DatasetItem {
  input: any;
  expectedOutput?: any;
  metadata?: Record<string, any>;
  tags?: string[];
}

export interface DatasetRecord {
  id: string;
  input: any;
  datasetId: string;
  expectedOutput?: any;
}

export interface Dataset {
  items: DatasetItem[] | DatasetRecord[];
}

export interface Run {
  id: string;
  datasetId: string;
  name?: string;
  testEntries: DatasetItem[];
}

export interface EvaluationScore {
  metricType: string;
  score: number;
}

export enum EntryStatus {
  AGENT_TRIGGERED = "agent_triggered",
  AGENT_COMPLETED = "agent_completed",
  FAILED = "failed",
}

export enum RunStatus {
  COMPLETED = "completed",
}

export interface CreateDatasetParams {
  name: string;
  tags?: string[];
}

export interface TestSuiteResult {
  success: boolean;
  runId?: string;
  error?: string;
  results?: Array<{
    id: string;
    input: string;
    output: any;
    status: string;
    error?: string;
  }>;
}

export enum ScoreType {
  BOOLEAN = "boolean",
  NUMERICAL = "numerical",
  CATEGORICAL = "categorical",
}

export interface EvaluatorConfig {
  name: string;
  label: string;
  scoreType: ScoreType;
}

export interface AddDatasetItemResponse {
  datasetId: string;
  projectId: string;
  organizationId: string;
  source: string;
  input: any;
  expectedOutput?: any;
  isActive: boolean;
  tags?: string[];
  createdBy: string;
  updatedBy: string;
  updatedAt: string;
  sourceId?: string;
  metadata?: Record<string, any>;
  id: string;
  createdAt?: string;
  deletedAt?: string;
}

export interface ItemContext {
  index: number;
  itemInput: any;
  expectedOutput?: any;
  metadata?: any;
  datasetItemId?: string;
  traceId?: string;
  spanId?: string;
  sessionId?: string;
  taskOutput?: any;
  status?: string;
  testRunItemId?: string;
}

export interface CreateDatasetResponse {
  projectId: string;
  organizationId: string;
  name: string;
  tags?: string[];
  createdBy: string;
  updatedBy: string;
  updatedAt: string;
  id: string;
  createdAt: string;
  deletedAt?: string | null;
}

export interface GetDatasetItemsResponse {
  items: DatasetRecord[];
}

export interface LocalDataset {
  items: DatasetEntry[];
}

export interface EvaluatorContext {
  input: any;
  taskOutput: any;
  expectedOutput?: any;
  metadata?: Record<string, any>;
}

export interface EvaluatorOutput {
  evaluatorName: string;
  result: any;
  isPassed: boolean;
  reason?: string;
}

export type EvaluatorFunction = (params: {
  input: string;
  output: any;
  expectedOutput?: any;
}) =>
  | EvaluationScore
  | EvaluationScore[]
  | Promise<EvaluationScore | EvaluationScore[]>;

export type TaskFunction = (input: any) => any | Promise<any>;
