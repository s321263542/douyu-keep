/**
 * 手动触发扫码登录
 *
 * 使用：node qr-login-cmd.mjs
 * 或：  npm run qr-login
 *
 * 场景：
 *   1. LTP0 过期，定时任务自动发的二维码邮件没来得及扫
 *   2. 想主动刷新 Cookie
 *   3. 首次配置，需要扫码登录获取 LTP0
 */

import { startQrLogin } from './qr-login.mjs'
import * as logger from './logger.mjs'

async function main() {
  logger.info('=== 手动扫码登录 ===')
  logger.info('将发送二维码到你的邮箱，请在 5 分钟内用斗鱼 App 扫码')
  logger.separator()

  const result = await startQrLogin()

  if (result.success) {
    logger.separator()
    logger.success('登录成功！LTP0 和 Cookie 已保存到 config.mjs')
    logger.info('定时任务将自动使用新的 Cookie 执行')
  } else {
    logger.separator()
    logger.error(`登录失败: ${result.error}`)
    logger.info('请重新运行此命令重试')
    process.exit(1)
  }
}

main().catch(error => {
  logger.error(`未预期的错误: ${error.message}`)
  process.exit(1)
})
