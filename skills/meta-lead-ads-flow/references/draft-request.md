# Draft Runner Request

Use the committed single-job runner only with a human-opened AdsPower Profile and a local request file. The runner creates and saves one Leads + instant-form draft and has no publish operation.

## Request Schema

```json
{
  "version": 1,
  "mode": "draft",
  "jobId": "lead-test-001",
  "profileId": "<ADSPOWER_PROFILE_ID>",
  "adAccountId": "<META_AD_ACCOUNT_ID>",
  "businessId": "<OPTIONAL_META_BUSINESS_ID>",
  "page": {
    "id": "<FACEBOOK_PAGE_ID>",
    "name": "<VISIBLE_FACEBOOK_PAGE_NAME>"
  },
  "budget": {
    "kind": "daily",
    "amount": 200,
    "currency": "<ACCOUNT_ISO_CURRENCY>"
  },
  "testMode": true,
  "allowCurrentDefaults": true,
  "names": {},
  "form": {},
  "creative": {
    "assetName": "meta-leads-test-creative"
  }
}
```

`testMode: true` fills missing names and copy with deterministic `TEST ONLY` values derived from `jobId`. It uses valid `example.com` URLs instead of placing non-URL test text into URL fields. `creative.assetName` must identify an image already available in the account media picker; the current runner does not upload a new file.

The runner preserves current audience, schedule, placement, enhancement, and form-type defaults. Set `allowCurrentDefaults: true` to acknowledge that behavior. It currently requires campaign-level daily or lifetime budget controls to match the requested `budget.kind`; it stops rather than switching budget strategy implicitly.

Real request files contain account context. Use a Git-ignored filename such as `lead-test-001.ads-request.local.json`.

## Run

```powershell
npm run run:draft -- --request=<request.ads-request.local.json>
```

Optional paths:

```powershell
npm run run:draft -- --request=<request.json> --checkpoint=.meta-lead-ads/checkpoints/run.jsonl --diagnostics=.meta-lead-ads/diagnostics/run
```

The default checkpoint and diagnostic paths are under `.meta-lead-ads/`. Normal execution keeps one CDP connection and writes only stage screenshots plus timing JSONL. On failure it adds a scoped diagnostic snapshot without cookies, storage, headers, or full DOM.

Use `--preflight-only` to validate the declared already-open Profile, Ads Manager tab, account, and access gate without clicking, filling, or writing a progress checkpoint:

```powershell
npm run run:draft -- --request=<request.json> --preflight-only
```

Reusing the same `jobId` and request resumes from the latest confirmed state. A changed request fingerprint stops as `INPUT_CHANGED`; a pending or unknown create action stops as `UNKNOWN` for reconciliation.
