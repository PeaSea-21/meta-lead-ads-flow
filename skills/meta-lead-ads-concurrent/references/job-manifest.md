# Concurrent Job Manifest

Use a local JSON manifest to bind every job to an explicit browser Profile and Meta account. Real manifests contain account context and should use a Git-ignored name such as `batch.ads-jobs.local.json`.

## Schema

```json
{
  "version": 2,
  "checkpointPath": ".meta-lead-ads/checkpoints/batch.jsonl",
  "concurrency": {
    "draft": 2,
    "publish": 2
  },
  "jobs": [
    {
      "jobId": "lead-job-001",
      "profileId": "<ADSPOWER_PROFILE_ID>",
      "adAccountId": "<META_AD_ACCOUNT_ID>",
      "pageId": "<FACEBOOK_PAGE_ID>",
      "businessId": "<OPTIONAL_META_BUSINESS_ID>",
      "targetState": "draft",
      "budget": {
        "kind": "daily",
        "amount": 200,
        "currency": "USD"
      },
      "requestPath": "<LOCAL_PATH_TO_AD_REQUEST_JSON>"
    }
  ]
}
```

## Rules

- `version` must be `2`. Version 2 requires durable checkpoints before any write work.
- `checkpointPath` is a non-empty local `.jsonl` path. It must not be an HTTP(S) URL and should remain under a Git-ignored directory.
- `concurrency.draft` and `concurrency.publish` are optional integers from 1 through 8. Defaults are `2` and `1`.
- `jobs` must contain at least one job, and `jobId` values must be unique.
- `profileId`, `adAccountId`, and `pageId` are required non-empty strings. `businessId` is optional.
- Repeated Profile or account IDs are allowed in a manifest but must be serialized by the coordinator.
- Every Profile used for writing must already be open and explicitly confirmed by a human for the current batch. This confirmation is runtime state and must not be represented as a manifest authorization flag.
- `targetState` is `draft` or `published`; it does not grant publish authorization.
- `budget.kind` is `daily` or `lifetime`; `amount` is positive; `currency` is an uppercase ISO 4217 code.
- `requestPath` points to local job inputs. The coordinator must validate the referenced request before opening Ads Manager.

Run the validator from this Skill directory:

```powershell
node scripts/validate-job-manifest.mjs <manifest.json>
```

The validator reports counts and scheduling warnings without printing Profile, account, Page, or Business IDs.
