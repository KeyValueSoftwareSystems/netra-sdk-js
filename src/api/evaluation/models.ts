/**
 * Evaluation API Models
 */

export interface DatasetItem {
  id: string;
  input: string;
  datasetId: string;
  expectedOutput?: any;
}

export interface DatasetEntry {
  input: string;
  expectedOutput?: Record<string, any>;
  tags?: string[];
  policyIds?: string[];
}

export interface Dataset {
  datasetId: string;
  items: DatasetItem[];
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
  policyIds?: string[];
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

export type EvaluatorFunction = (params: {
  input: string;
  output: any;
  expectedOutput?: any;
}) => EvaluationScore | EvaluationScore[] | Promise<EvaluationScore | EvaluationScore[]>;

export type TaskFunction = (input: string) => any | Promise<any>;
