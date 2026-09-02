# Playwright Probing For Meta Lead Ads

Use this reference when the current Meta Ads Manager UI may differ from the stored skill anchors. The goal is to gather just enough live page evidence to choose reliable locators without leaking account data or accidentally mutating the ad account.

## Probe Before Writing

Run a read-only probe when any of these are true:

- The account, Business, page, language, objective, or form type differs from the last verified run.
- The UI is in Simplified Chinese, Traditional Chinese, English, or a mixed locale that the current code has not handled.
- A locator would otherwise depend on CSS classes, generated IDs, element index, XPath depth, or screen coordinates.
- A dropdown/menu option needs the exact current label.
- Meta shows validation, restriction, policy, payment, identity, or advertiser-verification text.
- You are about to change code that clicks footer buttons, opens upload controls, edits instant-form fields, or chooses Meta AI enhancement options.

## What To Collect

Collect only local evidence needed for locator decisions:

- URL host, path, `act`, and `business_id`; avoid printing full URLs unless debugging locally.
- Page title.
- Restriction/blocker flags from visible body text.
- Headings and landmark text around the active editor layer.
- Visible button labels.
- Visible radio/checkbox labels.
- Combobox/select labels and selected values.
- Input placeholders and validation messages.
- Current autosave/draft text.
- Visible alert/dialog/banner text and whether it blocks Create/Continue/editor controls or only Publish.

Do not collect cookies, local storage, request headers, bearer tokens, HAR files, or full DOM snapshots unless the user explicitly asks and the output is kept local.

## Locator Preference

Prefer locators in this order:

1. `getByRole()` with a bilingual accessible name regex.
2. `getByLabel()` or `getByPlaceholder()` for form fields with stable labels/placeholders.
3. `getByText()` scoped inside a stable section.
4. Stable URL gates such as `/manage/campaigns`, `/manage/adsets/edit`, `/manage/ads/edit`.
5. Short DOM selectors only for generic element type discovery during read-only probing.

Avoid:

- Meta generated class names.
- Long XPath chains.
- `nth()` as the only disambiguator.
- Clicking by coordinates.
- Reusing an `ElementHandle` across scroll/autosave/rerender.

## Complete The Creative Overlay

Meta may present the creative editor as a multi-stage overlay with tabs such as `影音素材`, `裁切`, `文字`, `圖像產生`, `強化效果`, and `翻譯`.

- Uploaded user media and AI-generated media are separate selections. A draft can continue with zero AI-generated images; do not click `生成新圖像` or select generated variants unless the user requested them.
- Inspect enhancement switches, but do not change Meta's current defaults merely to advance the wizard. Re-probe after each stage because the overlay rerenders.
- A later tab such as `翻譯` may be visible but disabled. Treat an `aria-disabled="true"` tab as an unavailable optional stage; do not force-click it.
- The overlay's unique enabled `完成` control closes and applies the creative configuration. It is not the global `發佈` control. After clicking `完成`, wait for `正在驗證` / `Validating` to clear and require `已儲存所有編輯內容` / `All edits saved` before declaring the draft complete.
- Verify the creative in the rendered ad preview after the overlay closes. For test runs, visible `TEST ONLY` markings should remain legible in the selected placements.

## Stop Conditions

Stop and report instead of continuing when:

- The correct Ads Manager tab is absent.
- The account ID or Business ID does not match the intended job.
- A login, 2FA, CAPTCHA, payment confirmation, identity check, or advertiser-verification challenge blocks access to the requested draft editor. These actions are human-only.
- The page explicitly says the account cannot create or run ads, or is restricted/disabled.
- A target click has zero matches or multiple plausible matches after scoping.
- The visible page language is unsupported by the current locator regex.
- Publish/review controls are the next step and the user has not freshly authorized publishing.

Do not stop a draft-only run merely because:

- A navigation item contains `付款`, `payment`, `验证`, or `verification`.
- A banner says account details must be confirmed before publishing while Create/Continue and the draft editor remain available. Record `PUBLISH_BLOCKED_ACCOUNT_DETAILS`, do not open the confirmation flow, and continue only to the requested saved-draft/review boundary.

Match blocker text inside a visible alert, dialog, challenge, or nearby control context when possible. Full-body substring matches are evidence candidates, not final blocker classifications.

## Read-Only Probe Command

From this repository after `npm ci`:

```powershell
node skills/meta-lead-ads-flow/scripts/probe-meta-lead-ads-page.mjs --profile=<ADSPOWER_PROFILE_ID>
```

If AdsPower has already produced a CDP websocket URL through another approved tool:

```powershell
node skills/meta-lead-ads-flow/scripts/probe-meta-lead-ads-page.mjs --cdp=<CDP_WS_URL>
```

The script does not click, fill, navigate, or publish. It enumerates current Ads Manager tabs and visible control labels. Raw output is for local diagnosis and should normally stay out of Git.
