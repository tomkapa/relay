// Span test fixture. Install in beforeEach, uninstall in afterEach.
// Uses _setTracerForTest to inject a BasicTracerProvider-backed tracer into the
// otel facade so withSpan() records to an InMemorySpanExporter we can read back.

import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import {
  INSTRUMENTATION_NAME,
  INSTRUMENTATION_VERSION,
  _setTracerForTest,
} from "../../src/telemetry/otel.ts";

export type SpanFixture = {
  exporter: InMemorySpanExporter;
  finished: () => readonly ReadableSpan[];
  spansByName: (name: string) => readonly ReadableSpan[];
};

let _activeProvider: BasicTracerProvider | undefined;

export function installSpanFixture(): SpanFixture {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  _activeProvider = provider;
  const testTracer = provider.getTracer(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);
  _setTracerForTest(testTracer);
  const finished = (): readonly ReadableSpan[] => exporter.getFinishedSpans();
  return {
    exporter,
    finished,
    spansByName: (name) => finished().filter((s) => s.name === name),
  };
}

export async function uninstallSpanFixture(): Promise<void> {
  _setTracerForTest(undefined);
  if (_activeProvider !== undefined) {
    await _activeProvider.shutdown();
    _activeProvider = undefined;
  }
}

// Convenience: find a span event by name on a given span, or undefined.
export function findEvent(
  span: ReadableSpan,
  name: string,
): ReadableSpan["events"][number] | undefined {
  return span.events.find((e) => e.name === name);
}
