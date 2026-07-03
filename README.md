# 脚本工具

> 一个基于 Node.js 的斗鱼荧光棒自动领取和粉丝牌保活工具，支持 Cookie 自动刷新和扫码登录

## 项目简介

本工具用于自动化斗鱼平台的荧光棒领取和粉丝牌保活任务。通过模拟斗鱼弹幕 WebSocket 协议实现荧光棒领取，并调用斗鱼 API 完成荧光棒赠送，支持定时运行和邮件通知。

**核心特性**：
- 荧光棒自动领取（WebSocket 弹幕协议）
- 粉丝牌保活（按权重/固定数量赠送）
- Cookie 自动刷新（LTP0 + safeAuth，几个月免手动）
- 扫码登录（邮件/网页两种方式获取新 Cookie）
- 邮件通知（运行结果自动发送到邮箱）
- HTTP 请求统一超时 + 自动重试机制

## 致谢与借鉴

- **[douyu-keep-just-works](https://github.com/tophtab/douyu-keep-just-works)** - 斗鱼粉丝牌 Docker 管理台
- **[Curtion/douyu-keep](https://github.com/Curtion/douyu-keep)** - 斗鱼粉丝牌保活工具
- **[qianfeiqianlan/yuba-check-in](https://github.com/qianfeiqianlan/yuba-check-in)** - 鱼吧签到工具

## 技术栈

- **Node.js** >= 18.x（推荐 20.x 或更高版本）
- **axios** ^1.16.0 — HTTP 请求
- **ws** ^8.20.0 — WebSocket 客户端
- **nodemailer** ^6.9.0 — 邮件发送
- **qrcode** ^1.5.4 — 二维码生成

## 项目流程

```
node run.mjs
    │
    ▼
0. Cookie 管理
    ├── 验证当前 Cookie 是否有效
    ├── 无效 → 尝试 LTP0 自动刷新
    ├── 刷新失败 → 触发扫码登录
    └── 全部失败 → 退出任务
    │
    ▼
1. 荧光棒领取 (collect-gift.mjs)
    ├── 获取粉丝牌列表
    ├── 通过 WebSocket 弹幕协议领取
    └── 查询领取结果
    │
    ▼
2. 粉丝牌保活 (keepalive.mjs)
    ├── 查询荧光棒数量
    ├── 计算赠送分配（按权重/固定数量）
    └── 执行赠送
    │
    ▼
3. 邮件通知 (email.mjs)
    └── 发送运行报告到邮箱
```

## 文件说明

### 公共模块

| 文件 | 说明 |
|------|------|
| `utils.mjs` | 工具函数（Cookie 解析、config 动态加载、设备 ID 生成） |
| `api.mjs` | 斗鱼 API 封装（getFansList、getGiftNumber、sendGift 等，带超时重试） |

### 核心模块

| 文件 | 说明 |
|------|------|
| `run.mjs` | 主入口，串联 Cookie 刷新→领取→保活→邮件 |
| `collect-gift.mjs` | 荧光棒领取（WebSocket 弹幕协议） |
| `keepalive.mjs` | 粉丝牌保活（赠送荧光棒） |
| `email.mjs` | 邮件通知模块 |
| `logger.mjs` | 日志模块（按日期保存到 logs/） |

### Cookie 管理模块

| 文件 | 说明 |
|------|------|
| `refresh-cookie.mjs` | LTP0 自动刷新模块（用 safeAuth 刷新主站 Cookie） |
| `qr-login.mjs` | 扫码登录核心逻辑（被 run.mjs 和 qr-login-cmd.mjs 调用） |
| `qr-login-cmd.mjs` | 手动触发扫码登录的命令行入口 |
| `web-qr.mjs` | 扫码登录网页服务（手机浏览器访问即可扫码） |

### 配置文件

| 文件 | 说明 |
|------|------|
| `config.mjs` | 配置模板（空值，提交到仓库） |
| `config.local.mjs` | 本地真实配置（不提交，.gitignore 排除） |

### 其他

| 文件/文件夹 | 说明 |
|-------------|------|
| `package.json` | npm 配置 |
| `package-lock.json` | 依赖版本锁定（自动生成） |
| `node_modules/` | 依赖包（npm install 自动生成） |
| `logs/` | 日志文件夹（运行时自动创建，按日期保存） |

## 配置说明

### 配置文件结构

项目使用两个配置文件：
- `config.mjs` — 空模板，提交到仓库，供参考
- `config.local.mjs` — 真实配置，本地使用，不提交

程序优先读取 `config.local.mjs`，不存在则读取 `config.mjs`。

```javascript
export default {
  cookie: {
    acf_username: '用户名',
    acf_ltkid: '登录 token',
    acf_biz: '业务标识',
    acf_stk: '安全 token',
    acf_ct: 'Cookie 类型',
    dy_did: '设备 ID',
    acf_auth: '认证 token',
    acf_uid: '用户 ID',
  },

  // Passport 长期 token（有效期数月，用于自动刷新 Cookie）
  ltp0: '',
  // 设备 ID（留空则自动从 cookie 中读取）
  dyDid: '',

  roomId: '目标房间号',

  keepalive: {
    model: 1,  // 1=按权重，2=按数量
    send: {
      '房间号': {
        roomId: 房间号,
        giftId: 268,
        weight: 权重,
        number: 固定数量,
      },
    },
  },

  email: {
    enabled: true,
    smtp: {
      host: 'smtp.qq.com',
      port: 465,
      secure: true,
      user: '发件邮箱',
      pass: 'SMTP 授权码',
    },
    to: '收件邮箱',
  },
}
```

### 保活模式

- **model=1**：按权重比例分配（推荐）
- **model=2**：按固定数量分配（`-1` 表示剩余所有）

## 使用方法

### 安装

```bash
cd /path/to/douyu-gift-tool
npm install
```

### 首次配置

**方式一：扫码登录（推荐）**

```bash
# 方式 A：通过网页扫码（推荐，手机浏览器直接扫）
npm run web-qr
# 然后手机浏览器访问 http://服务器IP:3456

# 方式 B：通过邮件扫码（二维码发到邮箱）
npm run qr-login
```

扫码成功后 LTP0 和 Cookie 自动保存到 config.local.mjs，无需手动填写。

**方式二：手动填写 Cookie**

1. 复制 `config.mjs` 为 `config.local.mjs`
2. 浏览器登录斗鱼 → F12 → Network → 任意请求 → Cookie
3. 复制所需字段填入 `config.local.mjs`
4. 可选：从 `passport.douyu.com` 的 Cookie 中复制 LTP0，启用自动刷新

### 运行命令

```bash
# 一键运行（Cookie 刷新 + 领取 + 保活 + 邮件通知）
node run.mjs
# 或
npm run all

# 单独运行
node collect-gift.mjs     # 只领取荧光棒
node keepalive.mjs        # 只保活（赠送）
npm run refresh           # 只刷新 Cookie（需要 LTP0）
npm run qr-login          # 手动触发扫码登录
npm run web-qr            # 启动扫码登录网页服务
```

### 定时运行（服务器部署）

**使用 cron：**

```bash
crontab -e

# 每天凌晨 0:01 执行
1 0 * * * cd /path/to/douyu-gift-tool && node run.mjs >> /var/log/douyu-gift.log 2>&1
```

**使用 PM2（推荐）：**

```bash
npm install -g pm2

# 主任务（定时执行）
pm2 start run.mjs --name douyu-gift --cron "1 0 * * *"

# 扫码登录网页服务（后台常驻）
pm2 start web-qr.mjs --name douyu-qr
```

## Cookie 自动刷新机制

```
acf_stk 过期（几天到几周）
    │
    ▼
用 LTP0 调 safeAuth 自动刷新 → 签发新 Cookie → 继续执行 ✅

LTP0 也过期（几个月后）
    │
    ▼
发扫码二维码邮件到邮箱 → 你扫码 → 自动更新 LTP0 + Cookie ✅
```

| 场景 | 处理方式 |
|------|---------|
| acf_stk 过期 | 自动用 LTP0 刷新，无感 |
| LTP0 过期 + 看到邮件 | 5 分钟内扫码，自动恢复 |
| LTP0 过期 + 没看到邮件 | 下次定时任务重新发邮件 |
| LTP0 过期 + 想主动处理 | 手机访问 `http://服务器IP:3456` 扫码 |

## 邮件配置

1. 开启邮箱的 SMTP 服务
2. 获取 SMTP 授权码（不是邮箱密码）
3. 在 config.local.mjs 中配置

**QQ 邮箱：** 设置 → 账户 → POP3/SMTP 服务 → 开启 → 生成授权码

## 日志

- 保存在 `logs/` 文件夹，按日期命名
- 格式：`[时间] [级别] 消息内容`
- 级别：INFO / SUCCESS / WARN / ERROR

```bash
cat logs/$(date +%Y-%m-%d).log
tail -f logs/$(date +%Y-%m-%d).log
```

## 注意事项

1. Cookie 包含登录凭证，请妥善保管，不要泄露
2. `config.local.mjs` 包含敏感信息，不要提交到仓库
3. 建议每天运行一次，避免重复领取
4. 遇到问题先查看 logs/ 日志
5. LTP0 有效期数月，过期后需重新扫码

## 许可证

本项目仅供个人学习和研究使用，请勿用于商业用途。
