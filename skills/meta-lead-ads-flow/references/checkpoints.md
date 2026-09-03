# Checkpoints And Resume

Use an append-only local JSONL checkpoint file for both single-job and concurrent runs. It may contain real account and object IDs, so keep it under `.meta-lead-ads/` or another Git-ignored location.

## Record

Append a progress record after each stage has been verified. Before a non-idempotent create or publish click, append an intent record that keeps the last verified `state` and sets `lastAction.outcome` to `pending`:

```json
{
  "schemaVersion": 1,
  "jobId": "lead-job-001",
  "inputFingerprint": "sha256:<REQUEST_AND_MANIFEST_HASH>",
  "state": "FORM_CREATED",
  "profileId": "<ADSPOWER_PROFILE_ID>",
  "adAccountId": "<META_AD_ACCOUNT_ID>",
  "pageId": "<FACEBOOK_PAGE_ID>",
  "objects": {
    "campaign": { "id": "<ID_IF_AVAILABLE>", "name": "<NAME>" },
    "adSet": { "id": "<ID_IF_AVAILABLE>", "name": "<NAME>" },
    "form": { "id": "<ID_IF_AVAILABLE>", "name": "<NAME>" },
    "ad": { "id": "<ID_IF_AVAILABLE>", "name": "<NAME>" }
  },
  "page": {
    "path": "/adsmanager/manage/ads/edit/standalone",
    "saveState": "ALL_EDITS_SAVED"
  },
  "lastAction": {
    "actionId": "<LOCALLY_UNIQUE_ACTION_ID>",
    "kind": "create_form",
    "outcome": "confirmed"
  },
  "verifiedAt": "<ISO_8601_TIMESTAMP>"
}
```

Valid progress states are:

`PREFLIGHT_OK -> CAMPAIGN_SAVED -> ADSET_SAVED -> AD_CREATED -> FORM_CREATED -> CREATIVE_SAVED -> DRAFT_SAVED -> PUBLISHED`

Terminal or paused states are `FAILED`, `UNKNOWN`, `HUMAN_ACTION_REQUIRED`, `INPUT_CHANGED`, and `STATE_MISMATCH`.

An intent record does not advance `state`. Give the action a locally unique `actionId`, and include the intended object type and stable request fingerprint. After Meta confirms the result, append a new record with the resulting object ID when available, the next progress state, and the same `actionId` marked `confirmed`. If the UI disconnects or navigates unexpectedly after the click, leave the intent in history and append `UNKNOWN`; do not replay it.

## Resume Rules

1. Acquire the declared Profile and account locks before reading or changing Meta state.
2. Verify that the current request fingerprint matches the latest record. Stop with `INPUT_CHANGED` when it differs; do not reuse prior objects automatically.
3. Reconnect only to the already-open declared Profile and verify account, Page, and currency.
4. Reconcile object IDs in order. Prefer IDs; a name is supporting evidence, not identity. If an ID is unavailable and the name has zero or multiple matches, stop with `STATE_MISMATCH`.
5. Resume from the first unverified stage. Never recreate an object merely because its checkpoint write may have been interrupted.
6. When `lastAction.outcome` is `pending` or `unknown`, inspect Meta for the result. Confirm and checkpoint it, or stop as `UNKNOWN`; never replay a non-idempotent action.
7. Append a new record for every action intent and verified transition. Do not rewrite history or advance more than one state in a record.

Do not store publish authorization in the checkpoint. Authorization must come from the current user turn.
