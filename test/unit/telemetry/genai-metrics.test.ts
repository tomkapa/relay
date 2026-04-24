// Unit tests for the GenAI histogram recorders.
// Mirror the metric-fixture idiom from test/unit/session/turn-loop.test.ts:324.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  histogramCount,
  histogramSum,
  installMetricFixture,
  uninstallMetricFixture,
  type MetricFixture,
} from "../../helpers/metrics.ts";
import {
  recordGenAiOperationDuration,
  recordGenAiTokenUsage,
} from "../../../src/telemetry/genai-metrics.ts";

describe("recordGenAiOperationDuration", () => {
  let fixture: MetricFixture;

  beforeEach(() => {
    fixture = installMetricFixture();
  });

  afterEach(async () => {
    await uninstallMetricFixture();
  });

  test("records one observation with operation/provider/model attributes", async () => {
    recordGenAiOperationDuration(0.42, {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-sonnet-4-5-20251022",
    });

    const rm = await fixture.collect();
    expect(
      histogramCount(rm, "gen_ai.client.operation.duration", {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "anthropic",
      }),
    ).toBe(1);
    expect(
      histogramSum(rm, "gen_ai.client.operation.duration", { "gen_ai.operation.name": "chat" }),
    ).toBeCloseTo(0.42, 3);
  });
});

describe("recordGenAiTokenUsage", () => {
  let fixture: MetricFixture;

  beforeEach(() => {
    fixture = installMetricFixture();
  });

  afterEach(async () => {
    await uninstallMetricFixture();
  });

  test("emits two data points for input + output with gen_ai.token.type attribute", async () => {
    const baseAttrs = {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-sonnet-4-5-20251022",
    };
    recordGenAiTokenUsage(123, "input", baseAttrs);
    recordGenAiTokenUsage(7, "output", baseAttrs);

    const rm = await fixture.collect();
    expect(histogramSum(rm, "gen_ai.client.token.usage", { "gen_ai.token.type": "input" })).toBe(
      123,
    );
    expect(histogramSum(rm, "gen_ai.client.token.usage", { "gen_ai.token.type": "output" })).toBe(
      7,
    );
    expect(histogramCount(rm, "gen_ai.client.token.usage")).toBe(2);
  });

  test("input-only call emits one data point (embeddings case)", async () => {
    recordGenAiTokenUsage(55, "input", {
      "gen_ai.operation.name": "embeddings",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "text-embedding-3-small",
    });

    const rm = await fixture.collect();
    expect(histogramCount(rm, "gen_ai.client.token.usage")).toBe(1);
    expect(histogramSum(rm, "gen_ai.client.token.usage", { "gen_ai.token.type": "input" })).toBe(
      55,
    );
  });
});
