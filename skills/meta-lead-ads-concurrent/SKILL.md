---
name: meta-lead-ads-concurrent
description: Coordinate multiple Meta lead-ad jobs across explicit AdsPower profiles, including parallel draft preparation and bounded publishing after fresh authorization. Use for multi-browser or batch Meta Leads + instant-form work; not for choosing profiles implicitly, bypassing account checks, or treating a batch request as publish approval.
---

# Meta Lead Ads Concurrent

Coordinate isolated Meta Leads jobs without mixing browser profiles, ad accounts, currencies, drafts, or publish outcomes. For the UI workflow inside each job, read the adjacent `../meta-lead-ads-flow/SKILL.md` and use its committed single-job runner. The coordinator schedules workers; it does not maintain a second implementation of Meta locators or dialog flows.

## Authorization Boundary

- A request to prepare jobs, build automation, test concurrency, or create drafts is not permission to publish.
- Publish only when the user gives fresh authorization in the current turn for the exact job IDs being published. Before acting, show or verify each job's account, page, budget amount and currency, and intended object count.
- A manifest field such as `targetState: "published"` records intent but never substitutes for current-turn authorization.
- CAPTCHA, 2FA, payment confirmation, advertiser verification, identity checks, and account-detail confirmation remain human-only.
- Never retry an ambiguous publish action. Record `UNKNOWN` and stop that job for human review.

## Job Isolation

- Require an explicit job manifest. Read [references/job-manifest.md](references/job-manifest.md) before validating or running a batch.
- For write work, connect only to a Profile that a human has already opened and confirmed for the current batch. Resolve it by the declared `profileId`; never start, switch, or select the first active Profile automatically.
- Before mutation, connect to that exact Profile and verify the visible Ads Manager `act` account, Facebook Page, and account currency against the job.
- Use a separate browser/CDP connection and fresh page locators per worker. Do not share `Page`, locator, dialog, or autosave state between jobs.
- Keep at most one active writer per AdsPower Profile and one active writer per Meta `adAccountId`. Acquire both locks before the first write and retain them until the job reaches `DRAFT_SAVED` or `PUBLISHED`, or stops in any terminal or paused state. Release both locks together; never leave one held after the worker exits.
- Treat budget as `{ amount, currency, kind }`. Reject a numeric value without a currency, and reject a UI currency mismatch rather than converting implicitly.

## Worker Contract

- Load and validate each job's `requestPath` before starting a browser worker. Its `jobId`, `profileId`, `adAccountId`, `page.id`, optional `businessId`, and complete budget tuple must match the manifest. Stop that job before CDP connection on any mismatch.
- Run one base draft runner process per eligible job. The coordinator must ensure that workers sharing a Profile or account do not overlap; the runner's Profile and account locks are a final backstop, not the scheduler.
- Give every worker its own diagnostics directory. Use the manifest's append-only checkpoint path or an explicitly derived per-job path, and preserve `jobId` as the record key.
- Keep the base runner as the sole owner of its CDP connection, `Page`, locators, dialogs, field readback, autosave checks, and stage screenshots. The coordinator observes process results and schedules jobs; it must not click or fill the worker's page.
- Reuse `../meta-lead-ads-flow/scripts/run-meta-lead-draft.mjs` and its core helpers directly. Do not copy their locators, waits, retry logic, or UI-stage implementation into the concurrent Skill.

## Agent-Per-Profile Mode

When subagent delegation is available, use one coordinator Agent plus one child Agent per concurrently active AdsPower Profile. This is the preferred mode for true multi-browser execution.

- The coordinator validates the complete manifest, forms non-conflicting Profile/account groups, assigns jobs, waits for results, and produces the batch report. It must not connect to or operate a worker's browser.
- Assign each child Agent exactly one job and one declared Profile at a time. That Agent owns the job's runner process and CDP connection until it reports a terminal or paused state; it must not switch to another active Profile or operate another Agent's page.
- Compute active child count at runtime as the minimum of the manifest limit, currently available child-Agent slots, and non-conflicting Profile/account groups. Never hardcode a platform slot count in the Skill or manifest. Queue excess jobs.
- Give a child Agent only its job slice, exact request/checkpoint/diagnostics paths, and the base Flow Skill. The child must run the read-only identity and currency checks before its first write and return the verified job state to the coordinator.
- A child Agent may perform only one semantic UI operation at a time. Parallelism exists between isolated child Agents, never between pages or tabs owned by one child.
- If a child exits, disconnects, or is replaced, the next child must acquire the same locks and reconcile the durable checkpoint with Meta before continuing. A `pending` or `UNKNOWN` non-idempotent action must never be replayed automatically.
- If subagent delegation is unavailable, use isolated runner processes under the same worker contract. Do not compensate by having one Agent rapidly interleave UI operations across multiple browsers.

