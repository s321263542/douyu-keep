# 文件列表说明

## 公共模块

- **utils.mjs** — 工具函数模块
  - `buildCookieString()` — Cookie 对象转字符串
  - `parseCookieRecord()` — Cookie 字符串解析为对象
  - `getCookieValue()` — 从 Cookie 中获取指定字段
  - `loadConfig()` — 动态加载配置（优先 config.local.mjs）
  - `updateConfigFields()` — 更新配置文件字段
  - `generateDeviceId()` — 生成随机设备 ID
  - `mergeCookieWithSetCookieHeaders()` — 合并 Set-Cookie 头
  - `DOUYU_USER_AGENT` — 统一的 User-Agent 常量

- **api.mjs** — 斗鱼 API 封装模块
  - `getFansList()` — 获取粉丝牌列表（带重试）
  - `getGiftNumber()` — 获取荧光棒数量（带重试）
  - `getDid()` — 获取房间主播 uid（带重试）
  - `sendGift()` — 赠送礼物（带重试）
  - `parseDyAndSidFromCookie()` — 解析 sid 和 dy
  - `validateCookie()` — 验证 Cookie 是否有效
  - `sleep()` — 延时函数
  - 所有 HTTP 请求统一 15 秒超时 + 3 次重试

## 核心模块

- **run.mjs** — 主入口
  - 串联 Cookie 刷新→领取→保活→邮件通知
  - 先验证 Cookie，无效时尝试 LTP0 刷新或扫码登录
  - 全部失败则退出任务

- **collect-gift.mjs** — 荧光棒领取
  - 通过斗鱼弹幕 WebSocket 协议领取荧光棒
  - 动态读取 config（支持扫码登录后立即生效）

- **keepalive.mjs** — 粉丝牌保活
  - 将荧光棒赠送给指定房间
  - 支持按权重或固定数量分配
  - 赠送失败时自动移交给下一个房间

## Cookie 管理模块

- **refresh-cookie.mjs** — LTP0 自动刷新
  - 使用 passport LTP0 通过 safeAuth 接口刷新主站 Cookie
  - 动态读取 config

- **qr-login.mjs** — 扫码登录核心逻辑
  - 生成斗鱼 passport 二维码
  - 轮询扫码状态
  - 获取主站 Cookie + 鱼吧 Cookie + LTP0
  - 导出：`startQrLogin()`

- **qr-login-cmd.mjs** — 手动扫码登录命令行入口
  - 使用：`npm run qr-login`

- **web-qr.mjs** — 扫码登录网页服务
  - 使用：`npm run web-qr`
  - 启动 HTTP 服务（端口 3456）
  - 手机浏览器访问即可扫码
  - 支持扫码成功后直接执行任务
  - 实时显示任务执行日志

## 工具模块

- **logger.mjs** — 日志模块
  - 按日期保存到 `logs/` 文件夹
  - 同时输出到控制台和文件
  - 导出：`info()`, `error()`, `warn()`, `success()`, `separator()`

- **email.mjs** — 邮件模块
  - 使用 nodemailer 发送邮件
  - 动态读取 config
  - 导出：`sendEmail()`, `buildEmailContent()`

## 配置文件

- **config.mjs** — 配置模板（空值）
  - 提交到仓库，供参考
  - Cookie、密码等敏感字段为空

- **config.local.mjs** — 本地真实配置
  - 不提交到仓库（.gitignore 排除）
  - 包含真实的 Cookie、LTP0、邮箱密码等
  - 程序优先读取此文件

## 运行流程

```
node run.mjs
    │
    ├── 0. Cookie 管理
    │   ├── 验证当前 Cookie
    │   ├── 无效 → LTP0 刷新
    │   ├── 刷新失败 → 扫码登录
    │   └── 全部失败 → 退出
    │
    ├── 1. 荧光棒领取 (collect-gift.mjs)
    │
    ├── 2. 粉丝牌保活 (keepalive.mjs)
    │
    └── 3. 邮件通知 (email.mjs)
```
