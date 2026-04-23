// Metric test fixture. Install in beforeEach, uninstall in afterEach.
// Uses _setMeterForTest to inject a test meter into the otel facade without relying on
// the OTel global API (which only allows one provider change per process).

import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import {
  INSTRUMENTATION_NAME,
  INSTRUMENTATION_VERSION,
  _setMeterForTest,
} from "../../src/telemetry/otel.ts";

export type MetricFixture = {
  reader: PeriodicExportingMetricReader;
  collect: () => Promise<ResourceMetrics>;
};

export function installMetricFixture(): MetricFixture {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 999_999_999,
  });
  const provider = new MeterProvider({ readers: [reader] });
  const testMeter = provider.getMeter(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);
  _setMeterForTest(testMeter);
  return {
    reader,
    collect: async () => {
      const result = await reader.collect();
      return result.resourceMetrics;
    },
  };
}

export function uninstallMetricFixture(): void {
  _setMeterForTest(undefined);
}

// Sum a named counter across all data points, optionally filtered by attribute values.
export function sumCounter(
  rm: ResourceMetrics,
  name: string,
  attrs?: Record<string, string>,
): number {
  let total = 0;
  for (const sm of rm.scopeMetrics) {
    for (const metric of sm.metrics) {
      if (metric.descriptor.name !== name) continue;
      for (const dp of metric.dataPoints) {
        if (attrs !== undefined) {
          const allMatch = Object.entries(attrs).every(([k, v]) => dp.attributes[k] === v);
          if (!allMatch) continue;
        }
        total += dp.value as number;
      }
    }
  }
  return total;
}
