import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

export const PROGRESS_STATES = [
  "PREFLIGHT_OK",
  "CAMPAIGN_SAVED",
  "ADSET_SAVED",
  "AD_CREATED",
  "FORM_CREATED",
  "CREATIVE_SAVED",
  "DRAFT_SAVED",
  "PUBLISHED",
];

export const STOP_STATES = new Set([
  "FAILED",
  "UNKNOWN",
  "HUMAN_ACTION_REQUIRED",
  "INPUT_CHANGED",
  "STATE_MISMATCH",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function mergeDefined(base, overrides) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function testDefaults(jobId) {
  const prefix = `TEST ONLY - ${jobId}`;
  return {
    names: {
      campaign: `${prefix} - Campaign`,
      adSet: `${prefix} - Ad Set`,
      ad: `${prefix} - Ad`,
      form: `${prefix} - Instant Form`,
    },
    form: {
      introTitle: "TEST ONLY - 测试",
      introDescription: "测试广告即时表单，仅用于流程验证，请勿提交真实资料。",
      dataUse: "TEST ONLY：测试资料仅用于草稿流程验证，请勿提交真实个人资料。",
      privacyUrl: "https://example.com/privacy",
      privacyLinkText: "TEST ONLY - 测试隐私政策",
      completionTitle: "TEST ONLY - 测试完成",
      completionDescription: "测试流程已完成，请关闭页面。",
      completionUrl: "https://example.com/test-only",
      completionCta: "TEST ONLY",
    },
    creative: {
      assetName: "meta-leads-test-creative",
      primaryText: "TEST ONLY - Meta Leads 即时表单草稿流程测试，请勿提交真实资料。",
      headline: "TEST ONLY - 即时表单测试",
      description: "仅用于自动化测试，请勿发布。",
    },
  };
}

export function resolveDraftRequest(input) {
  const defaults = input?.testMode ? testDefaults(input.jobId ?? "test-job") : {};
  return {
    ...input,
    mode: input?.mode ?? "draft",
    names: mergeDefined(defaults.names ?? {}, input?.names),
    form: mergeDefined(defaults.form ?? {}, input?.form),
    creative: mergeDefined(defaults.creative ?? {}, input?.creative),
  };
}

export function validateDraftRequest(input) {
  const errors = [];
  if (!isObject(input)) return { valid: false, errors: ["request must be an object"] };
  if (input.version !== 1) errors.push("version must be 1");
  if ((input.mode ?? "draft") !== "draft") errors.push("mode must be draft; this runner never publishes");

  for (const field of ["jobId", "profileId", "adAccountId"]) {
    if (!nonEmptyString(input[field])) errors.push(`${field} must be a non-empty string`);
  }
  if (!isObject(input.page)) {
    errors.push("page must be an object");
  } else {
    if (!nonEmptyString(input.page.id)) errors.push("page.id must be a non-empty string");
    if (!nonEmptyString(input.page.name)) errors.push("page.name must be a non-empty string");
  }
  if (!isObject(input.budget)) {
    errors.push("budget must be an object");
  } else {
    if (!['daily', 'lifetime'].includes(input.budget.kind)) errors.push("budget.kind must be daily or lifetime");
    if (!Number.isFinite(input.budget.amount) || input.budget.amount <= 0) {
      errors.push("budget.amount must be a positive number");
    }
    if (typeof input.budget.currency !== "string" || !/^[A-Z]{3}$/.test(input.budget.currency)) {
      errors.push("budget.currency must be an uppercase ISO 4217 code");
    }
  }
  if (input.allowCurrentDefaults !== true) errors.push("allowCurrentDefaults must be true");

  const resolved = resolveDraftRequest(input);
  for (const field of ["campaign", "adSet", "ad", "form"]) {
    if (!nonEmptyString(resolved.names?.[field])) errors.push(`names.${field} must be a non-empty string`);
  }
  for (const field of [
    "introTitle",
    "introDescription",
    "dataUse",
    "privacyUrl",
    "privacyLinkText",
    "completionTitle",
    "completionDescription",
    "completionUrl",
    "completionCta",
  ]) {
    if (!nonEmptyString(resolved.form?.[field])) errors.push(`form.${field} must be a non-empty string`);
  }
  for (const field of ["assetName", "primaryText", "headline", "description"]) {
    if (!nonEmptyString(resolved.creative?.[field])) errors.push(`creative.${field} must be a non-empty string`);
  }
  for (const field of ["privacyUrl", "completionUrl"]) {
    try {
      const url = new URL(resolved.form?.[field]);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error("unsupported protocol");
    } catch {
      errors.push(`form.${field} must be a valid HTTP(S) URL`);
    }
  }

  return { valid: errors.length === 0, errors, request: resolved };
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

export function requestFingerprint(request) {
  return `sha256:${createHash("sha256").update(stableStringify(request)).digest("hex")}`;
}

export async function appendCheckpoint(checkpointPath, record) {
  await mkdir(path.dirname(path.resolve(checkpointPath)), { recursive: true });
  const handle = await open(checkpointPath, "a");
  try {
    await handle.appendFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readLatestCheckpoint(checkpointPath, jobId) {
  let content;
  try {
    content = await readFile(checkpointPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let latest = null;
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid checkpoint JSON at line ${index + 1}: ${error.message}`);
    }
    if (record.jobId === jobId) latest = record;
  }
  return latest;
}

export function assertResumeAllowed(latest, fingerprint) {
  if (!latest) return "START";
  if (latest.inputFingerprint !== fingerprint) {
    const error = new Error("checkpoint request fingerprint differs from the current request");
    error.code = "INPUT_CHANGED";
    throw error;
  }
  if (latest.lastAction?.outcome === "pending" || latest.lastAction?.outcome === "unknown") {
    const error = new Error(`last non-idempotent action ${latest.lastAction.kind ?? "unknown"} requires reconciliation`);
    error.code = "UNKNOWN";
    throw error;
  }
  if (STOP_STATES.has(latest.state)) {
    const error = new Error(`checkpoint is stopped at ${latest.state}`);
    error.code = latest.state;
    throw error;
  }
  if (!PROGRESS_STATES.includes(latest.state)) {
    const error = new Error(`unsupported checkpoint state ${latest.state}`);
    error.code = "STATE_MISMATCH";
    throw error;
  }
  return latest.state;
}

export function checkpointRecord({ request, fingerprint, state, page = {}, objects = {}, lastAction }) {
  return {
    schemaVersion: 1,
    jobId: request.jobId,
    inputFingerprint: fingerprint,
    state,
    profileId: request.profileId,
    adAccountId: request.adAccountId,
    pageId: request.page.id,
    objects,
    page,
    ...(lastAction ? { lastAction } : {}),
    verifiedAt: new Date().toISOString(),
  };
}

export function objectsForState(request, state) {
  const index = PROGRESS_STATES.indexOf(state);
  if (index < 1) return {};
  const objects = { campaign: { name: request.names.campaign } };
  if (index >= 2) objects.adSet = { name: request.names.adSet };
  if (index >= 3) objects.ad = { name: request.names.ad };
  if (index >= 4) objects.form = { name: request.names.form };
  return objects;
}

export function pendingAction(kind) {
  return { actionId: randomUUID(), kind, outcome: "pending" };
}

export function confirmAction(action) {
  return { ...action, outcome: "confirmed" };
}

function lockName(kind, value) {
  const digest = createHash("sha256").update(`${kind}:${value}`).digest("hex");
  return `${kind}-${digest}.lock`;
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function acquireOneLock(lockPath, metadata) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, "wx");
    try {
      await handle.writeFile(JSON.stringify(metadata), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  } catch (error) {
    if (handle) await rm(lockPath, { force: true }).catch(() => {});
    if (error.code !== "EEXIST") throw error;
  }

  let owner = null;
  try {
    owner = JSON.parse(await readFile(lockPath, "utf8"));
  } catch {}
  if (owner?.host === hostname() && !processExists(owner.pid)) {
    await rm(lockPath, { force: true });
    return acquireOneLock(lockPath, metadata);
  }
  const error = new Error(`writer lock is already held: ${path.basename(lockPath)}`);
  error.code = "LOCKED";
  throw error;
}

export async function acquireWriterLocks({ profileId, adAccountId, lockDir = ".meta-lead-ads/locks" }) {
  const lockPaths = [
    path.resolve(lockDir, lockName("account", adAccountId)),
    path.resolve(lockDir, lockName("profile", profileId)),
  ].sort();
  const acquired = [];
  const metadata = { pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString() };
  try {
    for (const lockPath of lockPaths) {
      await acquireOneLock(lockPath, metadata);
      acquired.push(lockPath);
    }
  } catch (error) {
    await Promise.all(acquired.map((lockPath) => rm(lockPath, { force: true })));
    throw error;
  }

  let released = false;
  return {
    paths: lockPaths,
    async release() {
      if (released) return;
      released = true;
      await Promise.all(lockPaths.map((lockPath) => rm(lockPath, { force: true })));
    },
  };
}

export async function withAtMostOneRetry(operation, reProbe = async () => {}) {
  try {
    return await operation(1);
  } catch (firstError) {
    await reProbe(firstError);
    try {
      return await operation(2);
    } catch (secondError) {
      secondError.cause ??= firstError;
      throw secondError;
    }
  }
}
