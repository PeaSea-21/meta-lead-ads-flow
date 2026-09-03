# Meta Leads + Instant Form Skill

这是一个 Meta Leads 工作包，包含经过实跑验证的单任务草稿 Skill、多 AdsPower Profile 并发协调 Skill、只读页面探针和任务清单校验器。

默认范围是创建、检查并保存广告草稿。并发 Skill 只有在当前对话中获得针对具体任务的明确授权后才可进入发布阶段；两个 Skill 都不处理 CAPTCHA、双重验证、付款、身份验证或账号资料确认。

## 目录结构

```text
meta-lead-ads-flow/
|-- skills/meta-lead-ads-flow/
|   |-- SKILL.md
|   |-- agents/openai.yaml
|   |-- references/playwright-probing.md
|   |-- scripts/probe-classification.mjs
|   `-- scripts/probe-meta-lead-ads-page.mjs
|-- skills/meta-lead-ads-concurrent/
|   |-- SKILL.md
|   |-- agents/openai.yaml
|   |-- references/checkpoints.md
|   |-- references/job-manifest.md
|   `-- scripts/validate-job-manifest.mjs
|-- tests/
|-- docs/ad-request-template.md
|-- package.json
|-- package-lock.json
`-- .gitignore
```

旧仓库中的 Sales worker、历史截图和 Word 解包目录没有迁移。并发 Skill 负责安全调度规范和输入校验，不包含未经审核的批量点击发布器。

## 环境准备

1. 安装并打开 AdsPower。
2. 在正确的 AdsPower Profile 中登录 Meta，并打开对应广告账户的 Ads Manager 页面。
3. 安装 Node.js 20 或更高版本。
4. 在本目录安装依赖：

```powershell
npm ci
```

## 安装 Skill

当前电脑已经安装过这个 skill。需要在另一台电脑安装时，把下面整个目录复制到 Codex skills 目录：

```text
skills/meta-lead-ads-flow
```

默认目标位置通常是：

```text
%CODEX_HOME%\skills\meta-lead-ads-flow
```

如果没有设置 `CODEX_HOME`，通常使用：

```text
%USERPROFILE%\.codex\skills\meta-lead-ads-flow
```

安装后重新打开 Codex 任务，让 skill 目录被重新发现。

并发使用时还需安装：

```text
skills/meta-lead-ads-concurrent
```

## 每次怎么使用

1. 打开正确的 AdsPower Profile 和 Meta Ads Manager 标签页。
2. 填写 [广告需求模板](docs/ad-request-template.md)。不确定的内容可以留空，并注明允许生成测试内容。
3. 在 Codex 中发送：

```text
请使用 $meta-lead-ads-flow，根据下面的广告需求创建 Meta Leads + 即时表单广告。
仅创建并保存草稿，不要发布。执行前先确认 AdsPower Profile 和广告账户。

<粘贴已经填写的广告需求模板>
```

4. Codex 先执行只读探测，确认登录状态、广告账户和页面是否可操作。
5. 探测通过后才创建 Campaign、Ad Set、Instant Form 和 Ad Creative。
6. 最后以 `草稿` 和 `已储存所有编辑内容` 为完成依据，并保留页面供人工检查。

## 只读页面探针

AdsPower Profile 已经打开时运行：

```powershell
npm run probe -- --profile=YOUR_ADSPOWER_PROFILE_ID
```

探针不会点击、填写、导航或发布，只读取当前 Ads Manager 标签页的可见状态。输出可能含广告账户上下文，不要提交到 Git 或转发给无关人员。

探针只会从真实警告、认证对话框、认证 URL 或认证控件判断登录、验证码和 CAPTCHA。即时表单预览中的验证码示例不会被当成账户阻塞。

只有在明确允许启动对应 Profile 时，才使用：

```powershell
npm run probe -- --profile=YOUR_ADSPOWER_PROFILE_ID --start
```

## 完成标准

- Campaign 目标是 `Leads / 潜在客户`。
- Ad Set 转化位置是 `Instant form / 即时表单`。
- 即时表单、隐私政策、完成页、素材和广告文案已配置。
- 页面显示 `草稿`。
- 页面显示 `已储存所有编辑内容`，或明确报告仍在平台验证中。
- `publishClicked` 必须为 `false`。

## 多 Profile 并发

使用 `$meta-lead-ads-concurrent` 时，每个任务必须显式绑定人工已打开并确认的 AdsPower Profile、Meta 广告账户、Facebook Page，以及带币种的预算。任务清单 schema `version: 2` 还必须指定本地 JSONL 检查点路径。真实任务清单应使用 `*.ads-jobs.local.json` 文件名，检查点应放在 `.meta-lead-ads/`，两者都保持在 Git 之外。

校验任务清单：

```powershell
npm run validate:manifest -- <manifest.ads-jobs.local.json>
```

同一 Profile 或同一广告账户的任务会串行执行；不同 Profile 和账户可以在配置的上限内并行。普通幂等操作最多重试一次，创建和发布等结果不明确时只做状态对账，不自动重放。`targetState: "published"` 只表示目标，不等于发布授权。发布前仍需要当前对话中针对具体任务的明确确认。

## 常见状态

- `PROBE_CLEAR`：可以继续草稿流程。
- `PUBLISH_BLOCKED_ACCOUNT_DETAILS`：只限制发布，草稿流程可以继续，但不要进入账号资料确认。
- `HUMAN_ACTION_REQUIRED`：登录、2FA、CAPTCHA、付款或身份验证需要人工处理。
- `ACCOUNT_RESTRICTED`：账户明确不能创建或投放广告，停止操作。
- `RUNNER_INCOMPATIBLE_OBJECTIVE`：检测到旧的 Sales-only runner，不能用于 Leads 流程。

## 预计耗时

- 账号已登录、素材和文案齐全：约 8-15 分钟。
- 需要创建完整即时表单并生成测试内容：约 10-20 分钟。
- Meta 页面响应较慢或界面发生变化：约 20-30 分钟。

首次在新账号运行时，账户确认和动态定位器探测通常比实际填写更耗时。
