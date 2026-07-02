# 文件列表说明

## 核心模块

- **run.mjs** — 主入口
  - 串联 Cookie 刷新→领取→保活→邮件通知
  - 有 LTP0 时自动刷新 Cookie
  - 刷新失败时触发扫码登录
  - 导出：无（直接执行）

- **collect-gift.mjs** — 荧光棒领取
  - 通过斗鱼弹幕 WebSocket 协议领取荧光棒
  - 动态读取 config（支持扫码登录后立即生效）
  - 导出：`run()`

- **keepalive.mjs** — 粉丝牌保活
  - 将荧光棒赠送给指定房间
  - 支持按权重或固定数量分配
  - 动态读取 config（支持扫码登录后立即生效）
  - 导出：`run()`

## Cookie 管理模块

- **refresh-cookie.mjs** — LTP0 自动刷新
  - 使用 passport LTP0 通过 safeAuth 接口刷新主站 Cookie
  - 自动更新 config.mjs 中的 acf_stk、acf_auth 等字段
  - 导出：`refreshCookieWithLtp0()`

- **qr-login.mjs** — 扫码登录核心逻辑
  - 生成斗鱼 passport 二维码
  - 轮询扫码状态
  - 获取主站 Cookie + 鱼吧 Cookie + LTP0
  - 自动写入 config.mjs
  - 导出：`startQrLogin()`

- **qr-login-cmd.mjs** — 手动扫码登录命令行入口
  - 使用：`npm run qr-login` 或 `node qr-login-cmd.mjs`
  - 发送二维码邮件到邮箱，等待扫码

- **web-qr.mjs** — 扫码登录网页服务
  - 使用：`npm run web-qr` 或 `node web-qr.mjs`
  - 启动 HTTP 服务（端口 3456）
  - 手机浏览器访问 `http://服务器IP:3456` 即可扫码
  - 不依赖邮件，没有 5 分钟限制

## 工具模块

- **logger.mjs** — 日志模块
  - 按日期保存到 `logs/` 文件夹
  - 同时输出到控制台和文件
  - 导出：`info()`, `error()`, `warn()`, `success()`, `separator()`

- **email.mjs** — 邮件模块
  - 使用 nodemailer 发送邮件
  - 支持 QQ/163/Gmail SMTP
  - 导出：`sendEmail()`, `buildEmailContent()`

## 配置文件

- **config.mjs** — 主配置
  - Cookie 配置（斗鱼登录凭证）
  - LTP0 + dyDid（passport 配置，用于自动刷新）
  - 房间号配置
  - 保活配置（赠送模式、目标房间）
  - 邮件配置（SMTP、收件人）

- **package.json** — npm 配置
  - 依赖：axios, ws, nodemailer, qrcode
  - 脚本：all, collect, keepalive, refresh, qr-login, web-qr

## 运行流程

```
node run.mjs
    │
    ├── 0. Cookie 管理
    │   ├── LTP0 有效？→ safeAuth 自动刷新
    │   ├── 刷新失败？→ 发送扫码二维码邮件
    │   └── 扫码登录？→ 自动更新 Cookie + LTP0
    │
    ├── 1. 荧光棒领取 (collect-gift.mjs)
    │
    ├── 2. 粉丝牌保活 (keepalive.mjs)
    │
    └── 3. 邮件通知 (email.mjs)
```
