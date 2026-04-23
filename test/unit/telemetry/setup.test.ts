// Unit tests for the OTel SDK bootstrap (src/telemetry/setup.ts).
//
// The preload sets NODE_ENV=test (test/setup.ts), so importing src/telemetry/setup.ts
// from this file is a no-op — shouldBoot() returns false and the NodeSDK is never
// constructed. That is the invariant we care about most: tests must never boot the
// real SDK (CLAUDE.md §3 — tests do not hit real telemetry backends).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { AssertionError } from "../../../src/core/assert.ts";
import {
  buildResource,
  markRole,
  shouldBoot,
  shutdownTelemetry,
} from "../../../src/telemetry/setup.ts";

describe("shouldBoot", () => {
  const originalNodeEnv = process.env["NODE_ENV"];
  const originalDisabled = process.env["OTEL_SDK_DISABLED"];

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = originalNodeEnv;
    if (originalDisabled === undefined) delete process.env["OTEL_SDK_DISABLED"];
    else process.env["OTEL_SDK_DISABLED"] = originalDisabled;
  });

  test("returns false when NODE_ENV is test", () => {
    process.env["NODE_ENV"] = "test";
    delete process.env["OTEL_SDK_DISABLED"];
    expect(shouldBoot()).toBe(false);
  });

  test("returns false when OTEL_SDK_DISABLED is true", () => {
    process.env["NODE_ENV"] = "production";
    process.env["OTEL_SDK_DISABLED"] = "true";
    expect(shouldBoot()).toBe(false);
  });

  test("returns true in production with SDK enabled", () => {
    process.env["NODE_ENV"] = "production";
    delete process.env["OTEL_SDK_DISABLED"];
    expect(shouldBoot()).toBe(true);
  });
});

describe("buildResource", () => {
  const originalServiceName = process.env["OTEL_SERVICE_NAME"];

  afterEach(() => {
    if (originalServiceName === undefined) delete process.env["OTEL_SERVICE_NAME"];
    else process.env["OTEL_SERVICE_NAME"] = originalServiceName;
  });

  test("throws AssertionError when OTEL_SERVICE_NAME is unset", () => {
    delete process.env["OTEL_SERVICE_NAME"];
    expect(() => buildResource()).toThrow(AssertionError);
  });

  test("throws AssertionError when OTEL_SERVICE_NAME is empty", () => {
    process.env["OTEL_SERVICE_NAME"] = "";
    expect(() => buildResource()).toThrow(AssertionError);
  });

  test("returns a Resource carrying service.name, service.version, service.instance.id", () => {
    process.env["OTEL_SERVICE_NAME"] = "relay-test";
    const resource = buildResource();
    expect(resource.attributes["service.name"]).toBe("relay-test");
    expect(typeof resource.attributes["service.version"]).toBe("string");
    expect((resource.attributes["service.version"] as string).length).toBeGreaterThan(0);
    const instanceId = resource.attributes["service.instance.id"];
    expect(typeof instanceId).toBe("string");
    expect(instanceId).toMatch(/^.+:\d+$/);
  });
});

describe("shutdownTelemetry", () => {
  test("is a no-op and safe to call repeatedly when SDK was never booted", async () => {
    await shutdownTelemetry();
    await shutdownTelemetry();
  });
});

describe("markRole", () => {
  // With NODE_ENV=test the global meter provider is the no-op provider. The counter
  // call therefore has no observable side effect — we only assert the function does
  // not throw and accepts the expected role values.
  beforeEach(() => {
    // No setup — the module-top-level boot() has already run as a no-op.
  });

  test("accepts the worker role without throwing", () => {
    expect(() => {
      markRole("worker");
    }).not.toThrow();
  });

  test("accepts the api role without throwing", () => {
    expect(() => {
      markRole("api");
    }).not.toThrow();
  });
});
