import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireWriterLocks,
  appendCheckpoint,
  assertResumeAllowed,
  objectsForState,
  readLatestCheckpoint,
  requestFingerprint,
  resolveDraftRequest,
  stableStringify,
  validateDraftRequest,
  withAtMostOneRetry,
} from "../skills/meta-lead-ads-flow/scripts/draft-runner-core.mjs";

function request(overrides = {}) {
  return {
    version: 1,
    mode: "draft",
    jobId: "test-job-001",
    profileId: "profile-placeholder",
    adAccountId: "account-placeholder",
    page: { id: "page-placeholder", name: "Test Page" },
    budget: { kind: "daily", amount: 200, currency: "BDT" },
    testMode: true,
    allowCurrentDefaults: true,
    ...overrides,
  };
}

test("resolves deterministic TEST ONLY defaults", () => {
  const result = validateDraftRequest(request());
  assert.equal(result.valid, true);
  assert.match(result.request.names.campaign, /^TEST ONLY/);
  assert.equal(result.request.form.privacyUrl, "https://example.com/privacy");
  assert.equal(result.request.creative.assetName, "meta-leads-test-creative");
  assert.deepEqual(resolveDraftRequest(request()), result.request);
});

test("rejects publishing, missing page identity, and ambiguous currency", () => {
  const publish = validateDraftRequest(request({ mode: "published" }));
  const page = validateDraftRequest(request({ page: { id: "", name: "" } }));
  const currency = validateDraftRequest(request({ budget: { kind: "daily", amount: 200, currency: "bdt" } }));
  const defaults = validateDraftRequest(request({ allowCurrentDefaults: false }));
  assert.match(publish.errors.join("\n"), /never publishes/);
  assert.match(page.errors.join("\n"), /page.id/);
  assert.match(currency.errors.join("\n"), /uppercase ISO 4217/);
  assert.match(defaults.errors.join("\n"), /allowCurrentDefaults must be true/);
});

test("stable fingerprints ignore object key order", () => {
  assert.equal(stableStringify({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}');
  assert.equal(requestFingerprint({ a: 1, b: 2 }), requestFingerprint({ b: 2, a: 1 }));
});

test("checkpoints expose only objects confirmed by the current stage", () => {
  const resolved = resolveDraftRequest(request());
  assert.deepEqual(objectsForState(resolved, "PREFLIGHT_OK"), {});
  assert.deepEqual(Object.keys(objectsForState(resolved, "CAMPAIGN_SAVED")), ["campaign"]);
  assert.deepEqual(Object.keys(objectsForState(resolved, "AD_CREATED")), ["campaign", "adSet", "ad"]);
  assert.deepEqual(Object.keys(objectsForState(resolved, "FORM_CREATED")), ["campaign", "adSet", "ad", "form"]);
});

test("reads the latest append-only checkpoint for one job", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "meta-lead-checkpoints-"));
  const checkpointPath = path.join(directory, "run.jsonl");
  try {
    await appendCheckpoint(checkpointPath, { jobId: "other", state: "PREFLIGHT_OK" });
    await appendCheckpoint(checkpointPath, { jobId: "job", state: "PREFLIGHT_OK" });
    await appendCheckpoint(checkpointPath, { jobId: "job", state: "CAMPAIGN_SAVED" });
    assert.equal((await readLatestCheckpoint(checkpointPath, "job")).state, "CAMPAIGN_SAVED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resume rejects changed input and pending non-idempotent actions", () => {
  assert.throws(
    () => assertResumeAllowed({ inputFingerprint: "old", state: "PREFLIGHT_OK" }, "new"),
    (error) => error.code === "INPUT_CHANGED",
  );
  assert.throws(
    () => assertResumeAllowed({
      inputFingerprint: "same",
      state: "AD_CREATED",
      lastAction: { kind: "create_form", outcome: "pending" },
    }, "same"),
    (error) => error.code === "UNKNOWN",
  );
});

test("Profile and account locks serialize writers and release together", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "meta-lead-locks-"));
  try {
    const first = await acquireWriterLocks({
      profileId: "profile-placeholder",
      adAccountId: "account-placeholder",
      lockDir: directory,
    });
    await assert.rejects(
      acquireWriterLocks({
        profileId: "profile-placeholder",
        adAccountId: "different-account",
        lockDir: directory,
      }),
      (error) => error.code === "LOCKED",
    );
    await first.release();
    const second = await acquireWriterLocks({
      profileId: "profile-placeholder",
      adAccountId: "different-account",
      lockDir: directory,
    });
    await second.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an idempotent operation receives only one retry", async () => {
  let attempts = 0;
  let probes = 0;
  const result = await withAtMostOneRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("rerender");
    return "ok";
  }, async () => { probes += 1; });
  assert.equal(result, "ok");
  assert.equal(attempts, 2);
  assert.equal(probes, 1);

  attempts = 0;
  await assert.rejects(withAtMostOneRetry(async () => {
    attempts += 1;
    throw new Error("still missing");
  }));
  assert.equal(attempts, 2);
});
