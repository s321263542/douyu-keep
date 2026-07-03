/**
 * 斗鱼荧光棒工具配置文件
 *
 * 使用说明：
 * 1. 复制此文件为 config.local.mjs
 * 2. 在 config.local.mjs 中填入你的真实配置
 * 3. config.local.mjs 不会被提交到仓库，安全保存你的敏感信息
 * 4. 修改后保存即可，无需重启
 */

export default {
  // ==================== Cookie 配置 ====================
  cookie: {
    acf_username: '',
    acf_ltkid: '',
    acf_biz: '',
    acf_stk: '',
    acf_ct: '',
    dy_did: '',
    acf_auth: '',
    acf_uid: '',
  },

  // ==================== Passport 配置 ====================
  // LTP0 是斗鱼 passport 的长期登录凭证（有效期数月）
  // 获取方式：浏览器登录斗鱼 → F12 → Application → Cookies → passport.douyu.com → 复制 LTP0
  ltp0: '',
  dyDid: '',

  // ==================== 房间号配置 ====================
  roomId: '',

  // ==================== 保活配置 ====================
  keepalive: {
    model: 1,
    send: {
      // '房间号': { roomId: 房间号, giftId: 268, weight: 1, number: 0 },
    },
  },

  // ==================== 邮件配置 ====================
  email: {
    enabled: false,
    smtp: {
      host: 'smtp.qq.com',
      port: 465,
      secure: true,
      user: '',
      pass: '',
    },
    to: '',
  },
}
