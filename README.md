# 澄川银行 · 中文手机银行模拟器

## Agent 聊天界面

Setup: copy `.env.example` to `.env` and fill in `CHAT_API_KEY` locally. The example uses DeepSeek V4.1 Flash (`deepseek-flash`). API credentials, environment files, local databases, and test output are excluded from Git.

当前前端入口为参照 `Interface.png` 制作的独立中文聊天界面。运行 `npm install` 和 `npm run dev`，打开 `http://127.0.0.1:5173`。同一进程提供前端、银行数据和聊天 API；`npm run build` 检查类型并构建，`npm start` 在默认3000端口启动生产服务。`npm run preview` 仅预览静态前端，不提供聊天或登录 API。

支持真实 AI 对话、中文输入法、Shift+Enter 换行、停止回复、失败重试、复制回复及新对话。选择演示账户或登录其他模拟账户后，每次请求读取该用户的最新资料、账户、持仓、贷款、信用卡和有限的最近流水，以及本站服务文档和产品目录。账户卡片使用本次数据库查询结果。切换账户会清空对话，刷新后重置，不保存聊天记录。

`src/chat/adapter.ts` 调用同源 `/api/chat`，`server/chat.mjs` 在服务器使用聊天 API。密钥仅由服务器读取，不能放入浏览器或 `VITE_*` 环境变量。`.env` 已加入 Git 忽略并禁止通过开发服务器访问。`npm run dev`、`npm run dev:bank` 和 `npm start` 通过 Node 的 `--env-file-if-exists=.env` 自动加载，无需 dotenv。填入实际提供商的配置，`CHAT_BASE_URL` 不含 `/chat/completions`：

```sh
CHAT_API_KEY=YOUR_KEY
CHAT_BASE_URL=https://api.deepseek.com
CHAT_MODEL=deepseek-flash
```

