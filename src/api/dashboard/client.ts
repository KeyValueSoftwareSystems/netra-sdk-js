/**
 * Internal HTTP client for Dashboard APIs
 */

import { Config } from "../../config";
import { NetraHttpClient } from "../http-client";
import {
  ChartType,
  Dimension,
  FilterConfig,
  Metrics,
  Scope,
} from "./models";

export class DashboardHttpClient extends NetraHttpClient {
  constructor(config: Config) {
    super(config, "NETRA_DASHBOARD_TIMEOUT", 30.0);
  }

  /**
   * Execute a dynamic query for dashboards
   */
  async queryData(
    scope: Scope,
    chartType: ChartType,
    metrics: Metrics,
    filter: FilterConfig,
    dimension?: Dimension
  ): Promise<any> {
    if (!this.isInitialized()) {
      console.error(
        "netra.dashboard: Dashboard client is not initialized; cannot execute query"
      );
      return null;
    }

    const payload: Record<string, any> = {
      scope: scope,
      chartType: chartType,
      metrics: {
        measure: metrics.measure,
        aggregation: metrics.aggregation,
      },
    };

    // Build filter object
    if (filter) {
      const filterPayload: Record<string, any> = {
        startTime: filter.startTime,
        endTime: filter.endTime,
        groupBy: filter.groupBy,
      };

      if (filter.filters && filter.filters.length > 0) {
        filterPayload.filters = filter.filters.map((item) => {
          const filterItem: Record<string, any> = {
            field: item.field,
            operator: item.operator,
            type: item.type,
            value: item.value,
          };
          if (item.key) {
            filterItem.key = item.key;
          }
          return filterItem;
        });
      }

      payload.filter = filterPayload;
    }

    // Add dimension if provided
    if (dimension) {
      payload.dimension = {
        field: dimension.field,
      };
    }

    const response = await this.post("/public/dashboard/query-data", payload);

    if (!response.ok) {
      const errorMessage =
        response.data?.error?.message ?? "Unknown error";
      console.error(
        `netra.dashboard: Failed to execute dashboard query: ${errorMessage}`
      );
      return null;
    }

    return response.data;
  }
}
