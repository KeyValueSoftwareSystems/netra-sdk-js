import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Config } from "../../config";
import { Logger } from "../../logger";
import { ModelsHttpClient } from "./client";
import { ModelPricing } from "./models";

const samplePricing: ModelPricing[] = [
  {
    name: "gpt-4",
    projectId: null,
    matchPattern: "gpt-4*",
    prices: [
      {
        usageType: "input",
        minUnits: 0,
        maxUnits: 1000,
        price: 0.03,
        unitValue: 1000,
      },
    ],
  },
];

describe("ModelsHttpClient.getModelPricing", () => {
  let client: ModelsHttpClient;
  let get: ReturnType<typeof vi.spyOn>;
  let isInitialized: ReturnType<typeof vi.spyOn>;
  let logError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = new ModelsHttpClient(new Config());
    get = vi.spyOn(client, "get");
    isInitialized = vi.spyOn(client, "isInitialized").mockReturnValue(true);
    logError = vi.spyOn(Logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("when the request succeeds", () => {
    it("returns the pricing array from an enveloped API response", async () => {
      get.mockResolvedValue({
        ok: true,
        status: 200,
        data: { data: samplePricing },
      });

      const result = await client.getModelPricing();

      expect(result).toEqual(samplePricing);
      expect(get).toHaveBeenCalledWith("/sdk/models", undefined);
    });

    it("calls GET /sdk/models with the name query param when name is provided", async () => {
      get.mockResolvedValue({
        ok: true,
        status: 200,
        data: { data: samplePricing },
      });

      await client.getModelPricing("gpt-4");

      expect(get).toHaveBeenCalledWith("/sdk/models", { name: "gpt-4" });
    });

    it("calls GET /sdk/models with no query params when name is omitted", async () => {
      get.mockResolvedValue({
        ok: true,
        status: 200,
        data: { data: samplePricing },
      });

      await client.getModelPricing();

      expect(get).toHaveBeenCalledWith("/sdk/models", undefined);
    });

    it("returns an empty array when the API returns an empty list", async () => {
      get.mockResolvedValue({
        ok: true,
        status: 200,
        data: { data: [] },
      });

      const result = await client.getModelPricing();

      expect(result).toEqual([]);
      expect(logError).not.toHaveBeenCalled();
    });
  });

  describe("when the client is not initialized", () => {
    it("returns null without calling GET", async () => {
      isInitialized.mockReturnValue(false);

      const result = await client.getModelPricing("gpt-4");

      expect(result).toBeNull();
      expect(get).not.toHaveBeenCalled();
      expect(logError).toHaveBeenCalledWith(
        "netra.models: Models client is not initialized; cannot fetch model pricing",
      );
    });
  });

  describe("when the HTTP response fails", () => {
    it("returns null and logs the API error message when response is not ok", async () => {
      get.mockResolvedValue({
        ok: false,
        status: 500,
        data: { error: { message: "backend unavailable" } },
      });

      const result = await client.getModelPricing();

      expect(result).toBeNull();
      expect(logError).toHaveBeenCalledWith(
        "netra.models: Failed to fetch model pricing: backend unavailable",
      );
    });

    it("returns null and logs a generic message when the error payload has no message", async () => {
      get.mockResolvedValue({
        ok: false,
        status: 502,
        data: {},
      });

      const result = await client.getModelPricing();

      expect(result).toBeNull();
      expect(logError).toHaveBeenCalledWith(
        "netra.models: Failed to fetch model pricing: Unknown error",
      );
    });
  });

  describe("when the response payload is unexpected", () => {
    it("returns null and logs when the unwrapped payload is not an array", async () => {
      get.mockResolvedValue({
        ok: true,
        status: 200,
        data: { data: { name: "not-an-array" } },
      });

      const result = await client.getModelPricing();

      expect(result).toBeNull();
      expect(logError).toHaveBeenCalledWith(
        "netra.models: Unexpected response format; expected an array",
      );
    });
  });

  describe("when GET throws", () => {
    it("returns null and logs the thrown error message", async () => {
      get.mockRejectedValue(new Error("network down"));

      const result = await client.getModelPricing();

      expect(result).toBeNull();
      expect(logError).toHaveBeenCalledWith(
        "netra.models: Failed to fetch model pricing:",
        "network down",
      );
    });
  });
});
