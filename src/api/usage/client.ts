/**
 * Internal HTTP client for Usage APIs
 */

import { Config } from "../../config";
import { NetraHttpClient } from "../http-client";

export class UsageHttpClient extends NetraHttpClient {
  constructor(config: Config) {
    super(config, "NETRA_USAGE_TIMEOUT", 10.0);
  }

  async getSessionUsage(
    sessionId: string,
    startTime?: string,
    endTime?: string
  ): Promise<any> {
    if (!this.isInitialized()) {
      console.error(
        `netra.usage: Usage client is not initialized; cannot fetch session usage '${sessionId}'`
      );
      return {};
    }

    const params: Record<string, string | undefined> = {};
    if (startTime) params.startTime = startTime;
    if (endTime) params.endTime = endTime;

    const response = await this.get(`/usage/sessions/${sessionId}`, params);
    return this.extractData(response, {});
  }

  async getTenantUsage(
    tenantId: string,
    startTime?: string,
    endTime?: string
  ): Promise<any> {
    if (!this.isInitialized()) {
      console.error(
        `netra.usage: Usage client is not initialized; cannot fetch tenant usage '${tenantId}'`
      );
      return {};
    }

    const params: Record<string, string | undefined> = {};
    if (startTime) params.startTime = startTime;
    if (endTime) params.endTime = endTime;

    const response = await this.get(`/usage/tenants/${tenantId}`, params);
    return this.extractData(response, {});
  }

  async listTraces(params: {
    startTime?: string;
    endTime?: string;
    traceId?: string;
    sessionId?: string;
    userId?: string;
    tenantId?: string;
    limit?: number;
    cursor?: string;
    direction?: string;
    sortField?: string;
    sortOrder?: string;
  }): Promise<any> {
    if (!this.isInitialized()) {
      console.error("netra.usage: Usage client is not initialized; cannot list traces");
      return {};
    }

    const payload: Record<string, any> = {};

    if (params.startTime) payload.startTime = params.startTime;
    if (params.endTime) payload.endTime = params.endTime;

    // Build filters array
    const filters: Array<{
      field: string;
      operator: string;
      type: string;
      value: string;
    }> = [];

    const filterMapping: Record<string, string | undefined> = {
      trace_id: params.traceId,
      session_id: params.sessionId,
      user_id: params.userId,
      tenant_id: params.tenantId,
    };

    for (const [field, value] of Object.entries(filterMapping)) {
      if (value !== undefined) {
        filters.push({
          field,
          operator: "equals",
          type: "string",
          value,
        });
      }
    }

    payload.filters = filters;

    // Build pagination object
    const pagination: Record<string, any> = {};
    if (params.limit !== undefined) pagination.limit = params.limit;
    if (params.cursor !== undefined) pagination.cursor = params.cursor;
    if (params.direction !== undefined) pagination.direction = params.direction;
    if (Object.keys(pagination).length > 0) {
      payload.pagination = pagination;
    }

    if (params.sortField !== undefined) payload.sortField = params.sortField;
    if (params.sortOrder !== undefined) payload.sortOrder = params.sortOrder;

    const response = await this.post("/sdk/traces", payload);
    return response.ok ? response.data : {};
  }

  async listSpansByTraceId(params: {
    traceId: string;
    cursor?: string;
    direction?: string;
    limit?: number;
    spanName?: string;
  }): Promise<any> {
    if (!this.isInitialized()) {
      console.error(
        `netra.usage: Usage client is not initialized; cannot list spans for trace '${params.traceId}'`
      );
      return {};
    }

    const queryParams: Record<string, string | number | undefined> = {};
    if (params.cursor !== undefined) queryParams.cursor = params.cursor;
    if (params.direction !== undefined) queryParams.direction = params.direction;
    if (params.limit !== undefined) queryParams.limit = params.limit;
    if (params.spanName !== undefined) queryParams.spanName = params.spanName;

    const response = await this.get(
      `/sdk/traces/${params.traceId}/spans`,
      queryParams
    );
    return response.ok ? response.data : {};
  }
}
