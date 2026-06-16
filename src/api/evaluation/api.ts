/**
 * Public Evaluation API
 * Exposed as Netra.evaluation
 */

import { Config } from "../../config";
import { Logger } from "../../logger";
import { SpanWrapper } from "../../span-wrapper";
import { EvaluationHttpClient } from "./client";
import {
  AddDatasetItemResponse,
  CreateDatasetResponse,
  Dataset,
  DatasetEntry,
  DatasetRecord,
  EvaluatorConfig,
  GetDatasetItemsResponse,
  ItemContext,
  TaskFunction,
} from "./models";
import {
  buildEvaluatorsConfig,
  buildItemPayload,
  executeTask,
  extractDatasetId,
  formatSpanId,
  formatTraceId,
  getSessionIdFromBaggage,
  runSingleEvaluator,
  validateRunInputs,
} from "./utils";

/**
 * Public entry-point exposed as Netra.evaluation
 */
export class Evaluation {
  private config: Config;
  private client: EvaluationHttpClient;

  constructor(config: Config) {
    this.config = config;
    this.client = new EvaluationHttpClient(this.config);
  }

  /**
   * Create an empty dataset and return its id on success, else null
   * @param name The name of the dataset
   * @param tags Optional list of tags to associate with the dataset
   * @returns A backend JSON response containing dataset info (id, name, tags, etc.) on success
   */
  async createDataset(
    name: string,
    tags?: string[],
  ): Promise<CreateDatasetResponse | null> {
    if (!name) {
      Logger.error(
        "netra.evaluation: Failed to create dataset: dataset name is required",
      );
      return null;
    }

    const response = await this.client.createDataset(name, tags);

    if (!response) {
      return null;
    }

    return {
      projectId: response.projectId ?? "",
      organizationId: response.organizationId ?? "",
      name: response.name ?? "",
      tags: response.tags ?? [],
      createdBy: response.createdBy ?? "",
      updatedBy: response.updatedBy ?? "",
      updatedAt: response.updatedAt ?? "",
      id: response.id ?? "",
      createdAt: response.createdAt ?? "",
      deletedAt: response.deletedAt ?? null,
    };
  }

  /**
   * Add a single item to an existing dataset
   * @param datasetId The id of the dataset to which the item will be added
   * @param item The dataset item to add
   * @returns A backend JSON response containing dataset item info (id, input, expectedOutput, etc.) on success
   */
  async addDatasetItem(
    datasetId: string,
    item: DatasetEntry,
  ): Promise<AddDatasetItemResponse | null> {
    if (!item.input) {
      Logger.error(
        "netra.evaluation: Skipping dataset item without required 'input'",
      );
      return null;
    }

    const response = await this.client.addDatasetItem(datasetId, item);

    return {
      datasetId: response.datasetId ?? "",
      projectId: response.projectId ?? "",
      organizationId: response.organizationId ?? "",
      source: response.source ?? "",
      input: response.input ?? "",
      expectedOutput: response.expectedOutput ?? "",
      isActive: true,
      tags: response.tags ?? [],
      createdBy: response.createdBy ?? "",
      updatedBy: response.updatedBy ?? "",
      updatedAt: response.updatedAt ?? "",
      sourceId: response.sourceId ?? null,
      metadata: response.metadata ?? null,
      id: response.id ?? "",
      createdAt: response.createdAt ?? "",
      deletedAt: response.deletedAt ?? null,
    };
  }

  /**
   * Get a dataset by ID
   * @param datasetId The id of the dataset to retrieve
   * @returns A backend JSON response containing dataset info (id, input, expectedOutput etc.) on success
   */
  async getDataset(datasetId: string): Promise<GetDatasetItemsResponse | null> {
    if (!datasetId) {
      Logger.error(
        "netra.evaluation: Failed to get dataset: dataset id is required",
      );
      return null;
    }

    const response = await this.client.getDataset(datasetId);
    if (!response) {
      return null;
    }

    const datasetItems: DatasetRecord[] = [];
    for (const item of response) {
      const itemId = item?.id;
      const itemInput = item?.input;
      const itemDatasetId = item?.datasetId;

      if (itemId == null || itemDatasetId == null || itemInput == null) {
        Logger.warn(
          "netra.evaluation: Skipping dataset item with missing required fields:",
          item,
        );
        continue;
      }

      try {
        datasetItems.push({
          id: itemId,
          input: itemInput,
          datasetId: itemDatasetId,
          expectedOutput: item?.expectedOutput ?? "",
        });
      } catch (exc) {
        Logger.error("netra.evaluation: Failed to parse dataset item:", exc);
      }
    }

    return { items: datasetItems };
  }

