#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const LIMIT = 8;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function repeatedValueCount(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.values()].filter((count) => count > 1).length;
}

export function validateJobManifest(manifest) {
  const errors = [];
  const warnings = [];

  if (!isObject(manifest)) return { valid: false, errors: ["manifest must be an object"], warnings };
  if (manifest.version !== 1) errors.push("version must be 1");

  const concurrency = isObject(manifest.concurrency) ? manifest.concurrency : {};
  const normalizedConcurrency = {
    draft: concurrency.draft ?? 2,
    publish: concurrency.publish ?? 1,
  };
  for (const [key, value] of Object.entries(normalizedConcurrency)) {
    if (!Number.isInteger(value) || value < 1 || value > LIMIT) {
      errors.push(`concurrency.${key} must be an integer from 1 through ${LIMIT}`);
    }
  }

  if (!Array.isArray(manifest.jobs) || manifest.jobs.length === 0) {
    errors.push("jobs must be a non-empty array");
    return { valid: false, errors, warnings, concurrency: normalizedConcurrency };
  }

  const jobIds = new Set();
  const profileIds = [];
  const accountIds = [];
  let publishIntentCount = 0;

  manifest.jobs.forEach((job, index) => {
    const path = `jobs[${index}]`;
    if (!isObject(job)) {
      errors.push(`${path} must be an object`);
      return;
    }

    for (const field of ["jobId", "profileId", "adAccountId", "pageId", "requestPath"]) {
      if (!nonEmptyString(job[field])) errors.push(`${path}.${field} must be a non-empty string`);
    }
    if (job.businessId !== undefined && !nonEmptyString(job.businessId)) {
      errors.push(`${path}.businessId must be a non-empty string when provided`);
    }

    if (nonEmptyString(job.jobId)) {
      if (jobIds.has(job.jobId)) errors.push(`${path}.jobId must be unique`);
      jobIds.add(job.jobId);
    }
    if (nonEmptyString(job.profileId)) profileIds.push(job.profileId);
    if (nonEmptyString(job.adAccountId)) accountIds.push(job.adAccountId);

    const targetState = job.targetState ?? "draft";
    if (!["draft", "published"].includes(targetState)) {
      errors.push(`${path}.targetState must be draft or published`);
    }
    if (targetState === "published") publishIntentCount += 1;

    if (!isObject(job.budget)) {
      errors.push(`${path}.budget must be an object`);
    } else {
      if (!["daily", "lifetime"].includes(job.budget.kind)) {
        errors.push(`${path}.budget.kind must be daily or lifetime`);
      }
      if (!Number.isFinite(job.budget.amount) || job.budget.amount <= 0) {
        errors.push(`${path}.budget.amount must be a positive number`);
      }
      if (typeof job.budget.currency !== "string" || !/^[A-Z]{3}$/.test(job.budget.currency)) {
        errors.push(`${path}.budget.currency must be an uppercase ISO 4217 code`);
      }
    }
  });

  const serializedProfileGroups = repeatedValueCount(profileIds);
  const serializedAccountGroups = repeatedValueCount(accountIds);
  if (serializedProfileGroups) warnings.push("jobs sharing a Profile must be serialized");
  if (serializedAccountGroups) warnings.push("jobs sharing an ad account must be serialized");
  if (publishIntentCount) warnings.push("publish intent does not replace fresh current-turn authorization");

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    concurrency: normalizedConcurrency,
    jobCount: manifest.jobs.length,
    publishIntentCount,
    serializedProfileGroups,
    serializedAccountGroups,
  };
}

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath || process.argv.includes("--help")) {
    console.log("Usage: node validate-job-manifest.mjs <manifest.json>");
    process.exit(manifestPath ? 0 : 2);
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    console.error(JSON.stringify({ valid: false, errors: [`cannot read manifest: ${error.message}`] }, null, 2));
    process.exit(1);
  }

  const result = validateJobManifest(manifest);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.valid ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