已在 shell 中设置的同名环境变量优先于 `.env`。修改 `.env` 后需重启服务。`GET /api/chat/status` 仅表示已配置，不代表提供商认证成功。上游认证、余额、限流和超时错误会显示在聊天中，不会替换为模拟回复。API格式参照 [DeepSeek官方文档](https://api-docs.deepseek.com/api/create-chat-completion/)。

聊天需要现有银行会话认证，模型只能读取当前用户经过字段筛选及卡号/手机号脱敏的资料。对话和这些资料会发送到所配置的模型服务；不发送密码、支付密码、会话令牌或其他用户资料。聊天只支持读取和解释，不执行银行写操作。数据源为当前服务器的 SQLite；本地与线上数据库相互独立，不会自动读取线上浏览器会话。最近流水最多30条、交易最多20条，模型不能据此保证账户无异常。

原银行后端与业务源码保留。下方为原模拟器说明；启动原后端请使用 `npm run dev:bank`（需 Node.js 24+）。

原创蓝白风格的移动端网页银行，React + TypeScript 前端、Node.js + Express 后端、SQLite 数据库。浏览器操作与 API 共用业务逻辑，可作为银行 Agent 的开发与测试环境。

## 启动

要求 Node.js 24 或更新版本。

```sh
npm install
npm run dev
```

开发地址：`http://127.0.0.1:5173`；生产默认端口3000。数据库首次运行时自动建立在 `data/bank.sqlite`，重启不会清空。

```sh
npm test
npm run build
npm start
```

## 演示账户

| 用户 | 手机号 | 登录密码 | 支付密码 | 储蓄卡号 |
| --- | --- | --- | --- | --- |
| 林知夏 | 13800138000 | Bank123456 | 123456 | 6218808888000012068 |
| 陈屿 | 13900139000 | Bank123456 | 123456 | 6218808888000088096 |

支持自行注册其他模拟用户。注册不发送短信，新用户自动获得虚拟开户资金及一张信用卡。请勿使用真实身份、银行卡或密码。演示账户是共享测试账户，修改其密码会影响其他体验者。

## 已实现功能

- 登录、注册、退出、会话、支付密码、每日转账限额、风险测评。
- 资产总览、借记卡、余额隐藏、冻结/解冻、账户明细、CSV流水导出。
- 行内与模拟跨行转账、收款人管理、专用收款二维码、二维码图片识别。
- 待确认交易、支付验证、成功/失败/取消/过期状态、电子回单、通知。
- 定期存款购买/部分支取，理财申购/赎回、风险等级与持有期校验。
- 贷款模拟审批、放款、部分还款及结清，信用卡模拟消费与还款。
- 水电燃气、话费、宽带、物业缴费；模拟网点预约及取消；FAQ、客服工单。
- 开发者中心、OpenAPI、能力清单、操作审计、模拟收款行拒绝场景。

## 业务规则与边界

所有资金、银行、商户、金融产品、收益率和账单均为模拟数据。跨行转账流向模拟清算账户，不接入真实银行。存款与理财按本金结算，不计实际收益、净值变化、手续费或税款；固定持有期理财到期前不可赎回。贷款以20万元虚拟额度自动审批，只记录本金借还，不计利息、征信、逾期和摊销。信用卡汇总待还本金，不生成真实账单周期、分期、利息或征信。客服只保存工单，无真人回复；网点无外部预约。扫码支持模拟专用二维码图片或收款链接，不开启摄像头。

这是一套可运行的个人零售银行模拟基础，不包含真实银行的合规身份验证、清算对账、反洗钱、对公业务、外汇、保险、证券交易、短信验证码或生产级高可用系统。

## 交易与数据

金额请求使用**人民币元字符串**，例如 `"100.50"`；返回数据统一使用**整数分**。创建交易时使用幂等键，扣款交易先预留余额；输入支付密码确认后，SQLite事务内完成双边资金流水与业务更新。确认前重新检查账户、持仓及额度。失败、取消、过期释放预留资金。每30秒清理过期交易，请求时也会立即检查。重复确认不会重复入账。

用户资源均验证归属。密码用独立盐 scrypt 哈希，会话仅保存token哈希；浏览器使用HttpOnly Cookie，API支持Bearer Token。登录/支付密码失败有进程内限频。正式域名使用HTTPS Secure Cookie、严格来源校验及仅信任本机代理。完整资金总账平衡检查包含在自动化测试中。

## Agent 接入

详见 [API说明](docs/API.md)。

- `/api/openapi.json`：OpenAPI 3.1 接口列表。
- `/api/agent/manifest`：能力与资金单位约定。
- 页面使用稳定hash路由，如 `/#transfer`、`/#transactions`、`/#agent`。
- 表单具备中文标签、`name` 属性；核心按钮具备 `data-testid`。
- `examples/agent-client.mjs`：创建并取消一笔模拟转账的最小示例。

## 云部署

目标：`https://bank.siruizou.com`，SSH别名 `gcp-hk`。HTTPS由现有Caddy自动签发和续期。独立systemd服务与运行时不会改变其他项目的Node版本。

| 项目 | 位置 |
| --- | --- |
| 服务 | `chengchuan-bank.service` |
| 内部端口 | `127.0.0.1:8316` |
| 当前程序 | `/opt/chengchuan-bank/current` |
| 版本目录 | `/opt/chengchuan-bank/releases/20260912-01` |
| 独立Node | `/opt/chengchuan-bank/runtime/bin/node` |
| 持久化数据库 | `/var/lib/chengchuan-bank/bank.sqlite` |
| Caddy站点 | `/etc/caddy/sites/bank.caddy` |

```sh
ssh gcp-hk 'sudo systemctl status chengchuan-bank --no-pager'
ssh gcp-hk 'sudo journalctl -u chengchuan-bank -n 80 --no-pager'
ssh gcp-hk 'sudo systemctl restart chengchuan-bank'
```

更新时创建新版本目录、安装依赖、验证后切换 `current` 并重启本服务。保留旧版本以便回滚，**不要覆盖数据库目录**。数据库备份应使用SQLite在线备份接口，不能仅复制运行中的 `.sqlite` 文件而忽略WAL。

环境变量：`PORT`、`BANK_DB`、`PUBLIC_ORIGIN`、`TRUST_PROXY`、`SESSION_SECURE`。线上配置见 `deploy/chengchuan-bank.service`。