  /**
   * Create a new run for the given dataset and evaluators
   * @param name The name of the run
   * @param datasetId The id of the dataset to which the run will be associated
   * @param evaluatorsConfig Optional list of evaluators to be used for the run
   * @returns runId: The id of the created run
   */
  async createRun(
    name: string,
    datasetId?: string,
    evaluatorsConfig?: EvaluatorConfig[],
  ): Promise<string | null> {
    if (!name) {
      Logger.error(
        "netra.evaluation: Failed to create run: run name is required",
      );
      return null;
    }

    const evaluatorsConfigDicts: Array<Record<string, any>> | undefined =
      evaluatorsConfig?.map((e) => ({
        name: e.name,
        label: e.label,
        scoreType: e.scoreType,
      }));

    const response = await this.client.createRun(
      name,
      datasetId,
      evaluatorsConfigDicts,
    );
    const runId = response?.id ?? null;
    return runId;
  }

  /**
   * Fetch test run results based on run ID
   * @param runId The id of the run to fetch
   * @returns The run results data
   */
  async getRunResults(runId: string): Promise<any> {
    if (!runId) {
      Logger.error(
        "netra.evaluation: Failed to get run: run_id is required",
      );
      return null;
    }

    const response = await this.client.getRunResults(runId);
    return response;
  }

  /**
   * Netra evaluation function to initiate a test suite
   * @param name The name of the run
   * @param data The dataset to be used for the test suite
   * @param task The task to be executed for each item in the dataset
   * @param evaluators Optional list of evaluators to be used for the test suite
   * @param maxConcurrency The maximum number of concurrent tasks to be executed
   * @returns A dictionary containing the run id and the results of the test suite
   */
  runTestSuite(
    name: string,
    data: Dataset,
    task: TaskFunction,
    evaluators?: any[],
    maxConcurrency: number = 50,
  ): Promise<Record<string, any> | null> {
    return this.runTestSuiteAsync(name, data, task, evaluators, maxConcurrency);
  }

  /**
   * Async implementation of runTestSuite
   * @param name The name of the run
   * @param data The dataset to be used for the test suite
   * @param task The task to be executed for each item in the dataset
   * @param evaluators Optional list of evaluators to be used for the test suite
   * @param maxConcurrency The maximum number of concurrent tasks to be executed
   * @returns items: The results of the test suite
   */
  private async runTestSuiteAsync(
    name: string,
    data: Dataset,
    task: TaskFunction,
    evaluators: any[] | undefined,
    maxConcurrency: number,
  ): Promise<Record<string, any> | null> {
    if (!validateRunInputs(name, data, task)) {
      return null;
    }

    const items = [...data.items];
    const totalItems = items.length;
    const datasetId = extractDatasetId(items);
    const evaluatorsConfig = buildEvaluatorsConfig(evaluators);

    const runId = await this.createRun(
      name,
      datasetId ?? undefined,
      evaluatorsConfig,
    );
    if (!runId) {
      Logger.error("netra.evaluation: Failed to create run");
      return null;
    }
    Logger.info("netra.evaluation: Initiated test run");

    const semaphore = new Semaphore(Math.max(1, maxConcurrency));
    const results: Array<Record<string, any>> = [];
    const bgEvalTasks: Promise<void>[] = [];
    let completedItems = 0;

    const processItem = async (idx: number, item: any): Promise<void> => {
      await semaphore.acquire();
      try {
        const ctx = this.createItemContext(idx, item);
        const itemResult = await this.executeItemPipeline(
          runId,
          name,
          ctx,
          task,
          evaluators,
          results,
          bgEvalTasks,
        );

        completedItems += 1;
        Logger.info(
          `netra.evaluation: ${completedItems}/${totalItems} items processed (status=${itemResult.status})`,
        );
      } finally {
        semaphore.release();
      }
    };

    await Promise.all(items.map((item, i) => processItem(i, item)));

    if (bgEvalTasks.length > 0) {
      await Promise.allSettled(bgEvalTasks);
    }

    this.client.postRunStatus(runId, "completed");
    return { runId, items: results };
  }

