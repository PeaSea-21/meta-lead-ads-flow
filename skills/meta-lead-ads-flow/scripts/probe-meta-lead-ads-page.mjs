#!/usr/bin/env node
import { chromium } from "playwright-core";
import {
  accessBlockerPatterns,
  buildAccessEvidence,
  flagsFromText,
  publishOnlyPatterns,
  restrictionPatterns,
} from "./probe-classification.mjs";

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

async function hasVisibleAuthControl(page) {
  const selector = [
    'input[type="password"]',
    'input[autocomplete="one-time-code"]',
    'input[name="approvals_code"]',
    '[data-testid*="captcha"]',
    'iframe[src*="captcha"]',
  ].join(",");

  return page.locator(selector).evaluateAll((elements) => elements.some((element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  })).catch(() => false);
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
    const blockerSurfaceTexts = await collectVisibleTexts(
      page,
      '[role=alert],[role=alertdialog],[role=dialog],[aria-modal="true"]',
      40,
    );
    const accessEvidence = buildAccessEvidence({
      surfaceTexts: blockerSurfaceTexts,
      bodyText,
      pageUrl: page.url(),
      hasVisibleAuthControl: await hasVisibleAuthControl(page),
      frameUrls: page.frames().map((frame) => frame.url()),
    });
    const saveState = flagsFromText(bodyText, [/已保存|已儲存|All edits saved/i, /草稿|Draft/i, /正在验证|正在驗證|Validating/i]);
    const accessBlockerFlags = flagsFromText(accessEvidence, accessBlockerPatterns);
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
