# PUMA 部署与回滚

## 启动与验证

要求 Node >=24，沿用 package-lock 和现有部署流程。开发机器默认 Node 22 无法运行原 scripts/test.mjs 的重跑参数；本次验证使用独立缓存中的 Node 24.22.2，没有修改系统 Node 或项目依赖。

```sh
npm run test:puma
npm test -- --test-concurrency=2
npm run replay:puma
npm run build
npm run check:puma-ui
```

最后一项需要已安装 Playwright 和 Edge；可通过 PLAYWRIGHT_PACKAGE / BROWSER_CHANNEL 指定现有安装，脚本使用独立内存数据库。

策略：`server/puma/policy.json`，schema：`server/puma/policy.schema.json`；启动使用 `config.mjs` 严格验证。可通过 `PUMA_POLICY_FILE` 指向经过审核的本地 JSON；不提供聊天或 HTTP 修改策略入口。默认 Memory/Behavior/Scam/Age shadow，Trait/Delegate/Dynamic disabled。启用自愿保护关系须将 puma_delegate_approval 设为 enabled 或 monitored_canary，重启后新登记入口才显示。

研究模型开关只能 disabled/shadow；无有效心理标签返回 INSUFFICIENT_EVIDENCE，没有经过校准的诈骗数值不能拒付。dynamic_policy 不会取消固定硬约束；当前 V0 始终由固定规则决定强制动作。年龄体验继续通过既有 RISK_POLICY_FILE/RISK_AGE_MODE 控制，PUMA 年龄开关记录 rollout 意图，不另建第二套年龄强制引擎。monitored_canary 由运营部署到指定实例，本实现不自动选择人群。

规则调整必须提升策略版本并重放；windowMinutes、burstCount、splitAmountMinor、minimumSamples、riskFlagDays 为模拟阈值，不是行业标准。R01–R21 注册表保留实现映射、例外及动作；未知设备、缺少汇率或不完整历史不会被伪造。

## 发布

1. 停止旧进程并完成 SQLite 一致性备份。若仍有 WAL，使用 SQLite backup/VACUUM INTO 或在所有连接关闭并确认 checkpoint 完成后备份，不能只复制活跃数据库主文件。
2. 保存原代码版本、策略版本和数据库备份。运行 PR1 安全测试后再接入支付相关组件。
3. 启动新代码，`puma/schema.mjs` 在事务内增量建 sidecar 表、索引/审计触发器并登记 puma-v1；重开不重复迁移、不改历史主键。
4. 先 disabled/shadow，再在隔离模拟实例启用共同确认并演练。真实支付始终关闭；LIVE_PAYMENT_ENABLED=true 或 live provider 请求会拒绝启动。
5. 观察 puma_metrics、risk_metrics、已有 audit。指标包括评估延时、模型失败、STOP 延时；授权失败/重放、共同确认冲突/超时、provider uncertain/stale 由对应追加审计和原风险指标追踪。没有真实标注时 Precision/Recall/公平性损失输出为空，不能填造合格数值。

## 回退

### 分级认证与会话问候

模拟助手通过 `create_transfer_draft` 创建草稿。灰度开启后，普通转账表单中匹配已保存收款人的转账也进入同一草稿流程。可信支付页 `src/RiskTransfer.tsx` 展示服务端快照并向 `server/risk/routes.mjs` 请求绑定交易的挑战。原流程仅在加强验证时要求人脸、验证码和交易密码。草稿、批准、提交前的三次风控均为后台检查。

在隔离实例的 `PUMA_POLICY_FILE` 中更新下列 `flags` 后重启服务。三个开关默认均为 `disabled`。

| 开关 | 内测和回退 |
|---|---|
| `risk_adaptive_auth` | 先用 `shadow` 对照 `risk.approval.intent` 中的实际认证强度与候选等级，再在指定模拟实例设为 `monitored_canary` 或 `enabled`。设回 `disabled` 恢复旧认证策略，跨策略版本的未消费批准须重新取得。 |
| `l0_single_password` | 与分级认证同时开启才执行 L0。单独关闭后，分级流程要求额外验证。 |
| `greeting_personalization_v2` | 独立开启或关闭。开启后，新对话采用浏览器 IANA 时区，支持已确认的语言、回复详略及通用兜底。首次开通仍使用专用引导。 |

