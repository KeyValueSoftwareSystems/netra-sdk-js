/**
 * Public Evaluation API
 * Exposed as Netra.evaluation
 */

import { Config } from "../../config";
import { EvaluationHttpClient } from "./client";
import { RunEntryContext } from "./context";
import {
  CreateDatasetParams,
  Dataset,
  DatasetEntry,
  DatasetItem,
  EntryStatus,
  EvaluationScore,
  EvaluatorFunction,
  Run,
  RunStatus,
  TaskFunction,
  TestSuiteResult,
} from "./models";

export class Evaluation {
  private config: Config;
  private client: EvaluationHttpClient;

  constructor(config: Config) {
    this.config = config;
    this.client = new EvaluationHttpClient(config);
  }

  /**
   * Create an empty dataset and return its id on success
   * @param params Dataset creation parameters
   * @returns The id of the created dataset, or null if creation fails
   */
  async createDataset(params: CreateDatasetParams): Promise<string | null> {
    if (!params.name) {
      console.error("netra.evaluation: Failed to create dataset via API: name is required");
      return null;
    }

    const response = await this.client.createDataset(
      params.name,
      params.tags,
      params.policyIds
    );

    const datasetId = response?.id;
    if (!datasetId) {
      console.error("netra.evaluation: Failed to create dataset");
      return null;
    }

    console.info(`netra.evaluation: Created dataset '${params.name}'`);
    return datasetId;
  }

  /**
   * Add a single item to an existing dataset
   * @param datasetId The id of the dataset to which the item will be added
   * @param item The dataset item to add
   * @returns The id of the added dataset item, or null if addition fails
   */
  async addDatasetEntry(
    datasetId: string,
    item: DatasetEntry
  ): Promise<string | null> {
    if (!item.input) {
      console.warn(
        `netra.evaluation: Skipping dataset item without required 'input'`
      );
      return null;
    }

    const itemPayload: Record<string, any> = {
      input: item.input,
    };

    if (item.expectedOutput !== undefined) {
      itemPayload.expectedOutput = item.expectedOutput;
    }
    if (item.tags) {
      itemPayload.tags = item.tags;
    }
    if (item.policyIds) {
      itemPayload.policyIds = item.policyIds;
    }

    const response = await this.client.addDatasetEntry(datasetId, itemPayload);
    const itemId = response?.id;

    if (itemId) {
      console.info(`netra.evaluation: Added dataset item '${itemId}' to dataset`);
    }

    return itemId ? String(itemId) : null;
  }

  /**
   * Get a dataset by ID
   * @param datasetId The id of the dataset to retrieve
   * @returns The dataset with the specified id
   */
  async getDataset(datasetId: string): Promise<Dataset> {
    const response = await this.client.getDataset(datasetId);
    const items: DatasetItem[] = [];

    for (const item of response) {
      const itemId = item?.id;
      const itemInput = item?.input;
      const itemDatasetId = item?.datasetId;

      if (!itemId || !itemInput || !itemDatasetId) {
        console.warn(
          "netra.evaluation: Skipping dataset item with missing required fields"
        );
        continue;
      }

      items.push({
        id: itemId,
        input: itemInput,
        datasetId: itemDatasetId,
        expectedOutput: item.expectedOutput,
      });
    }

    console.info(`netra.evaluation: Fetched dataset '${datasetId}' successfully`);
    return {
      datasetId,
      items,
    };
  }

  /**
   * Create a new run for the evaluation
   * @param dataset The dataset to which the run will be associated
   * @param name Optional name for the run
   * @returns The created run, or null if creation fails
   */
  async createRun(dataset: Dataset, name?: string): Promise<Run | null> {
    const runName = name ?? `run-${new Date().toISOString()}`;

    const response = await this.client.createRun(dataset.datasetId, runName);
    const runId = response?.id;

    if (!runId) {
      console.error(
        `netra.evaluation: Failed to create run for dataset '${dataset.datasetId}'`
      );
      return null;
    }

    console.info(`netra.evaluation: Created run '${runName}'`);
    return {
      id: String(runId),
      datasetId: dataset.datasetId,
      name: runName,
      testEntries: [...dataset.items],
    };
  }

  /**
   * Start a new run entry context
   * @param run The run to which the entry will be associated
   * @param entry The dataset item to be run
   * @returns The run entry context
   */
  runEntry(run: Run, entry: DatasetItem): RunEntryContext {
    return new RunEntryContext(this.client, this.config, run, entry);
  }

  /**
   * Record completion status for a run entry
   * @param ctx The run entry context
   * @param scores Optional list of scores to record
   */
  async record(ctx: RunEntryContext, scores?: EvaluationScore[]): Promise<void> {
    try {
      await this.client.postEntryStatus(
        ctx.run.id,
        ctx.entry.id,
        EntryStatus.AGENT_COMPLETED,
        ctx.traceId,
        undefined, // sessionId
        scores
      );
      console.info(
        `netra.evaluation: Run entry '${ctx.run.id}' for agent completed successfully`
      );
    } catch (error) {
      console.error(`netra.evaluation: Failed to POST agent_completed: ${error}`);
    }
  }

