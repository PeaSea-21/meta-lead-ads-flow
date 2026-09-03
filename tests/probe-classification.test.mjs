import assert from "node:assert/strict";
import test from "node:test";

import {
  accessBlockerPatterns,
  buildAccessEvidence,
  flagsFromText,
  isInstantFormBuilderText,
} from "../skills/meta-lead-ads-flow/scripts/probe-classification.mjs";

test("ignores OTP instructions rendered inside the instant-form builder", () => {
  const formBuilder = "建立表單 表單類型 簡介 問題 隱私政策 輸入驗證碼 我們已透過簡訊傳送4位數驗證碼";
  assert.equal(isInstantFormBuilderText(formBuilder), true);

  const evidence = buildAccessEvidence({
    surfaceTexts: [formBuilder],
    bodyText: formBuilder,
    pageUrl: "https://adsmanager.facebook.com/adsmanager/manage/ads/edit/standalone",
  });

  assert.deepEqual(flagsFromText(evidence, accessBlockerPatterns), []);
});

test("detects an OTP challenge in a real blocking surface", () => {
  const evidence = buildAccessEvidence({
    surfaceTexts: ["安全检查 输入验证码以继续"],
    pageUrl: "https://adsmanager.facebook.com/adsmanager/manage/campaigns",
  });

  assert.equal(flagsFromText(evidence, accessBlockerPatterns).length, 1);
});

test("uses full-page text on an authentication URL", () => {
  const evidence = buildAccessEvidence({
    bodyText: "Log in to Facebook to continue",
    pageUrl: "https://www.facebook.com/login/",
  });

  assert.equal(flagsFromText(evidence, accessBlockerPatterns).length, 1);
});

test("detects a visible authentication control outside an alert", () => {
  const evidence = buildAccessEvidence({
    bodyText: "需要双重验证才能继续",
    pageUrl: "https://adsmanager.facebook.com/adsmanager/manage/campaigns",
    hasVisibleAuthControl: true,
  });

  assert.equal(flagsFromText(evidence, accessBlockerPatterns).length, 1);
});

test("detects CAPTCHA frames", () => {
  const evidence = buildAccessEvidence({
    pageUrl: "https://adsmanager.facebook.com/adsmanager/manage/campaigns",
    frameUrls: ["https://www.facebook.com/captcha/solve"],
  });

  assert.equal(flagsFromText(evidence, accessBlockerPatterns).length, 1);
});
