#!/usr/bin/env node
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import {
  acquireWriterLocks,
  appendCheckpoint,
  assertResumeAllowed,
  checkpointRecord,
  confirmAction,
  hasExpectedCreativeCopyFields,
  nearestBudgetText,
  objectsForState,
  openImageCreative,
  pendingAction,
  readLatestCheckpoint,
  requestFingerprint,
  validateDraftRequest,
  withAtMostOneRetry,
  writeInputAndBlur,
} from "./draft-runner-core.mjs";
import {
  accessBlockerPatterns,
  buildAccessEvidence,
  flagsFromText,
  publishOnlyPatterns,
  restrictionPatterns,
} from "./probe-classification.mjs";

const SAVED_PATTERN = /已保存所有编辑内容|已儲存所有編輯內容|All edits saved/i;
const VALIDATING_PATTERN = /正在验证|正在驗證|Validating/i;
const TEST_FIELD_TIMEOUT = 5_000;
const DIALOG_TIMEOUT = 15_000;
const NAVIGATION_TIMEOUT = 30_000;
const CREATE_TIMEOUT = 30_000;
const CREATIVE_TIMEOUT = 45_000;

function arg(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function usage() {
  console.log(`Usage:
  node run-meta-lead-draft.mjs --request=<request.json> [--checkpoint=<state.jsonl>] [--diagnostics=<directory>] [--preflight-only]

The declared AdsPower Profile must already be open. This runner creates and saves a draft only; it never publishes.`);
}

function safeName(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "job";
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function visible(locator) {
  return locator.filter({ visible: true });
}

async function visibleTexts(page, selector, limit = 30) {
  return page.locator(selector).evaluateAll((elements, maxItems) => elements
    .filter((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    })
    .map((element) => (element.getAttribute("aria-label") || element.innerText || element.textContent || "")
      .replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, maxItems), limit).catch(() => []);
}

async function waitUntil(check, { timeout, label, stableMs = 300 }) {
  const deadline = Date.now() + timeout;
  let stableSince = 0;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= stableMs) return;
      } else {
        stableSince = 0;
      }
    } catch (error) {
      if (error.code === "AMBIGUOUS_TARGET") throw error;
      lastError = error;
      stableSince = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} did not stabilize within ${timeout}ms${lastError ? `: ${lastError.message}` : ""}`);
}

async function uniqueVisible(factory, label, { scrollAnchor } = {}) {
  return withAtMostOneRetry(async (attempt) => {
    const target = visible(factory());
    const count = await target.count();
    if (count > 1) {
      const error = new Error(`${label}: expected one visible target, found ${count}`);
      error.code = "AMBIGUOUS_TARGET";
      throw error;
    }
    if (count === 0) {
      const error = new Error(`${label}: no visible target on attempt ${attempt}`);
      error.code = "TARGET_NOT_VISIBLE";
      throw error;
    }
    return target;
  }, async (error) => {
    if (error.code !== "TARGET_NOT_VISIBLE") throw error;
    if (scrollAnchor) {
      const anchor = visible(scrollAnchor());
      const anchorCount = await anchor.count();
      if (anchorCount > 1) throw new Error(`${label} anchor: expected at most one visible target, found ${anchorCount}`);
      if (anchorCount === 1) await anchor.scrollIntoViewIfNeeded();
    }
    await waitUntil(async () => await visible(factory()).count() > 0, {
      timeout: 1_500,
      label: `${label} fresh probe`,
      stableMs: 0,
    });
  });
}

async function waitForPath(page, pattern, label, timeout = NAVIGATION_TIMEOUT) {
  await waitUntil(() => pattern.test(new URL(page.url()).pathname), { timeout, label });
}

async function waitForSaved(page, label, timeout = NAVIGATION_TIMEOUT) {
  await waitUntil(async () => {
    const text = await page.locator("body").innerText({ timeout: TEST_FIELD_TIMEOUT });
    return SAVED_PATTERN.test(text) && !VALIDATING_PATTERN.test(text);
  }, { timeout, label, stableMs: 500 });
}

async function waitForDialog(page, label) {
  await waitUntil(async () => {
    const count = await visible(page.getByRole("dialog")).count();
    if (count > 1) {
      const error = new Error(`${label}: expected one visible dialog, found ${count}`);
      error.code = "AMBIGUOUS_TARGET";
      throw error;
    }
    return count === 1;
  }, {
    timeout: DIALOG_TIMEOUT,
    label,
  });
  return uniqueVisible(() => page.getByRole("dialog"), label);
}

async function fillAndVerify(factory, label, value, {
  page,
  autosave = false,
  sequential = false,
  normalize = (current) => current,
} = {}) {
  const input = await uniqueVisible(factory, label);
  await input.scrollIntoViewIfNeeded();
  await writeInputAndBlur({
    input,
    reacquire: () => uniqueVisible(factory, label),
    value,
    sequential,
  });
  await waitUntil(async () => {
    const current = await uniqueVisible(factory, label);
    return normalize(await current.inputValue()) === normalize(String(value));
  }, { timeout: TEST_FIELD_TIMEOUT, label: `${label} readback` });
  if (autosave) await waitForSaved(page, `${label} autosave`);
}

async function clickAndWait(target, completion, label, timeout = DIALOG_TIMEOUT) {
  await target.click();
  await waitUntil(completion, { timeout, label });
}

function apiUrl(endpoint, profileId) {
  const url = new URL(endpoint, process.env.ADSPOWER_API_URL ?? "http://127.0.0.1:50325");
  url.searchParams.set("user_id", profileId);
  if (process.env.ADS_API_KEY) url.searchParams.set("api_key", process.env.ADS_API_KEY);
  return url;
}

async function resolveActiveCdp(profileId) {
  const response = await fetch(apiUrl("/api/v1/browser/active", profileId), { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`AdsPower active-profile check returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.code !== 0 || !payload.data?.ws?.puppeteer) {
    const error = new Error("the declared AdsPower Profile is not already open");
    error.code = "HUMAN_ACTION_REQUIRED";
    throw error;
  }
  return payload.data.ws.puppeteer;
}

