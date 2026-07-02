/**
 * 斗鱼荧光棒工具配置文件
 *
 * 使用说明：
 * 1. 修改此文件中的配置
 * 2. Cookie 字段需要从浏览器中获取
 * 3. 修改后保存即可，无需重启
 */

export default {
  // ==================== Cookie 配置 ====================
  // 从浏览器开发者工具 (F12) -> Network -> 任意请求 -> Request Headers -> Cookie 中获取
  // 注意：Cookie 有时效性，过期后需要重新获取
  cookie: {
    // 用户名（必需）
    acf_username: '364333809',

    // 登录 token（必需）
    acf_ltkid: '96540855',

    // 业务标识（必需）
    acf_biz: '1',

    // 安全 token（必需）
    acf_stk: 'ca014b8ab98b26e4',

    // Cookie 类型（必需）
    acf_ct: '0',

    // 设备 ID（必需）
    dy_did: 'by1xqa5lnn3zlvyet3zhnpgpa2gf3xmx',

    // 认证 token（必需，用于访问背包接口）
    acf_auth: 'bad1tbCFgILT6ND4jbddxMbTOHPGZJ1XlMwHVdGY4TFff5WmSJROxhuiYW3FVb7b1MZYfDQHqlPvKrP7yLREJOvqwkO0uC6IUzZRTjYzurfiR4TbL4J96UY',

    // 用户 ID（必需，用于赠送礼物）
    acf_uid: '364333809',
  },

  // ==================== Passport 配置 ====================
  // LTP0 是斗鱼 passport 的长期登录凭证（有效期数月）
  // 获取方式：浏览器登录斗鱼 → F12 → Application → Cookies → passport.douyu.com → 复制 LTP0
  // 填入后，acf_stk/acf_auth 过期时程序会自动用 LTP0 刷新，无需手动更新
  // 留空则不启用自动刷新
  ltp0: '80hyd8QPViXjzbOrkB%2BjGzMTevR05nBp72pkAMKQoOfvDtXhQ5EW061HMWQQYMNNXnnN3fSMGgrDu1aiUKFreqngP%2BBQgTrfE95gjtaNR%2BeuiYhlYGlzF26dN2pe%2BnUud%2BslfCGE%2F2zsVhlgkOAvB8jBr9VDK63ZhehCXe1XKA6vtEP9XO6QdF4OdnRN1Fum7i',

  // 设备 ID（用于 safeAuth 刷新和扫码登录）
  // 通常和 cookie.dy_did 相同，留空则自动从 cookie 中读取
  dyDid: 'by1xqa5lnn3zlvyet3zhnpgpa2gf3xmx',

  // ==================== 房间号配置 ====================
  // 荧光棒领取的目标房间号
  // 留空则自动从粉丝牌列表中随机选择
  roomId: '24422',

  // ==================== 保活配置 ====================
  // 粉丝牌保活（荧光棒赠送）配置
  keepalive: {
    // 赠送模式：
    // 1 = 按权重比例分配（推荐）
    // 2 = 按固定数量分配
    model: 1,

    // 赠送目标房间配置
    send: {
      // key 为房间号
      '24422': {
        // 房间号
        roomId: 24422,

        // 礼物 ID（268 = 荧光棒）
        giftId: 268,

        // 权重（model=1 时生效）
        // 按权重比例分配荧光棒，例如：
        // - 房间 A 权重 1，房间 B 权重 2
        // - 总共 90 个荧光棒，则 A 得 30 个，B 得 60 个
        weight: 1,

        // 固定数量（model=2 时生效）
        // - 正数：赠送指定数量
        // - -1：赠送剩余所有
        // - 0：不赠送
        number: 0,
      },

      // 可以添加更多房间：
      // '99999': {
      //   roomId: 99999,
      //   giftId: 268,
      //   weight: 1,
      //   number: 0,
      // },
    },
  },

  // ==================== 邮件配置 ====================
  // 邮件通知配置，用于发送运行结果
  email: {
    // 是否启用邮件通知
    // true: 启用
    // false: 禁用
    enabled: true,

    // SMTP 服务器配置
    smtp: {
      // SMTP 服务器地址
      // QQ 邮箱：smtp.qq.com
      // 163 邮箱：smtp.163.com
      // Gmail：smtp.gmail.com
      host: 'smtp.qq.com',

      // SMTP 端口
      // QQ 邮箱：465（SSL）或 587（TLS）
      // 163 邮箱：465（SSL）或 25（不推荐）
      port: 465,

      // 是否使用 SSL 加密
      // QQ 邮箱：true（端口 465）
      // 163 邮箱：true（端口 465）
      secure: true,

      // 发件人邮箱地址
      user: '321263542@qq.com',

      // SMTP 授权码（不是邮箱密码）
      // QQ 邮箱：设置 -> 账户 -> POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV服务 -> 生成授权码
      // 163 邮箱：设置 -> POP3/SMTP/IMAP -> 开启 SMTP 服务 -> 获取授权码
      pass: 'lnxbhjvhzmgmbjfb',
    },

    // 收件人邮箱地址
    // 可以设置为和发件人相同
    to: '321263542@qq.com',
  },
}
