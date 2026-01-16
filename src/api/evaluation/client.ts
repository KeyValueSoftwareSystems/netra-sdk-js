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
        `netra.evaluation: Evaluation client is not initialized; cannot fetch dataset '${datasetId}'`
      );
      return [];
    }

    const response = await this.get(`/evaluations/dataset/${datasetId}`);
    return this.extractData(response, []);
  }

  /**
   * Create a run for a dataset
   */
  async createRun(datasetId: string, name: string): Promise<any> {
    if (!this.isInitialized()) {
      console.error(
        `netra.evaluation: Evaluation client is not initialized; cannot create run for dataset '${datasetId}'`
      );
      return { success: false };
    }

    const response = await this.post(`/evaluations/run/dataset/${datasetId}`, {
      name,
    });

    if (!response.ok) {
      return { success: false };
    }

    return this.extractData(response, { success: false });
  }

  /**
   * Create an empty dataset and return backend data
   */
  async createDataset(
    name: string,
    tags?: string[],
    policyIds?: string[]
  ): Promise<any> {
    if (!this.isInitialized()) {
      console.error(
        "netra.evaluation: Evaluation client is not initialized; cannot create dataset"
      );
      return { success: false };
    }

    const payload = {
      name,
      tags: tags ?? [],
      policyIds: policyIds ?? [],
    };

    const response = await this.post("/evaluations/dataset", payload);

    if (!response.ok) {
      return { success: false };
    }

    return this.extractData(response, { success: false });
  }

  /**
   * Add a single item to an existing dataset
   */
  async addDatasetEntry(
    datasetId: string,
    itemPayload: Record<string, any>
  ): Promise<any> {
    if (!this.isInitialized()) {
      console.error(
        `netra.evaluation: Evaluation client is not initialized; cannot add item to dataset '${datasetId}'`
      );
      return { success: false };
    }

    const response = await this.post(
      `/evaluations/dataset/${datasetId}/items`,
      itemPayload
    );

    if (!response.ok) {
      return { success: false };
    }

    return this.extractData(response, { success: false });
  }

  /**
   * Post per-entry status
   */
  async postEntryStatus(
    runId: string,
    testId: string,
    status: EntryStatus,
    traceId?: string,
    sessionId?: string,
    scores?: EvaluationScore[]
  ): Promise<void> {
    if (!this.isInitialized()) {
      console.error(
        `netra.evaluation: Evaluation client is not initialized; cannot post status '${status}' for run '${runId}' test '${testId}'`
      );
      return;
    }

    const payload: Record<string, any> = {
      status,
      traceId: traceId ?? null,
      sessionId: sessionId ?? null,
    };

    // Include score objects when provided
    if (scores && scores.length > 0) {
      const normalizedScores: Array<{ metric: string; score: number }> = [];
      for (const score of scores) {
        if (score && score.metricType && score.score !== undefined) {
          normalizedScores.push({
            metric: score.metricType,
            score: score.score,
          });
        }
      }
      payload.metrics = normalizedScores;
    } else {
      payload.metrics = [];
    }

    const response = await this.post(
      `/evaluations/run/${runId}/test/${testId}`,
      payload
    );

    if (!response.ok) {
      console.error(
        `netra.evaluation: Failed to post status '${status}' for run '${runId}' test '${testId}'`
      );
    }
  }

  /**
   * Post final run status
   */
  async postRunStatus(runId: string, status: RunStatus): Promise<void> {
    if (!this.isInitialized()) {
      console.error(
        `netra.evaluation: Evaluation client is not initialized; cannot post run status '${status}' for run '${runId}'`
      );
      return;
    }

    const response = await this.post(`/evaluations/run/${runId}/status`, {
      status,
    });

    if (!response.ok) {
      console.error(
        `netra.evaluation: Failed to post run status '${status}' for run '${runId}'`
      );
    }
  }
}