async function hasVisibleAuthControl(page) {
  return page.locator([
    'input[type="password"]',
    'input[autocomplete="one-time-code"]',
    'input[name="approvals_code"]',
    '[data-testid*="captcha"]',
    'iframe[src*="captcha"]',
  ].join(",")).evaluateAll((elements) => elements.some((element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  })).catch(() => false);
}

async function classifyPage(page) {
  const bodyText = await page.locator("body").innerText({ timeout: TEST_FIELD_TIMEOUT }).catch(() => "");
  const surfaceTexts = await visibleTexts(page, '[role=alert],[role=alertdialog],[role=dialog],[aria-modal="true"]', 20);
  const accessEvidence = buildAccessEvidence({
    surfaceTexts,
    bodyText,
    pageUrl: page.url(),
    hasVisibleAuthControl: await hasVisibleAuthControl(page),
    frameUrls: page.frames().map((frame) => frame.url()),
  });
  return {
    access: flagsFromText(accessEvidence, accessBlockerPatterns),
    restrictions: flagsFromText(bodyText, restrictionPatterns),
    publishOnly: flagsFromText(bodyText, publishOnlyPatterns),
  };
}

async function ensureWritablePage(page) {
  const classification = await classifyPage(page);
  if (classification.restrictions.length) {
    const error = new Error("the ad account is restricted from creating or running ads");
    error.code = "FAILED";
    throw error;
  }
  if (classification.access.length) {
    const error = new Error("a login, CAPTCHA, verification, or payment challenge requires human action");
    error.code = "HUMAN_ACTION_REQUIRED";
    throw error;
  }
  return classification;
}

async function currencyNearInput(input) {
  return input.evaluate((element) => {
    let current = element.parentElement;
    for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
      const codes = (current.innerText || "").match(/\b[A-Z]{3}\b/g);
      if (codes?.length) return [...new Set(codes)];
    }
    return [];
  });
}