L0 要求模拟通道明确支持单密码，现有累计金额策略通过，收款人有已结算历史，历史样本充足且无风控提示，没有共同确认要求。浏览器还需在当前有效登录中完成过一次加强验证。服务端签发仅供模拟转账使用的 HttpOnly 凭据，绑定该次登录。新登录、缺历史或凭据缺失时升级验证。L1 在允许的模拟通道上使用验证码和交易密码，原有强制人脸与累计金额升级仍优先。L2 维持强认证、共同确认或暂缓，L3 停止支付。定时及旧交易入口无法证明浏览器条件，开启分级后按加强认证处理。正式通道的可信设备标准、限额和监管要求仍需另行核准。

问候使用固定模板，候选历史只包含模板选择，最近五条用于去重，有效期沿用对话上下文的七天窗口。关闭个性化授权后仅使用标签页会话存储。删除已保存的对话会清理该对话的本地问候。当前实现覆盖同一浏览器的会话恢复。浏览器 Performance 面板中的 `puma.greeting` 记录生成耗时、长度、重复、时区可用性和兜底标记，最多保留 100 次，不包含问候正文。

使用 Node 24 运行 `npm run test:puma`、`npm run build` 及 `npm run check:puma-ui`。浏览器验收脚本使用独立内存库及模拟交易历史，在 Edge 中验证 L1 验证码、L0 单密码和新会话问候。通过 `risk.approval.intent`、`risk.request.rejected`、`risk.payment.*` 与既有风控指标核对升级、失败、授权和结算。发现无批准付款或强制规则漏拦，应关闭试点并核对已提交交易。

### 既有 PUMA 功能

* 模型回退：将 behavior/trait/scam/dynamic 全部 disabled；关闭 memory_v2 前也关闭 behavior。固定风控及授权检查继续运行。
* 共同确认回退：关闭新登记开关；**已接受的保护关系和已绑定交易的要求继续执行**。撤销、过期、利益冲突、交易变更都不能自动放行待批付款；用户取消旧草稿后按新的有效授权重新申请。
* 用户 STOP 与已撤销批准持久保留；恢复须可信 PIN；旧 epoch 的任务不可复活。未提交草稿取消，SUBMITTING/PENDING/终态由原 provider 对账更新。
* 数据回退不执行破坏性 down migration：新表可保留，旧业务表可继续读取；不能删除合规审计。完整备份恢复只适用于隔离环境、无新增外部副作用的演练。已有外部提交时应对账修复，不能恢复快照后再次付款。
* 若必须回退到完全不认识 PUMA 的旧代码，先停止写入、清理/核对待执行任务并暂停支付入口；旧代码不会理解 PUMA 的保护义务，不能直接滚回后开放付款。

## 已知边界与后续

这是现有模拟银行的 PUMA V0 工程实现；没有真实银行支付、撤回、冻结、FX、设备遥测和真实法律身份接口。相应真实渠道能力为 UNSUPPORTED_BY_PROVIDER。

心理研究没有有效训练标签；诈骗输出是带来源的研究性规则接口；时序模型/变化点检测、外部校准和真实准确率验收仍需要运营方数据与批准。可信联系人目前只登记为通知/核实关系，未接入独立外部通知供应商。法定监护只支持经后端独立核验的 transfer 共同参与，不实现绕过主用户批准的代付能力。

本进程可立即 Abort；其他进程通过持久 epoch/租约在工具与提交边界阻断，不能保证中断已经发到外部服务的计算。真实渠道审批身份需在接入时复用真实强认证，当前 PIN/OTP 均是模拟系统认证。

新摘要包含费用承担和渠道字段，升级前未提交的旧草稿应取消重建；历史已提交/已结算支付和对账不修改。没有修改 `.env`、实际数据库或部署中的真实支付配置；本地修改尚未创建远程 PR/发布。
