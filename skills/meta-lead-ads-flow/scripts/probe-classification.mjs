export const accessBlockerPatterns = [
  /登录 Facebook|登入 Facebook|log in to Facebook/i,
  /输入验证码|輸入驗證碼|enter (the )?(security )?code|captcha/i,
  /需要双重验证|需要雙重驗證|two-factor authentication required|2fa required/i,
  /添加付款方式才能|新增付款方式才能|payment method (is )?required/i,
  /完成广告主验证才能|完成廣告主驗證才能|complete advertiser verification/i,
  /完成身份验证才能|完成身分驗證才能|complete identity verification/i,
];

export const restrictionPatterns = [
  /我们已限制你的广告帐号|我們已限制你的廣告帳號/i,
  /无法建立或刊登广告|無法建立或刊登廣告/i,
  /无法使用或共用广告受众|無法使用或共用廣告受眾/i,
  /ad account (is )?(restricted|limited|disabled)/i,
  /can't create or run ads|cannot create or run ads/i,
];

export const publishOnlyPatterns = [
  /需要(账号|帳號)(资料|資料)[\s\S]{0,500}前往(账号|帳號)(总览|總覽)/i,
  /需要先(确认|確認)[\s\S]{0,300}(帐号|帳號|账户|帳戶)[\s\S]{0,300}(资料|資料)[\s\S]{0,300}才能[\s\S]{0,100}(发布|發佈|刊登)(广告|廣告)/i,
  /need to confirm[\s\S]{0,300}account[\s\S]{0,300}(details|information)[\s\S]{0,300}before[\s\S]{0,100}publish/i,
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
