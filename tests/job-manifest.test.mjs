import assert from "node:assert/strict";
import test from "node:test";

import { validateJobManifest } from "../skills/meta-lead-ads-concurrent/scripts/validate-job-manifest.mjs";

function validJob(overrides = {}) {
  return {
    jobId: "job-001",
    profileId: "profile-placeholder",
    adAccountId: "account-placeholder",
    pageId: "page-placeholder",
    targetState: "draft",
    budget: { kind: "daily", amount: 200, currency: "USD" },
    requestPath: "request.local.json",
    ...overrides,
  };
}

function validManifest(jobs = [validJob()], overrides = {}) {
  return {
    version: 2,
    checkpointPath: ".meta-lead-ads/checkpoints/test.jsonl",
    jobs,
    ...overrides,
  };
}

test("accepts an isolated draft job", () => {
  const result = validateJobManifest(validManifest());
  assert.equal(result.valid, true);
  assert.deepEqual(result.concurrency, { draft: 2, publish: 1 });
  assert.equal(result.warnings.length, 0);
});

test("rejects ambiguous budget currency", () => {
  const result = validateJobManifest({
    ...validManifest(),
    jobs: [validJob({ budget: { kind: "daily", amount: 200, currency: "bdt" } })],
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /uppercase ISO 4217/);
});

test("rejects duplicate job IDs", () => {
  const result = validateJobManifest(validManifest([
    validJob(),
    validJob({ profileId: "profile-two", adAccountId: "account-two" }),
  ]));
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /jobId must be unique/);
});

test("rejects an empty optional business ID", () => {
  const result = validateJobManifest(validManifest([validJob({ businessId: "" })]));
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /businessId must be a non-empty string/);
});

test("requires a local JSONL checkpoint path", () => {
  const missing = validateJobManifest(validManifest(undefined, { checkpointPath: "" }));
  const remote = validateJobManifest(validManifest(undefined, { checkpointPath: "https://example.com/state.jsonl" }));
  assert.equal(missing.valid, false);
  assert.equal(remote.valid, false);
  assert.match(missing.errors.join("\n"), /checkpointPath/);
  assert.match(remote.errors.join("\n"), /checkpointPath/);
});

test("rejects the checkpoint-free version 1 schema", () => {
  const result = validateJobManifest({ ...validManifest(), version: 1 });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /version must be 2/);
});

test("marks shared profiles and accounts for serialization", () => {
  const result = validateJobManifest(validManifest([
      validJob({ jobId: "job-001", targetState: "published" }),
      validJob({ jobId: "job-002", targetState: "published" }),
    ], {
    concurrency: { draft: 4, publish: 2 },
  }));
  assert.equal(result.valid, true);
  assert.equal(result.serializedProfileGroups, 1);
  assert.equal(result.serializedAccountGroups, 1);
  assert.equal(result.publishIntentCount, 2);
  assert.equal(result.warnings.length, 3);
});