  /**
   * Run a test suite for the given dataset
   * @param name The name of the test suite
   * @param data The dataset to be used for the test suite
   * @param task The task to be executed for each dataset item
   * @param evaluators Optional list of evaluators to be used for the test suite
   * @param maxConcurrency The maximum number of concurrent tasks
   * @returns A result object containing the test suite results
   */
  async runTestSuite(
    name: string,
    data: Dataset,
    task: TaskFunction,
    evaluators?: EvaluatorFunction[],
    maxConcurrency: number = 50
  ): Promise<TestSuiteResult> {
    const run = await this.createRun(data, name);
    if (!run) {
      return { success: false, error: "failed_to_create_run" };
    }

    const results: Array<{
      id: string;
      input: string;
      output: any;
      status: string;
      error?: string;
    }> = [];

    // Process entries with concurrency limit
    const semaphore = new Semaphore(Math.max(1, maxConcurrency));

    const processEntry = async (entry: DatasetItem) => {
      await semaphore.acquire();

      let output: any = null;
      let status = "completed";
      let error: string | undefined;

      const ctx = this.runEntry(run, entry);

      try {
        await ctx.start();

        // Run the task
        output = await Promise.resolve(task(entry.input));

        // Collect scores
        const collectedScores: EvaluationScore[] = [];

        // Scores from task output
        if (output && typeof output === "object") {
          const scoresFromTask = output.scores ?? output.score;
          collectedScores.push(...this.normalizeScores(scoresFromTask));
        }

        // Scores from evaluators
        if (evaluators) {
          for (const evaluator of evaluators) {
            try {
              const evalResult = await Promise.resolve(
                evaluator({
                  input: entry.input,
                  output,
                  expectedOutput: entry.expectedOutput,
                })
              );
              collectedScores.push(...this.normalizeScores(evalResult));
            } catch (evalError) {
              console.debug(`netra.evaluation: evaluator error: ${evalError}`);
            }
          }
        }

        // Record completion
        await this.record(ctx, collectedScores.length > 0 ? collectedScores : undefined);
      } catch (err: any) {
        status = "failed";
        error = String(err);

        try {
          await this.client.postEntryStatus(
            run.id,
            entry.id,
            EntryStatus.FAILED,
            ctx.traceId
          );
        } catch (postError) {
          console.debug(
            `netra.evaluation: Failed to POST explicit failed status: ${postError}`
          );
        }
      } finally {
        semaphore.release();
      }

      return {
        id: entry.id,
        input: entry.input,
        output,
        status,
        error,
      };
    };

    // Process all entries concurrently
    const promises = run.testEntries.map((entry) => processEntry(entry));
    const processedResults = await Promise.all(promises);
    results.push(...processedResults);

    // Post final run status
    try {
      await this.client.postRunStatus(run.id, RunStatus.COMPLETED);
      console.info("netra.evaluation: Test suite completed successfully");
    } catch (error) {
      console.error(`netra.evaluation: Failed to POST final run status: ${error}`);
    }

    return {
      success: true,
      runId: run.id,
      results,
    };
  }

  private normalizeScores(
    obj: any
  ): EvaluationScore[] {
    const normalized: EvaluationScore[] = [];

    if (!obj) {
      return normalized;
    }

    if (this.isEvaluationScore(obj)) {
      normalized.push(obj);
    } else if (Array.isArray(obj)) {
      for (const item of obj) {
        if (this.isEvaluationScore(item)) {
          normalized.push(item);
        } else if (item && typeof item === "object") {
          const metricType = item.metricType ?? item.metric_type;
          const score = item.score;
          if (metricType !== undefined && score !== undefined) {
            normalized.push({
              metricType: String(metricType),
              score: Number(score),
            });
          }
        }
      }
    } else if (typeof obj === "object") {
      const metricType = obj.metricType ?? obj.metric_type;
      const score = obj.score;
      if (metricType !== undefined && score !== undefined) {
        normalized.push({
          metricType: String(metricType),
          score: Number(score),
        });
      }
    }

    return normalized;
  }

  private isEvaluationScore(obj: any): obj is EvaluationScore {
    return (
      obj &&
      typeof obj === "object" &&
      "metricType" in obj &&
      "score" in obj &&
      typeof obj.metricType === "string" &&
      typeof obj.score === "number"
    );
  }
}

/**
 * Simple semaphore for concurrency control
 */
class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    if (this.waiting.length > 0) {
      const next = this.waiting.shift();
      next?.();
    } else {
      this.permits++;
    }
  }
}
