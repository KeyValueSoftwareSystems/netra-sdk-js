/**
 * Internal HTTP client for Evaluation APIs
 */

import { Config } from "../../config";
import { NetraHttpClient } from "../http-client";
import { EntryStatus, EvaluationScore, RunStatus } from "./models";

export class EvaluationHttpClient extends NetraHttpClient {
  constructor(config: Config) {
    super(config, "NETRA_EVALUATION_TIMEOUT", 10.0);
  }

  /**
   * Fetch dataset items for a dataset id
   */
  async getDataset(datasetId: string): Promise<any[]> {
    if (!this.isInitialized()) {
      console.error(
        `netra.evaluation: Evaluation client is not initialized; cannot fetch dataset '${datasetId}'`,
      );
      return [];
    }

    const response = await this.get(`/evaluations/dataset/${datasetId}`);
    return this.extractData(response, []);
  }

  /**
   * Create a run for a dataset
   */
  async createRun(
    name: string,
    datasetId?: string,
    evaluatorsConfig?: Record<string, any>[],
  ): Promise<any> {
    if (!this.isInitialized()) {
      console.error(
        `netra.evaluation: Evaluation client is not initialized; cannot create run for dataset '${datasetId}'`,
      );
      return { success: false };
    }

    const payload = {
      name,
      datasetId,
      localEvaluators: evaluatorsConfig,
    };
    const response = await this.post("/evaluations/test_run", payload);

    if (!response.ok) {
      return { success: false };
    }

    return this.extractData(response, { success: false });
  }

  /**
   * Create an empty dataset and return backend data
   */
  async createDataset(name: string, tags?: string[]): Promise<any> {
    if (!this.isInitialized()) {
      console.error(
        "netra.evaluation: Evaluation client is not initialized; cannot create dataset",
      );
      return { success: false };
    }

    const payload = {
      name,
      tags: tags ?? [],
    };

    const response = await this.post("/evaluations/dataset", payload);
    console.log("Response:", response);

    if (!response.ok) {
      return { success: false };
    }

    return this.extractData(response, { success: false });
  }

  /**
   * Add a single item to an existing dataset
   */
  async addDatasetItem(
    datasetId: string,
    itemPayload: Record<string, any>,
  ): Promise<any> {
    if (!this.isInitialized()) {
      console.error(
        `netra.evaluation: Evaluation client is not initialized; cannot add item to dataset '${datasetId}'`,
      );
      return { success: false };
    }

    const response = await this.post(
      `/evaluations/dataset/${datasetId}/items`,
      itemPayload,
    );

    if (!response.ok) {
      return { success: false };
    }

    return this.extractData(response, { success: false });
  }

  /**
   * Submit a new run item to the backend
   */
  async postRunItem(runId: string, payload: Record<string, any>): Promise<any> {
    if (!this.isInitialized()) {
      console.error(
        "netra.evaluation: Evaluation client is not initialized; cannot post run item",
      );
      return { success: false };
    }

    const response = await this.post(`/evaluations/run/${runId}/item`, payload);

    if (!response.ok) {
      return { success: false };
    }

    const data = this.extractData(response, { success: false });
    if (data && typeof data === "object" && "item" in data) {
      const runItem = data.item;
      if (runItem && typeof runItem === "object" && "id" in runItem) {
        return runItem.id;
      }
    }
    return data;
  }

  /**
   * Submit local evaluations result
   */
  async submitLocalEvaluations(
    runId: string,
    testRunItemId: string,
    evaluatorResults: Array<Record<string, any>>,
  ): Promise<any> {
    if (!this.isInitialized()) {
      console.error(
        "netra.evaluation: Evaluation client is not initialized; cannot submit local evaluations",
      );
      return { success: false };
    }

    const payload = { evaluatorResults };
    const response = await this.post(
      `/evaluations/run/${runId}/item/${testRunItemId}/local-evaluations`,
      payload,
    );

    if (!response.ok) {
      return { success: false };
    }

    return this.extractData(response, { success: false });
  }

  /**
   * Submit the run status
   */
  async postRunStatus(runId: string, status: string): Promise<any> {
    if (!this.isInitialized()) {
      console.error(
        "netra.evaluation: Evaluation client is not initialized; cannot post run status",
      );
      return { success: false };
    }

    const payload = { status };
    const response = await this.post(
      `/evaluations/run/${runId}/status`,
      payload,
    );

    if (!response.ok) {
      return { success: false };
    }

    const data = this.extractData(response, { success: false });
    if (data && typeof data === "object") {
      console.info("netra.evaluation: Completed test run successfully");
    }
    return data;
  }

  /**
   * Check if a span exists in the backend
   */
  async getSpanById(spanId: string): Promise<any> {
    if (!this.isInitialized()) {
      console.error(
        "netra.evaluation: Evaluation client is not initialized; cannot get span",
      );
      return null;
    }

    try {
      const response = await this.get(`sdk/traces/spans/${spanId}`);
      if (!response.ok) {
        return null;
      }
      return this.extractData(response, null);
    } catch {
      return null;
    }
  }

  /**
   * Wait until a span is available in the backend
   * Polls the GET /spans/:id endpoint to verify span availability before running evaluators
   */
  async waitForSpanIngestion(
    spanId?: string,
    timeoutSeconds: number = 60.0,
    pollIntervalSeconds: number = 1.0,
    initialDelaySeconds: number = 0.5,
  ): Promise<boolean> {
    if (!spanId) {
      return false;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, initialDelaySeconds * 1000),
    );

    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const spanData = await this.getSpanById(spanId);
      if (spanData !== null) {
        return true;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, pollIntervalSeconds * 1000),
      );
    }

    return false;
  }
}
