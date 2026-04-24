// Tests for W3C traceparent capture/parse/restore. These helpers enable cross-process
// trace context propagation through the work queue (RELAY queue hand-off).
//
// Format (W3C Trace Context): "00-<32 hex traceId>-<16 hex spanId>-<2 hex flags>".

import { beforeEach, describe, expect, test } from "bun:test";
import { context, trace, TraceFlags } from "@opentelemetry/api";
import {
  captureTraceparent,
  parseTraceparent,
  withRemoteParent,
} from "../../../src/telemetry/otel.ts";

// Reset any lingering test context between tests (bun:test shares module globals).
beforeEach(() => {
  // No global state to reset — captureTraceparent reads whatever is active.
});

describe("captureTraceparent", () => {
  test("returns null when no span is active", () => {
    expect(captureTraceparent()).toBeNull();
  });

  test("returns a well-formed traceparent inside an active remote parent context", async () => {
    const remoteCtx = trace.setSpanContext(context.active(), {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
    const tp = await context.with(remoteCtx, () => {
      // There's no active *span*, but active span context is set via trace.setSpanContext.
      // captureTraceparent should still serialize it because the SpanContext is valid.
      return Promise.resolve(captureTraceparent());
    });
    expect(tp).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
  });
});

describe("parseTraceparent", () => {
  test("parses a valid sampled traceparent", () => {
    const r = parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    expect(r).not.toBeNull();
    if (r === null) return;
    expect(r.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(r.spanId).toBe("00f067aa0ba902b7");
    expect(r.traceFlags).toBe(TraceFlags.SAMPLED);
    expect(r.isRemote).toBe(true);
  });

  test("parses a valid unsampled traceparent", () => {
    const r = parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00");
    expect(r).not.toBeNull();
    if (r === null) return;
    expect(r.traceFlags).toBe(TraceFlags.NONE);
  });

  test("rejects the ff (invalid) version byte per W3C spec", () => {
    expect(parseTraceparent("ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBeNull();
  });

  test("rejects malformed strings", () => {
    expect(parseTraceparent("not-a-traceparent")).toBeNull();
    expect(parseTraceparent("")).toBeNull();
    expect(parseTraceparent("00-shorttrace-00f067aa0ba902b7-01")).toBeNull();
    expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-shortspan-01")).toBeNull();
  });

  test("rejects all-zero traceId or spanId (invalid per W3C)", () => {
    expect(parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeNull();
    expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01")).toBeNull();
  });
});

describe("withRemoteParent", () => {
  test("runs fn unchanged when traceparent is null", async () => {
    const result = await withRemoteParent(null, () => Promise.resolve("ok"));
    expect(result).toBe("ok");
  });

  test("runs fn unchanged when traceparent is malformed", async () => {
    const result = await withRemoteParent("garbage", () => Promise.resolve("ok"));
    expect(result).toBe("ok");
  });

  test("installs the parsed SpanContext as the active span context", async () => {
    const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const captured = await withRemoteParent(tp, () => Promise.resolve(captureTraceparent()));
    expect(captured).toBe(tp);
  });
});
