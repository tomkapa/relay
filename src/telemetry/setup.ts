// OTel NodeSDK bootstrap. CLAUDE.md §2.
//
// MUST be the first side-effecting import in any entrypoint. Library code never imports
// this file — only src/worker/main.ts and src/http/server.ts. Auto-instrumentation
// patches modules at require-time, so anything imported before this file is not
// instrumented (no pg spans, no outbound-fetch spans).
//
// Tests never boot the SDK: NODE_ENV=test (set by test/setup.ts) makes shouldBoot()
// return false, and importing this module from library code is forbidden, so tests
// that transitively import this file stay on the no-op global provider.

import { readFileSync } from "node:fs";
import { hostname } from "node:os";

import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes, envDetector, hostDetector } from "@opentelemetry/resources";
import type { Resource } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { AggregationTemporality, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  ATTR_SERVICE_INSTANCE_ID,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

import { assert } from "../core/assert.ts";
import {
  LOG_EXPORT_INTERVAL_MS,
  METRIC_EXPORT_INTERVAL_MS,
  TELEMETRY_SHUTDOWN_MS,
  TRACE_EXPORT_INTERVAL_MS,
} from "./limits.ts";
import { Attr, counter, emit } from "./otel.ts";

export function shouldBoot(): boolean {
  if (process.env["NODE_ENV"] === "test") return false;
  if (process.env["OTEL_SDK_DISABLED"] === "true") return false;
  return true;
}

function readPackageVersion(): string {
  // Resolve package.json relative to this file. Paid once at boot.
  const url = new URL("../../package.json", import.meta.url);
  const raw = readFileSync(url, "utf8");
  const pkg = JSON.parse(raw) as { version?: unknown };
  assert(
    typeof pkg.version === "string" && pkg.version.length > 0,
    "telemetry: package.json version missing",
  );
  return pkg.version;
}

export function buildResource(): Resource {
  const serviceName = process.env["OTEL_SERVICE_NAME"];
  assert(
    serviceName !== undefined && serviceName.length > 0,
    "telemetry: OTEL_SERVICE_NAME must be set",
  );
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: readPackageVersion(),
    [ATTR_SERVICE_INSTANCE_ID]: `${hostname()}:${process.pid.toString()}`,
  });
}

let sdk: NodeSDK | undefined;

function boot(): void {
  if (sdk !== undefined) return;
  if (!shouldBoot()) return;

  sdk = new NodeSDK({
    resource: buildResource(),
    resourceDetectors: [envDetector, hostDetector],
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter(), {
        scheduledDelayMillis: TRACE_EXPORT_INTERVAL_MS,
      }),
    ],
    // Metrics are routed to Honeycomb by service.name on the Resource — without an explicit
    // reader they fall through to the "unknown_metrics" dataset. Delta temporality so counters
    // reset per export window (Honeycomb's preferred shape).
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        temporalityPreference: AggregationTemporality.DELTA,
      }),
      exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS,
    }),
    logRecordProcessors: [
      new BatchLogRecordProcessor(new OTLPLogExporter(), {
        scheduledDelayMillis: LOG_EXPORT_INTERVAL_MS,
      }),
    ],
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-http": { enabled: true },
        "@opentelemetry/instrumentation-pg": { enabled: true },
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-net": { enabled: false },
        "@opentelemetry/instrumentation-dns": { enabled: false },
      }),
    ],
  });

  sdk.start();

  // Process-boot signal. service.name / service.instance.id on the Resource already
  // identify which service and replica booted, so no attributes are needed here.
  counter("relay.process.start_total", "Process boot counter — one per start").add(1);
  emit("INFO", "telemetry.bootstrapped", { [Attr.ProcessPid]: process.pid });
}

export async function shutdownTelemetry(): Promise<void> {
  if (sdk === undefined) return;
  const current = sdk;
  sdk = undefined;
  await Promise.race([
    current.shutdown(),
    new Promise<void>((resolve) => {
      setTimeout(resolve, TELEMETRY_SHUTDOWN_MS).unref();
    }),
  ]);
}

boot();
