#!/usr/bin/env node
import { chromium } from "playwright-core";

const restrictionPatterns = [
  /我们已限制你的广告帐号|我們已限制你的廣告帳號/i,
  /无法建立或刊登广告|無法建立或刊登廣告/i,
  /无法使用或共用广告受众|無法使用或共用廣告受眾/i,
  /ad account (is )?(restricted|limited|disabled)/i,
  /can't create or run ads|cannot create or run ads/i,
];

const accessBlockerPatterns = [
  /登录 Facebook|登入 Facebook|log in to Facebook/i,
  /输入验证码|輸入驗證碼|enter (the )?(security )?code|captcha/i,
  /需要双重验证|需要雙重驗證|two-factor authentication required|2fa required/i,
  /添加付款方式才能|新增付款方式才能|payment method (is )?required/i,
  /完成广告主验证才能|完成廣告主驗證才能|complete advertiser verification/i,
  /完成身份验证才能|完成身分驗證才能|complete identity verification/i,
];

const publishOnlyPatterns = [
  /需要(账号|帳號)(资料|資料)[\s\S]{0,500}前往(账号|帳號)(总览|總覽)/i,
  /需要先(确认|確認)[\s\S]{0,300}(帐号|帳號|账户|帳戶)[\s\S]{0,300}(资料|資料)[\s\S]{0,300}才能[\s\S]{0,100}(发布|發佈|刊登)(广告|廣告)/i,
  /need to confirm[\s\S]{0,300}account[\s\S]{0,300}(details|information)[\s\S]{0,300}before[\s\S]{0,100}publish/i,
];

