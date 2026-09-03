export const accessBlockerPatterns = [
  /登录 Facebook|登入 Facebook|log in to Facebook/i,
  /输入验证码|輸入驗證碼|enter (the )?(security )?code|captcha/i,
  /需要双重验证|需要雙重驗證|two-factor authentication required|2fa required/i,
  /添加付款方式才能|新增付款方式才能|payment method (is )?required/i,
  /完成广告主验证才能|完成廣告主驗證才能|complete advertiser verification/i,
  /完成身份验证才能|完成身分驗證才能|complete identity verification/i,
];

export function flagsFromText(text, patterns) {
  return patterns
    .filter((pattern) => pattern.test(text))
    .map((pattern) => pattern.source.replaceAll("\\", ""));
}

export function isInstantFormBuilderText(text) {
  return /建立表單|创建表单|Create form/i.test(text)
    && /表單類型|表单类型|Form type/i.test(text)
    && /隱私政策|隐私政策|Privacy policy/i.test(text);
}

export function buildAccessEvidence({
  surfaceTexts = [],
  bodyText = "",
  pageUrl = "",
  hasVisibleAuthControl = false,
  frameUrls = [],
}) {
  const scopedSurfaces = surfaceTexts.filter((text) => text && !isInstantFormBuilderText(text));
  const isAuthUrl = /facebook\.com\/(login|checkpoint|recover)|two[_-]?factor|captcha/i.test(pageUrl);
  const authFrames = frameUrls.filter((url) => /captcha|checkpoint|two[_-]?factor/i.test(url));

  if (isAuthUrl || hasVisibleAuthControl) scopedSurfaces.push(bodyText);
  scopedSurfaces.push(...authFrames);
  return [...new Set(scopedSurfaces)].join("\n");
}
