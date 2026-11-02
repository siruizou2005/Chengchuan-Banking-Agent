# 部署说明

## 环境要求

- Node.js 24 或更新版本（测试运行器用到 `--test-rerun-failures`，Node 22 无法运行测试）。仓库根目录的 `.nvmrc` 写的是 24。
- 首次安装需要访问 npm 仓库。运行时只有三类外部访问，都是可选的：聊天模型、百炼语音识别、东方财富基金数据。
- 不需要单独的数据库服务：使用 Node 内置的 `node:sqlite`，数据文件默认在 `data/bank.sqlite`。

## 本地开发

```sh
npm ci
npm run dev          # http://127.0.0.1:5173，一个进程同时提供前端、银行 API、智能体、语音和渠道
```

- 智能助手需要 `.env` 里的 `CHAT_API_KEY`。复制 `.env.example` 为 `.env` 再填写；Node 通过 `--env-file-if-exists=.env` 自动加载，shell 中已设置的同名变量优先。
- 第一次启动会建立 `data/bank.sqlite` 并导入两个演示账户，以后重启不会清空。
- 完全离线运行：设 `PRODUCT_DATA_REMOTE=false`，基金数据只用内置快照 `server/fund-snapshot.json`。

## 生产模式

```sh
npm ci
npm run build                  # 类型检查并构建前端到 dist/
npm start                      # http://127.0.0.1:3000，提供 dist/ 和全部 API
```

`npm start` 依赖 `dist/`，必须先构建。服务只监听 127.0.0.1，对外访问需要在同一台机器上配置反向代理。

## 单机部署（Caddy + systemd）

`deploy/` 下的其余脚本是本团队服务器在用的自动部署流水线：GitHub 推送到 main 后由 webhook 触发，在服务器上拉取代码、构建、运行测试、切换版本并做健康检查，失败自动回滚。里面写的是我们自己的域名和路径，仅供参考。

`deploy/examples/` 下有两份模板，替换其中的 `bank.example.com`、用户名和路径后使用：

- `Caddyfile.example`：HTTPS、反向代理、安全响应头、请求体大小限制（语音上传 8MB，飞书事件 256KB，其余 128KB）。
- `chengchuan-bank.service.example`：systemd 服务，以独立用户运行，开启沙箱选项，数据库放在 `/var/lib/chengchuan-bank/`，密钥从 `/etc/chengchuan-bank/env` 读取。

步骤：

1. 创建运行用户，把代码放到 `/opt/chengchuan-bank/current`，在其中执行 `npm ci && npm run build`。
2. 把 `CHAT_API_KEY` 等密钥写入 `/etc/chengchuan-bank/env`，权限设为 600。
3. 安装 systemd 服务并启动：`systemctl enable --now chengchuan-bank`。
4. 在 Caddy 配置中加入站点，重新加载 Caddy。
5. 检查健康状态：`curl https://你的域名/api/health`。

在反向代理后面运行时必须设置：

| 变量 | 值 | 作用 |
| --- | --- | --- |
| `PUBLIC_ORIGIN` | `https://你的域名` | 来源校验；飞书专属机器人回调也依赖它 |
| `TRUST_PROXY` | `true` | 只信任本机代理转发的客户端地址 |
| `SESSION_SECURE` | `true` | 会话 Cookie 只走 HTTPS |
| `PORT` | 例如 `8316` | 监听端口，和反向代理一致 |
| `BANK_DB` | 例如 `/var/lib/chengchuan-bank/bank.sqlite` | 数据库位置 |

## 环境变量

完整列表和说明在 `.env.example`，每一项都有注释。常用的几项：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CHAT_API_KEY` | 空 | 聊天模型密钥，智能助手必需 |
| `CHAT_BASE_URL`、`CHAT_MODEL` | DeepSeek | OpenAI 兼容接口地址和模型名，模型须支持函数调用 |
| `DASHSCOPE_API_KEY` | 空 | 百炼语音识别；不配置时隐藏麦克风按钮 |
| `CHANNEL_SECRET` | 空 | 64 位十六进制，加密渠道凭据；启用飞书或微信时必需 |
| `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_PERSONAL_ENABLED`、`WECHAT_ENABLED` | 关闭 | 消息渠道 |
| `RESEND_API_KEY` | 空 | 注册邮箱验证码；不配置时演示邮箱的验证码直接显示在页面上 |
| `PRODUCT_DATA_REMOTE` | `true` | 是否在线拉取基金数据 |
| `AGENT_DISABLED` | `false` | 全局关闭智能体，只保留银行页面 |
| `LIVE_PAYMENT_ENABLED` | `false` | 必须保持 false，设为 true 时服务拒绝启动 |

## 数据

- **备份**：停止服务后复制 `data/bank.sqlite`（生产环境为 `BANK_DB` 指向的文件）。
- **重置**：停止服务，删除数据库文件后重新启动，会重新建库并导入演示账户。
- **升级**：新增的表和列在启动时自动迁移，旧库可以直接升级。

## 常见问题

| 现象 | 原因 |
| --- | --- |
| `npm test` 报不认识的参数 | Node 版本低于 24 |
| 助手显示“服务暂不可用” | 没有配置 `CHAT_API_KEY`，或模型服务不可达 |
| `npm start` 页面空白或 404 | 没有先运行 `npm run build` |
| 端口被占用 | 用 `PORT` 换一个端口 |
| 外网访问不到 | 服务只监听 127.0.0.1，需要反向代理；容器中运行时同理，需要在容器内放反向代理或使用 host 网络 |
