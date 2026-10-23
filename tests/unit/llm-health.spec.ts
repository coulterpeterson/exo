/**
 * AI endpoint health classification (src/shared/llm-health.ts).
 *
 * What the banner tells the user to check depends entirely on this, so the
 * error shapes below mirror what actually reaches it: the Anthropic SDK's
 * APIError (has `status`), its APIConnectionError wrapping a fetch failure
 * wrapping a socket error (has a `cause` chain ending in an errno `code`), and
 * its timeout error. The motivating incident was a dropped Tailscale tunnel:
 * "Connection error.: fetch failed: connect ENETUNREACH 100.109.164.75:8317".
 */
import { test, expect } from "@playwright/test";
import {
  classifyProbeError,
  describeFailure,
  failingProviders,
  type ProviderHealth,
} from "../../src/shared/llm-health";

function apiError(status: number, message = "error") {
  return Object.assign(new Error(message), { name: "APIError", status });
}

function connectionError(code: string) {
  const socket = Object.assign(new Error(`connect ${code} 100.109.164.75:8317`), { code });
  const fetchFailure = Object.assign(new TypeError("fetch failed"), { cause: socket });
  return Object.assign(new Error("Connection error."), {
    name: "APIConnectionError",
    cause: fetchFailure,
  });
}

test.describe("classifyProbeError", () => {
  test("a dropped VPN (ENETUNREACH deep in the cause chain) is a network failure", () => {
    expect(classifyProbeError(connectionError("ENETUNREACH"))).toEqual({
      ok: false,
      kind: "network",
      detail: "ENETUNREACH",
    });
  });

  test("a refused connection and an unknown host are network failures", () => {
    expect(classifyProbeError(connectionError("ECONNREFUSED"))).toMatchObject({
      kind: "network",
      detail: "ECONNREFUSED",
    });
    expect(classifyProbeError(connectionError("ENOTFOUND"))).toMatchObject({
      kind: "network",
      detail: "ENOTFOUND",
    });
  });

  test("a connection error without an errno code is still a network failure", () => {
    const error = Object.assign(new Error("Connection error."), { name: "APIConnectionError" });
    expect(classifyProbeError(error)).toEqual({
      ok: false,
      kind: "network",
      detail: "connection failed",
    });
  });

  test("timeouts are reported as timeouts, not network failures", () => {
    const sdkTimeout = Object.assign(new Error("Request timed out."), {
      name: "APIConnectionTimeoutError",
    });
    expect(classifyProbeError(sdkTimeout)).toMatchObject({ ok: false, kind: "timeout" });
    const aborted = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    expect(classifyProbeError(aborted)).toMatchObject({ ok: false, kind: "timeout" });
  });

  test("a 401 means the key was rejected", () => {
    expect(classifyProbeError(apiError(401))).toEqual({
      ok: false,
      kind: "auth",
      detail: "HTTP 401",
    });
  });

  test("403, 429 and 529 count as healthy — reachable and authenticated", () => {
    for (const status of [403, 429, 529]) {
      expect(classifyProbeError(apiError(status))).toEqual({ ok: true });
    }
  });

  test("a proxy whose upstream login expired (5xx) is an endpoint failure", () => {
    expect(classifyProbeError(apiError(502))).toEqual({
      ok: false,
      kind: "endpoint",
      detail: "HTTP 502",
    });
    expect(classifyProbeError(apiError(500))).toMatchObject({ kind: "endpoint" });
  });

  test("a 400 or 404 (wrong path, unknown model) is an endpoint failure", () => {
    expect(classifyProbeError(apiError(404))).toMatchObject({
      kind: "endpoint",
      detail: "HTTP 404",
    });
    expect(classifyProbeError(apiError(400))).toMatchObject({
      kind: "endpoint",
      detail: "HTTP 400",
    });
  });

  test("anything unrecognised is an endpoint failure carrying its message", () => {
    expect(classifyProbeError(new Error("Unexpected token < in JSON"))).toEqual({
      ok: false,
      kind: "endpoint",
      detail: "Unexpected token < in JSON",
    });
  });

  test("non-Error throwables don't crash the classifier", () => {
    expect(classifyProbeError("boom")).toMatchObject({ ok: false, kind: "endpoint" });
    expect(classifyProbeError(undefined)).toMatchObject({ ok: false, kind: "endpoint" });
  });
});

test.describe("describeFailure", () => {
  const base: ProviderHealth = {
    provider: "anthropic",
    endpoint: "http://100.109.164.75:8317",
    ok: false,
    checkedAt: 0,
  };

  test("names the endpoint and points a network failure at the VPN", () => {
    const text = describeFailure({ ...base, kind: "network", detail: "ENETUNREACH" });
    expect(text).toContain("http://100.109.164.75:8317");
    expect(text).toContain("ENETUNREACH");
    expect(text).toMatch(/VPN/);
  });

  test("points an auth failure at the API key", () => {
    expect(describeFailure({ ...base, kind: "auth" })).toMatch(/API key/);
  });

  test("points an endpoint failure at the proxy's upstream login", () => {
    expect(describeFailure({ ...base, kind: "endpoint", detail: "HTTP 502" })).toMatch(
      /HTTP 502.*proxy/,
    );
  });

  test("labels Ollama Cloud by name", () => {
    expect(
      describeFailure({
        ...base,
        provider: "ollama-cloud",
        endpoint: "https://ollama.com",
        kind: "timeout",
      }),
    ).toContain("Ollama Cloud");
  });
});

test.describe("failingProviders", () => {
  test("nothing is failing before the first check", () => {
    expect(failingProviders(null)).toEqual([]);
  });

  test("returns only the failing providers", () => {
    const ok: ProviderHealth = { provider: "ollama-cloud", endpoint: "x", ok: true, checkedAt: 0 };
    const bad: ProviderHealth = { provider: "anthropic", endpoint: "y", ok: false, checkedAt: 0 };
    expect(failingProviders({ checkedAt: 0, providers: [ok, bad] })).toEqual([bad]);
  });
});