  /**
   * Create an ItemContext from a dataset item
   * @param idx The index of the item
   * @param item The dataset item
   * @returns ItemContext: The created ItemContext
   */
  private createItemContext(idx: number, item: any): ItemContext {
    // Check if item is a DatasetRecord (has datasetId property)
    if (this.isDatasetRecord(item)) {
      return {
        index: idx,
        itemInput: item.input,
        expectedOutput: item.expectedOutput,
        datasetItemId: item.id,
      };
    }

    return {
      index: idx,
      itemInput: item.input,
      expectedOutput: item.expectedOutput,
      metadata: item.metadata,
    };
  }

  /**
   * Type guard for DatasetRecord
   */
  private isDatasetRecord(item: any): item is DatasetRecord {
    return (
      item != null &&
      typeof item === "object" &&
      "datasetId" in item &&
      typeof item.datasetId === "string"
    );
  }

  /**
   * Execute the full pipeline for a single item
   * @param runId The run ID
   * @param runName The name of the run
   * @param ctx The item context
   * @param task The task function to execute
   * @param evaluators Optional list of evaluators
   * @param results List to append results to
   * @param bgEvalTasks List to append background evaluation tasks to
   */
  private async executeItemPipeline(
    runId: string,
    runName: string,
    ctx: ItemContext,
    task: TaskFunction,
    evaluators: any[] | undefined,
    results: Array<Record<string, any>>,
    bgEvalTasks: Promise<void>[],
  ): Promise<{ status: string }> {
    const spanName = `TestRun.${runName}`;

    const span = new SpanWrapper(spanName, {}, "netra.evaluation");
    span.start();

    try {
      const otelSpan = span.getCurrentSpan();
      if (otelSpan) {
        const spanContext = otelSpan.spanContext();
        ctx.traceId = formatTraceId(spanContext.traceId);
        ctx.spanId = formatSpanId(spanContext.spanId);
      }
      ctx.sessionId = getSessionIdFromBaggage();

      const { output, status } = await span.withActive(() =>
        executeTask(task, ctx.itemInput),
      );
      ctx.taskOutput = output;
      ctx.status = status;

      ctx.testRunItemId = await span.withActive(() =>
        this.postCompletedStatus(runId, ctx),
      );

      if (evaluators && ctx.status === "completed") {
        const evalTask = this.runEvaluatorsForItem(runId, ctx, evaluators);
        bgEvalTasks.push(evalTask);
      }

      results.push({
        index: ctx.index,
        status: ctx.status,
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        testRunItemId: ctx.testRunItemId,
      });

      return { status: ctx.status ?? "pending" };
    } finally {
      span.end();
    }
  }

  /**
   * Post agent_triggered status and return testRunItemId
   * @param runId The run ID
   * @param ctx The item context
   * @returns str: The testRunItemId
   */
  private async postTriggeredStatus(
    runId: string,
    ctx: ItemContext,
  ): Promise<string> {
    const payload = buildItemPayload(ctx, "agent_triggered");
    const response = await this.client.postRunItem(runId, payload);

    if (response && typeof response === "object") {
      const itemId = response.id ?? response.testRunItemId;
      if (itemId) {
        return String(itemId);
      }
    }
    return `local-${ctx.index}`;
  }

  /**
   * Post completed/failed status with task output
   * @param runId The run ID
   * @param ctx The item context
   */
  private async postCompletedStatus(
    runId: string,
    ctx: ItemContext,
  ): Promise<any> {
    const payload = buildItemPayload(ctx, ctx.status ?? "pending", true);
    const runItemId = await this.client.postRunItem(runId, payload);
    return runItemId;
  }

  /**
   * Run all evaluators for a single item after span ingestion
   * @param runId The run ID
   * @param ctx The item context
   * @param evaluators List of evaluators
   */
  private async runEvaluatorsForItem(
    runId: string,
    ctx: ItemContext,
    evaluators: any[],
  ): Promise<void> {
    await this.client.waitForSpanIngestion(ctx.spanId);

    const evaluatorResults: Array<Record<string, any>> = [];
    for (const evaluator of evaluators) {
      try {
        const result = await runSingleEvaluator({
          evaluator,
          itemInput: ctx.itemInput,
          taskOutput: ctx.taskOutput,
          expectedOutput: ctx.expectedOutput,
          metadata: ctx.metadata,
        });

        if (result) {
          evaluatorResults.push(result);
        }
      } catch {
        continue;
      }
    }

    if (evaluatorResults.length > 0 && ctx.testRunItemId) {
      this.client.submitLocalEvaluations(
        runId,
        ctx.testRunItemId,
        evaluatorResults,
      );
    }
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

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