function arg(name) {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function usage() {
  console.log(`Usage:
  node probe-meta-lead-ads-page.mjs --profile=<ADSPOWER_PROFILE_ID> [--start]
  node probe-meta-lead-ads-page.mjs --cdp=<CDP_WS_URL>

Options:
  --profile=<id>     AdsPower profile ID. Uses /browser/active by default.
  --start            If /browser/active has no CDP URL, call /browser/start.
  --cdp=<url>        Connect directly to an existing CDP websocket URL.
  --include-url      Include full page URLs in output. Default omits query strings.
  --help             Show this help.

This probe is read-only after CDP connection: it does not click, fill, navigate, or publish.`);
}

if (hasFlag("help")) {
  usage();
  process.exit(0);
}

const cdpArg = arg("cdp");
const profileId = arg("profile");
const includeUrl = hasFlag("include-url");
const shouldStart = hasFlag("start");

if (!cdpArg && !profileId) {
  usage();
  process.exit(2);
}

function apiUrl(path, profile) {
  const url = new URL(path, process.env.ADSPOWER_API_URL ?? "http://127.0.0.1:50325");
  url.searchParams.set("user_id", profile);
  if (process.env.ADS_API_KEY) url.searchParams.set("api_key", process.env.ADS_API_KEY);
  return url;
}

async function callAdsPower(path, profile) {
  const response = await fetch(apiUrl(path, profile), { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`AdsPower Local API ${path} returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.code !== 0) {
    throw new Error(`AdsPower Local API ${path} failed: ${payload.msg ?? payload.code}`);
  }
  return payload;
}

function parseActive(payload) {
  const ws = payload.data?.ws?.puppeteer;
  if (!ws) return null;
  return {
    status: payload.data?.status ?? "Active",
    cdpWsUrl: ws,
    debugPort: payload.data?.debug_port ?? "",
  };
}

async function resolveCdp() {
  if (cdpArg) return { source: "direct-cdp", cdpWsUrl: cdpArg, status: "provided", debugPort: "" };

  const active = parseActive(await callAdsPower("/api/v1/browser/active", profileId));
  if (active) return { source: "adspower-active", ...active };

  if (!shouldStart) {
    throw new Error("AdsPower profile is not active. Re-run with --start only after current authorization.");
  }

  const started = parseActive(await callAdsPower("/api/v1/browser/start", profileId));
  if (!started) throw new Error("AdsPower returned no CDP websocket after /browser/start");
  return { source: "adspower-start", ...started };
}

async function collectVisibleTexts(page, selector, limit = 80) {
  return page
    .locator(selector)
    .evaluateAll(
      (elements, maxItems) =>
        elements
          .filter((element) => {
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
          })
          .map((element) => {
            const htmlElement = element;
            const aria = htmlElement.getAttribute("aria-label");
            const title = htmlElement.getAttribute("title");
            const placeholder = htmlElement.getAttribute("placeholder");
            const text = htmlElement.innerText || htmlElement.textContent || "";
            return (aria || title || placeholder || text).replace(/\s+/g, " ").trim();
          })
          .filter(Boolean)
          .slice(0, maxItems),
      limit,
    )
    .catch(() => []);
}

function flagsFromText(text, patterns) {
  return patterns
    .filter((pattern) => pattern.test(text))
    .map((pattern) => pattern.source.replaceAll("\\", ""));
}

function parseUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return {
      host: parsed.host,
      path: parsed.pathname,
      accountId: parsed.searchParams.get("act"),
      businessId: parsed.searchParams.get("business_id"),
      url: includeUrl ? rawUrl : undefined,
    };
  } catch {
    return { host: "", path: rawUrl, accountId: null, businessId: null, url: includeUrl ? rawUrl : undefined };
  }
}

const active = await resolveCdp();
const browser = await chromium.connectOverCDP(active.cdpWsUrl);
const pages = browser.contexts().flatMap((context) => context.pages());
const adsPages = pages
  .map((page, tabIndex) => ({ page, tabIndex }))
  .filter(({ page }) => page.url().includes("adsmanager.facebook.com"));

const tabs = await Promise.all(
  adsPages.map(async ({ page, tabIndex }) => {
    const bodyText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
    const headings = await collectVisibleTexts(page, "h1,h2,h3,[role=heading]");
    const buttons = await collectVisibleTexts(page, "button,[role=button]", 120);
    const inputs = await collectVisibleTexts(page, "input,textarea,[role=textbox],[role=combobox]", 120);
    const choices = await collectVisibleTexts(page, '[role=radio],[role=checkbox],label,[aria-checked="true"]', 120);
    const saveState = flagsFromText(bodyText, [/已保存|已儲存|All edits saved/i, /草稿|Draft/i, /正在验证|正在驗證|Validating/i]);
    const accessBlockerFlags = flagsFromText(bodyText, accessBlockerPatterns);
    const publishOnlyFlags = flagsFromText(bodyText, publishOnlyPatterns);
    const restrictionFlags = flagsFromText(bodyText, restrictionPatterns);

    return {
      tabIndex,
      title: await page.title().catch(() => ""),
      ...parseUrl(page.url()),
      restrictionFlags,
      blockerFlags: accessBlockerFlags,
      accessBlockerFlags,
      publishOnlyFlags,
      draftGate: restrictionFlags.length
        ? "ACCOUNT_RESTRICTED"
        : accessBlockerFlags.length
          ? "HUMAN_ACTION_REQUIRED"
          : "PROBE_CLEAR",
      publishGate: publishOnlyFlags.length ? "PUBLISH_BLOCKED_ACCOUNT_DETAILS" : "NO_PUBLISH_ONLY_NOTICE_DETECTED",
      saveState,
      headings,
      buttons,
      inputs,
      choices,
    };
  }),
);

console.log(
  JSON.stringify(
    {
      probe: "meta-lead-ads-page",
      source: active.source,
      profileId: profileId ?? null,
      status: active.status,
      debugPort: active.debugPort,
      totalTabs: pages.length,
      adsTabCount: tabs.length,
      tabs,
    },
    null,
    2,
  ),
);

// Do not close the browser: AdsPower owns the profile lifecycle.
process.exit(0);