async function main() {
  if (hasFlag("help") || !arg("request")) {
    usage();
    process.exitCode = hasFlag("help") ? 0 : 2;
    return;
  }

  const input = JSON.parse(await readFile(arg("request"), "utf8"));
  const validation = validateDraftRequest(input);
  if (!validation.valid) throw new Error(`invalid draft request:\n${validation.errors.join("\n")}`);
  const request = validation.request;
  const jobName = safeName(request.jobId);
  const checkpointPath = arg("checkpoint") ?? `.meta-lead-ads/checkpoints/${jobName}.jsonl`;
  if (/^https?:\/\//i.test(checkpointPath) || path.extname(checkpointPath).toLowerCase() !== ".jsonl") {
    throw new Error("checkpoint must be a local .jsonl path");
  }
  const diagnosticsDir = arg("diagnostics") ?? `.meta-lead-ads/diagnostics/${jobName}`;
  const preflightOnly = hasFlag("preflight-only");
  const auditPath = path.join(diagnosticsDir, "timings.jsonl");
  const fingerprint = requestFingerprint(request);
  let lock;
  let page;
  let state = "START";
  let lastAction;
  let publishOnlyNotice = false;

  await mkdir(diagnosticsDir, { recursive: true });
  const audit = async (record) => appendFile(auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf8");
  const timed = async (name, operation) => {
    const started = performance.now();
    try {
      const result = await operation();
      await audit({ operation: name, outcome: "confirmed", elapsedMs: Math.round(performance.now() - started) });
      return result;
    } catch (error) {
      await audit({ operation: name, outcome: "failed", elapsedMs: Math.round(performance.now() - started), code: error.code ?? "ERROR" });
      throw error;
    }
  };
  const saveStageScreenshot = async (name) => {
    if (!page) return;
    await page.screenshot({ path: path.join(diagnosticsDir, `${name}.png`) }).catch(() => {});
  };
  const appendState = async (nextState, action) => {
    const objectState = nextState === "FAILED"
      || nextState === "UNKNOWN"
      || nextState === "HUMAN_ACTION_REQUIRED"
      || nextState === "INPUT_CHANGED"
      || nextState === "STATE_MISMATCH"
      ? state
      : nextState;
    state = nextState;
    await appendCheckpoint(checkpointPath, checkpointRecord({
      request,
      fingerprint,
      state,
      objects: objectsForState(request, objectState),
      page: page ? { path: new URL(page.url()).pathname, saveState: SAVED_PATTERN.test(await page.locator("body").innerText().catch(() => "")) ? "ALL_EDITS_SAVED" : "UNCONFIRMED" } : {},
      lastAction: action,
    }));
  };
  const nonIdempotent = async (kind, nextState, operation) => {
    const action = pendingAction(kind);
    lastAction = action;
    await appendState(state === "START" ? "PREFLIGHT_OK" : state, action);
    try {
      await operation();
    } catch (error) {
      lastAction = { ...action, outcome: "unknown" };
      await appendState("UNKNOWN", lastAction);
      error.code = "UNKNOWN";
      throw error;
    }
    lastAction = confirmAction(action);
    try {
      await appendState(nextState, lastAction);
    } catch (error) {
      error.code = "UNKNOWN";
      throw error;
    }
  };

  try {
    lock = await acquireWriterLocks({ profileId: request.profileId, adAccountId: request.adAccountId });
    if (!preflightOnly) {
      const latest = await readLatestCheckpoint(checkpointPath, request.jobId);
      state = assertResumeAllowed(latest, fingerprint);
      if (state === "DRAFT_SAVED" || state === "PUBLISHED") {
        console.log(JSON.stringify({ jobId: request.jobId, state, resumed: true, publishClicked: false }, null, 2));
        return;
      }
    }

    const ws = await resolveActiveCdp(request.profileId);
    const browser = await chromium.connectOverCDP(ws);
    const adsPages = browser.contexts().flatMap((context) => context.pages())
      .filter((candidate) => candidate.url().includes("adsmanager.facebook.com"));
    if (adsPages.length !== 1) throw new Error(`expected exactly one Ads Manager tab, found ${adsPages.length}`);
    [page] = adsPages;
    const currentUrl = new URL(page.url());
    if (currentUrl.searchParams.get("act") !== request.adAccountId) {
      const error = new Error("visible Ads Manager account does not match the request");
      error.code = "STATE_MISMATCH";
      throw error;
    }
    const classification = await timed("preflight", () => ensureWritablePage(page));
    publishOnlyNotice ||= classification.publishOnly.length > 0;
    if (preflightOnly) {
      console.log(JSON.stringify({
        jobId: request.jobId,
        state: "PREFLIGHT_OK",
        readOnly: true,
        publishOnlyNotice,
        publishClicked: false,
      }, null, 2));
      return;
    }
    if (state === "START") await appendState("PREFLIGHT_OK");

    if (state === "PREFLIGHT_OK") {
      await timed("open_campaign_create", async () => {
        const target = new URL("https://adsmanager.facebook.com/adsmanager/manage/campaigns");
        target.searchParams.set("act", request.adAccountId);
        if (request.businessId) target.searchParams.set("business_id", request.businessId);
        await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT });
        await waitForPath(page, /\/adsmanager\/manage\/campaigns$/, "campaign list navigation");
        const create = await uniqueVisible(() => page.getByRole("button", { name: /^(建立|创建|Create)$/i }), "Create button");
        await clickAndWait(create, async () => await visible(page.getByRole("dialog")).count() === 1, "Create dialog");
        const createClassification = await ensureWritablePage(page);
        publishOnlyNotice ||= createClassification.publishOnly.length > 0;
        const dialog = await waitForDialog(page, "Create dialog");
        const leads = await uniqueVisible(() => dialog.getByRole("heading", { name: /^(開發潛在顧客|开发潜在顾客|潜在客户|Leads)$/i }), "Leads objective");
        await leads.click();
        await waitUntil(async () => {
          const button = visible(dialog.getByRole("button", { name: /^(繼續|继续|Continue)$/i }));
          return await button.count() === 1 && await button.getAttribute("aria-disabled") !== "true";
        }, { timeout: DIALOG_TIMEOUT, label: "enabled Create Continue button" });
      });

      await nonIdempotent("create_campaign_tree", "CAMPAIGN_SAVED", async () => {
        const dialog = await waitForDialog(page, "Create dialog");
        const continueButton = await uniqueVisible(() => dialog.getByRole("button", { name: /^(繼續|继续|Continue)$/i }), "Create Continue button");
        await continueButton.click();
        await waitForPath(page, /\/campaigns\/edit\/standalone$/, "campaign editor", CREATE_TIMEOUT);
        await fillAndVerify(
          () => page.getByPlaceholder(/請在這裡輸入你的行銷活動名稱|请输入.*广告系列名称|campaign name/i),
          "Campaign name",
          request.names.campaign,
          { page, autosave: true },
        );
        const amountFactory = () => page.getByPlaceholder(/請輸入金額|请输入金额|enter amount/i);
        const amountInput = await uniqueVisible(amountFactory, "Campaign budget amount");
        const nearbyCurrency = await currencyNearInput(amountInput);
        if (!nearbyCurrency.includes(request.budget.currency)) {
          const error = new Error(`budget currency mismatch: expected ${request.budget.currency}, visible ${nearbyCurrency.join(",") || "none"}`);
          error.code = "STATE_MISMATCH";
          throw error;
        }
        const budgetArea = await nearestBudgetText(amountInput);
        const expectedKind = request.budget.kind === "daily"
          ? /單日預算|每日预算|Daily budget/i
          : /總預算|总预算|Lifetime budget/i;
        if (!expectedKind.test(budgetArea)) {
          const error = new Error(`visible budget kind does not match requested ${request.budget.kind}`);
          error.code = "STATE_MISMATCH";
          throw error;
        }
        await fillAndVerify(amountFactory, "Campaign budget amount", request.budget.amount, {
          page,
          autosave: true,
          sequential: true,
          normalize: (current) => Number(String(current).replaceAll(",", "")),
        });
        await saveStageScreenshot("campaign-saved");
      });
    }

    if (state === "CAMPAIGN_SAVED") {
      await timed("open_adset_editor", async () => {
        if (/\/campaigns\/edit\/standalone$/.test(new URL(page.url()).pathname)) {
          const next = await uniqueVisible(() => page.getByRole("button", { name: /^(繼續|继续|Continue)$/i }), "Campaign Continue button");
          await next.click();
        }
        await waitForPath(page, /\/adsets\/edit\/standalone$/, "ad set editor");
      });
      await timed("configure_adset", async () => {
        await fillAndVerify(
          () => page.getByPlaceholder(/在這裡輸入廣告組合名稱|请输入.*广告组名称|ad set name/i),
          "Ad Set name",
          request.names.adSet,
          { page, autosave: true },
        );
        await uniqueVisible(() => page.getByRole("combobox").filter({ hasText: /即時表單|即时表单|Instant forms/i }), "Instant forms conversion location");
        const pagePattern = new RegExp(escapeRegex(request.page.name), "i");
        await uniqueVisible(() => page.getByRole("combobox").filter({ hasText: pagePattern }), "Facebook Page selection");
        await waitForSaved(page, "Ad Set autosave");
        await saveStageScreenshot("adset-saved");
        await appendState("ADSET_SAVED");
      });
    }

    if (state === "ADSET_SAVED") {
      await timed("open_ad_editor", async () => {
        if (/\/adsets\/edit\/standalone$/.test(new URL(page.url()).pathname)) {
          const next = await uniqueVisible(() => page.getByRole("button", { name: /^(繼續|继续|Continue)$/i }), "Ad Set Continue button");
          await next.click();
        }
        await waitForPath(page, /\/ads\/edit\/standalone$/, "ad editor");
      });
      await timed("configure_ad", async () => {
        const adNameFactory = () => page.getByPlaceholder(/在這裡輸入廣告名稱|请输入.*广告名称|ad name/i);
        await fillAndVerify(adNameFactory, "Ad name", request.names.ad, { page, autosave: true });
        await appendState("AD_CREATED");
      });
    }

    if (state === "AD_CREATED") {
      await timed("prepare_instant_form", async () => {
        const formAnchor = () => page.getByRole("heading", { name: /^(即時表單|即时表单|Instant form)$/i });
        const openForm = await uniqueVisible(
          () => page.getByRole("button", { name: /^(建立即時表單|创建即时表单|Create (instant )?form)$/i }),
          "Create instant form button",
          { scrollAnchor: formAnchor },
        );
        await clickAndWait(openForm, async () => await visible(page.getByRole("dialog")).count() === 1, "Create form choice dialog");
        let dialog = await waitForDialog(page, "Create form choice dialog");
        const custom = await uniqueVisible(() => dialog.getByRole("button").filter({ hasText: /建立專屬表單|创建专属表单|custom form/i }), "Custom form option");
        await custom.click();
        const continueButton = await uniqueVisible(() => dialog.getByRole("button", { name: /^(繼續|继续|Continue)$/i }), "Form choice Continue button");
        await continueButton.click();
        await waitUntil(async () => {
          dialog = await waitForDialog(page, "Form editor dialog");
          return await visible(dialog.getByPlaceholder(/命名表單|命名表单|name.*form/i)).count() === 1;
        }, { timeout: DIALOG_TIMEOUT, label: "Form editor" });

        await fillAndVerify(() => dialog.getByPlaceholder(/命名表單|命名表单|name.*form/i), "Form name", request.names.form);
        let next = await uniqueVisible(() => dialog.getByRole("button", { name: /^(下一步|Next)$/i }), "Form type Next button");
        await next.click();
        await waitUntil(async () => await visible(dialog.getByPlaceholder(/輸入簡短標題|输入简短标题|short headline/i)).count() === 1, { timeout: DIALOG_TIMEOUT, label: "Form intro page" });

        await fillAndVerify(() => dialog.getByPlaceholder(/輸入簡短標題|输入简短标题|short headline/i), "Intro title", request.form.introTitle);
        await fillAndVerify(() => dialog.getByPlaceholder(/新增更多詳細資訊|添加更多详细信息|more details/i), "Intro description", request.form.introDescription);
        next = await uniqueVisible(() => dialog.getByRole("button", { name: /^(下一步|Next)$/i }), "Intro Next button");
        await next.click();
        await waitUntil(async () => await visible(dialog.getByPlaceholder(/輸入訊息|输入信息|Enter message/i)).count() === 1, { timeout: DIALOG_TIMEOUT, label: "Form questions page" });

        await fillAndVerify(() => dialog.getByPlaceholder(/輸入訊息|输入信息|Enter message/i), "Data-use disclosure", request.form.dataUse);
        next = await uniqueVisible(() => dialog.getByRole("button", { name: /^(下一步|Next)$/i }), "Questions Next button");
        await next.click();
        await waitUntil(async () => await visible(dialog.getByRole("textbox", { name: /^(連結|链接|Link)$/i })).count() === 1, { timeout: DIALOG_TIMEOUT, label: "Form privacy page" });

        await fillAndVerify(() => dialog.getByRole("textbox", { name: /^(連結|链接|Link)$/i }), "Privacy URL", request.form.privacyUrl);
        await fillAndVerify(() => dialog.getByLabel(/連結文字|链接文字|Link text/i), "Privacy link text", request.form.privacyLinkText);
        next = await uniqueVisible(() => dialog.getByRole("button", { name: /^(下一步|Next)$/i }), "Privacy Next button");
        await next.click();
        await waitUntil(async () => await visible(dialog.getByRole("textbox", { name: /^(連結|链接|Link)$/i })).count() === 0, {
          timeout: DIALOG_TIMEOUT,
          label: "Form review page",
        });
        next = await uniqueVisible(() => dialog.getByRole("button", { name: /^(下一步|Next)$/i }), "Review Next button");
        await next.click();
        await waitUntil(async () => await visible(dialog.getByLabel(/^標題|^标题|^Headline/i)).count() === 1, { timeout: DIALOG_TIMEOUT, label: "Form completion page" });

        await fillAndVerify(() => dialog.getByLabel(/^標題|^标题|^Headline/i), "Completion title", request.form.completionTitle);
        await fillAndVerify(() => dialog.getByLabel(/^(說明|说明|Description)$/i), "Completion description", request.form.completionDescription);
        await fillAndVerify(() => dialog.getByRole("textbox", { name: /^(連結|链接|Link)$/i }), "Completion URL", request.form.completionUrl);
        await fillAndVerify(() => dialog.getByLabel(/行動呼籲|行动号召|Call to action/i), "Completion CTA", request.form.completionCta);
      });

      await nonIdempotent("create_form", "FORM_CREATED", async () => {
        const dialog = await waitForDialog(page, "Form editor dialog");
        const create = await uniqueVisible(() => dialog.getByRole("button", { name: /^(建立表單|创建表单|Create form)$/i }), "Create form submit button");
        await create.click();
        await waitUntil(async () => {
          if (await visible(page.getByRole("dialog")).count() !== 0) return false;
          return (await page.locator("body").innerText()).includes(request.names.form);
        }, { timeout: CREATE_TIMEOUT, label: "created form selection", stableMs: 500 });
        await waitForSaved(page, "Form creation autosave");
        await saveStageScreenshot("form-created");
      });
    }

    if (state === "FORM_CREATED") {
      await timed("prepare_creative", async () => {
        const creativeAnchor = () => page.getByRole("heading", { name: /^(廣告創意|广告创意|Ad creative)$/i });
        const setup = await uniqueVisible(
          () => page.getByRole("button").filter({ hasText: /設定廣告創意|设置广告创意|Set up ad creative/i }),
          "Set up ad creative button",
          { scrollAnchor: creativeAnchor },
        );
        await openImageCreative({
          setup,
          resolveImageAd: () => uniqueVisible(() => page.getByText(/^(圖像廣告|图片广告|Image ad)$/i), "Image ad option"),
          waitForDialog: () => waitForDialog(page, "Creative media dialog"),
        });
        const assetPattern = new RegExp(escapeRegex(request.creative.assetName), "i");
        await waitUntil(async () => {
          const currentDialog = visible(page.getByRole("dialog"));
          return await currentDialog.count() === 1
            && await visible(currentDialog.getByRole("button", { name: assetPattern })).count() === 1;
        }, { timeout: DIALOG_TIMEOUT, label: "Creative media picker" });
        let dialog = await waitForDialog(page, "Creative media dialog");
        const asset = await uniqueVisible(() => dialog.getByRole("button", { name: assetPattern }), "Creative asset");
        await asset.click();
        await waitUntil(async () => {
          const button = visible(dialog.getByRole("button", { name: /^(繼續|继续|Continue)$/i }));
          return await button.count() === 1 && await button.getAttribute("aria-disabled") !== "true";
        }, { timeout: DIALOG_TIMEOUT, label: "Enabled media Continue button" });
        let next = await uniqueVisible(() => dialog.getByRole("button", { name: /^(繼續|继续|Continue)$/i }), "Media Continue button");
        await next.click();
        await waitUntil(async () => /裁切|裁剪|Crop/i.test((await visible(page.getByRole("dialog")).innerText()).slice(0, 2_000)), { timeout: DIALOG_TIMEOUT, label: "Creative crop page" });
        dialog = await waitForDialog(page, "Creative crop dialog");
        next = await uniqueVisible(() => dialog.getByRole("button", { name: /^(繼續|继续|Continue)$/i }), "Crop Continue button");
        await next.click();
        await waitUntil(async () => /文字|Text/i.test((await visible(page.getByRole("dialog")).innerText()).slice(0, 2_000)), { timeout: DIALOG_TIMEOUT, label: "Creative copy page" });
        dialog = await waitForDialog(page, "Creative copy dialog");
        const copyPageText = await dialog.innerText();
        if (!hasExpectedCreativeCopyFields(copyPageText)) {
          throw new Error("Creative copy fields do not match the expected primary/headline/description order");
        }
        await waitUntil(async () => await visible(dialog.locator("textarea")).count() === 3, {
          timeout: DIALOG_TIMEOUT,
          label: "three creative copy fields",
        });
        const copyFields = () => visible(dialog.locator("textarea"));
        const primaryFactory = () => copyFields().nth(0);
        const headlineFactory = () => copyFields().nth(1);
        const descriptionFactory = () => copyFields().nth(2);
        await fillAndVerify(primaryFactory, "Primary text", request.creative.primaryText);
        await fillAndVerify(headlineFactory, "Headline", request.creative.headline);
        await fillAndVerify(descriptionFactory, "Description", request.creative.description);
        next = await uniqueVisible(() => dialog.getByRole("button", { name: /^(繼續|继续|Continue)$/i }), "Copy Continue button");
        await next.click();
        dialog = await waitForDialog(page, "Image generation dialog");
        next = await uniqueVisible(() => dialog.getByRole("button", { name: /^(繼續|继续|Continue)$/i }), "Image generation Continue button");
        await next.click();
        await waitUntil(async () => {
          dialog = await waitForDialog(page, "Creative enhancements dialog");
          return await visible(dialog.getByRole("button", { name: /^(完成|Done)$/i })).count() === 1;
        }, { timeout: DIALOG_TIMEOUT, label: "Creative enhancements page" });
      });

      await nonIdempotent("apply_creative", "CREATIVE_SAVED", async () => {
        const dialog = await waitForDialog(page, "Creative enhancements dialog");
        const done = await uniqueVisible(() => dialog.getByRole("button", { name: /^(完成|Done)$/i }), "Creative Done button");
        if (await done.getAttribute("aria-disabled") === "true") throw new Error("Creative Done button is disabled");
        await done.click();
        await waitUntil(async () => await visible(page.getByRole("dialog")).count() === 0, { timeout: CREATIVE_TIMEOUT, label: "Creative dialog close" });
        await waitUntil(async () => (await page.locator("body").innerText()).includes(request.creative.headline), { timeout: CREATIVE_TIMEOUT, label: "Creative preview" });
        await waitForSaved(page, "Creative autosave", CREATIVE_TIMEOUT);
        await saveStageScreenshot("creative-saved");
      });
    }

    if (state === "CREATIVE_SAVED") {
      await timed("verify_draft", async () => {
        await ensureWritablePage(page);
        const bodyText = await page.locator("body").innerText();
        if (!/草稿|Draft/i.test(bodyText)) throw new Error("Draft status is not visible");
        await waitForSaved(page, "Final draft autosave", CREATIVE_TIMEOUT);
        if (!bodyText.includes(request.names.campaign) || !bodyText.includes(request.names.adSet) || !bodyText.includes(request.names.ad)) {
          throw new Error("Final editor does not show all requested object names");
        }
        await saveStageScreenshot("draft-saved");
        await appendState("DRAFT_SAVED");
      });
    }

    console.log(JSON.stringify({
      jobId: request.jobId,
      state,
      budget: request.budget,
      publishOnlyNotice,
      publishClicked: false,
      checkpointPath,
      auditPath,
    }, null, 2));
  } catch (error) {
    await saveStageScreenshot("failure");
    if (page) {
      await audit({
        operation: "failure_diagnostic",
        outcome: "captured",
        code: error.code ?? "ERROR",
        path: (() => { try { return new URL(page.url()).pathname; } catch { return ""; } })(),
        dialogs: await visibleTexts(page, '[role=dialog],[role=alert],[role=alertdialog]', 10),
        headings: await visibleTexts(page, 'h1,h2,h3,[role=heading]', 20),
      }).catch(() => {});
    }
    if (lock && !preflightOnly && error.code !== "UNKNOWN") {
      const terminalState = ["HUMAN_ACTION_REQUIRED", "INPUT_CHANGED", "STATE_MISMATCH"].includes(error.code)
        ? error.code
        : "FAILED";
      await appendState(terminalState, lastAction).catch(() => {});
    }
    console.error(JSON.stringify({ valid: false, state: error.code ?? "FAILED", error: error.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await lock?.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(JSON.stringify({ valid: false, state: error.code ?? "FAILED", error: error.message }, null, 2));
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}