## UI Operation Discipline

- Within one Profile, allow only one in-flight semantic UI operation. Different confirmed Profiles and accounts may progress concurrently within the global limit.
- After navigation, require the expected URL path or heading. After a field write, read back the normalized value or selected state. After a mutation, wait for validation to finish and autosave to settle before checkpointing.
- Do not require autosave after a read-only probe or a click that only opens a dialog. Use the expected dialog or section as its completion condition.
- Fill and verify fields one at a time. For formatted currency inputs, select all, clear, type deliberately, blur, and verify both normalized amount and displayed account currency.
- Reacquire an input locator after a fill and before blur/readback because a React rerender can detach the original node. Find budget kind and currency from the nearest labeled budget section, not from a fixed parent depth.
- Treat creative setup as state transitions: select the requested media type before waiting for the media dialog, and verify the expected copy labels and unique visible fields before assigning values by position. Do not assume that two consecutive creative dialogs share the same DOM node.
- An ordinary idempotent operation may have at most two attempts: the initial attempt and one retry after a fresh probe. Never use an unbounded retry loop or retry merely because a fixed delay elapsed.
- Do not automatically retry Campaign, Ad Set, Form, creative, or publish creation after an ambiguous result. Reconcile against the checkpoint and Meta state first; an ambiguous publish is always `UNKNOWN`.
- Immediately before each non-idempotent create or publish click, append a `pending` action record without advancing the last verified state. Append the next progress state only after Meta confirms the result.

## Execution

1. Validate the local manifest:

   ```powershell
   node scripts/validate-job-manifest.mjs <manifest.json>
   ```

2. Confirm that every declared Profile is already open, then run a read-only probe for each one. Do not mutate any job until every job has a resolved Profile, exactly one intended Ads Manager tab, matching account/page/currency, and a classified gate.
3. Schedule draft work with the manifest's bounded concurrency. Default to two workers when unspecified; apply Profile and account locks regardless of the global limit. When subagents are available, use Agent-Per-Profile Mode and queue jobs beyond the current child-Agent capacity.
4. Before resuming or writing, read the base workflow's [checkpoint protocol](../meta-lead-ads-flow/references/checkpoints.md), acquire both locks, and reconcile the latest checkpoint with Meta. A missing checkpoint after an ambiguous create action is not proof that the action failed.
5. Start the committed single-job runner for each scheduled draft, using the job's request, the manifest checkpoint, and a job-specific diagnostics directory:

   ```powershell
   npm run run:draft -- --request=<requestPath> --checkpoint=<checkpointPath> --diagnostics=.meta-lead-ads/diagnostics/<jobId>
   ```

   Persist monotonic checkpoints at `PREFLIGHT_OK`, `CAMPAIGN_SAVED`, `ADSET_SAVED`, `AD_CREATED`, `FORM_CREATED`, `CREATIVE_SAVED`, and `DRAFT_SAVED`, plus terminal failure states.
6. Report the complete draft review table. If fresh publish authorization is absent or narrower than the batch, stop all unauthorized jobs at `DRAFT_SAVED`.
7. For authorized jobs only, re-probe immediately before publishing, then publish with the configured publish concurrency while retaining per-account serialization.
8. Confirm each result from Meta. Record `PUBLISHED`, `FAILED`, or `UNKNOWN`; do not claim batch success from the click alone.

## Failure Semantics

- Fail one job without cancelling unrelated jobs unless the user requested fail-fast behavior.
- Never discard or overwrite pre-existing unpublished changes.
- Meta publishing is not atomic. Do not claim rollback for a partially published batch, and do not delete successful objects to imitate rollback.
- On Profile/account/page/currency mismatch, stop only the affected job before mutation and report the exact mismatch without exposing secrets.
- Stop the affected job immediately on a real CAPTCHA, Checkpoint, login, verification, account restriction, unexpected top-level navigation, page replacement, or CDP disconnect. Do not classify instructional authentication text inside an instant-form preview as a blocker.
- A normal React rerender or autosave refresh is not an abnormal refresh. Reacquire locators and continue only when the URL, account, expected editor section, and last verified value remain consistent.
- If navigation, page replacement, or disconnection occurs after a non-idempotent click, record `UNKNOWN` and reconcile manually; do not replay the click.
- Keep manifests containing real IDs, screenshots, DOM dumps, traces, and audit JSONL local and ignored by Git. Commit only reviewed placeholder examples or redacted fixtures.

## Completion Report

Report elapsed time, peak concurrency, serialized Profile/account groups, per-job terminal state, budget with currency, any publish-only notices, and whether each publish control was clicked. Distinguish confirmed `PUBLISHED` from `UNKNOWN`.
