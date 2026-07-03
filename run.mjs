/**
 * 主运行脚本
 *
 * 功能：依次执行荧光棒领取和粉丝牌保活，并发送邮件通知
 * 使用：node run.mjs
 */

import * as logger from './logger.mjs'
import { sendEmail, buildEmailContent } from './email.mjs'
import { run as collectGift } from './collect-gift.mjs'
import { run as keepalive } from './keepalive.mjs'
import { refreshCookieWithLtp0 } from './refresh-cookie.mjs'
import { validateCookie } from './api.mjs'
import { loadConfig, buildCookieString } from './utils.mjs'

async function main() {
  logger.info('=== 斗鱼荧光棒工具 ===')
  logger.info(`运行时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`)
  logger.separator()

  // 0. Cookie 管理：先验证现有 Cookie，无效时才尝试刷新
  const refreshResult = { attempted: false, success: false, method: null }
  const config = await loadConfig()
  const cookie = buildCookieString(config.cookie)
  const ltp0 = config.ltp0?.trim()

  logger.info('[Cookie 管理] 验证当前 Cookie 是否可用...')
  const cookieValid = await validateCookie(cookie)

  if (cookieValid) {
    logger.info('[Cookie 管理] 当前 Cookie 有效，跳过刷新')
  } else {
    logger.warn('[Cookie 管理] 当前 Cookie 已失效')

    if (ltp0) {
      logger.info('[Cookie 管理] 尝试用 LTP0 自动刷新...')
      refreshResult.attempted = true

      const result = await refreshCookieWithLtp0()
      if (result.success) {
        refreshResult.success = true
        refreshResult.method = 'ltp0'
        logger.success(`[Cookie 管理] LTP0 刷新成功，已更新: ${result.refreshedKeys.join(', ')}`)
      } else {
        logger.warn(`[Cookie 管理] LTP0 刷新失败: ${result.error}`)
        logger.info('[Cookie 管理] 尝试扫码登录...')

        try {
          const { startQrLogin } = await import('./qr-login.mjs')
          const qrResult = await startQrLogin()
          if (qrResult.success) {
            refreshResult.success = true
            refreshResult.method = 'qr'
            logger.success('[Cookie 管理] 扫码登录成功！')
          } else {
            logger.error(`[Cookie 管理] 扫码登录失败: ${qrResult.error}`)
          }
        } catch (error) {
          logger.error(`[Cookie 管理] 扫码登录模块异常: ${error.message}`)
        }
      }
    } else {
      logger.warn('[Cookie 管理] 未配置 LTP0，无法自动刷新')
      logger.info('[Cookie 管理] 提示：在 config.mjs 中填入 ltp0 可启用自动刷新')
    }

    // 所有刷新方式都失败，直接退出
    if (!refreshResult.success) {
      logger.error('[Cookie 管理] Cookie 已失效且无法自动刷新，退出任务')
      logger.separator()
      process.exit(1)
    }
  }

  logger.separator()

  const results = {
    refresh: refreshResult,
    collect: null,
    keepalive: null,
  }

  // 1. 执行荧光棒领取
  logger.info('[任务 1/2] 荧光棒领取')
  logger.separator()
  try {
    results.collect = await collectGift()
  } catch (error) {
    results.collect = { success: false, error: error.message }
    logger.error(`荧光棒领取任务异常: ${error.message}`)
  }

  logger.info('')

  // 2. 执行粉丝牌保活
  logger.info('[任务 2/2] 粉丝牌保活')
  logger.separator()
  try {
    results.keepalive = await keepalive()
  } catch (error) {
    results.keepalive = { success: false, error: error.message }
    logger.error(`粉丝牌保活任务异常: ${error.message}`)
  }

  logger.info('')
  logger.separator()
  logger.info('=== 所有任务执行完毕 ===')
  logger.separator()

  // 3. 发送邮件通知
  logger.info('发送邮件通知...')
  try {
    const emailContent = buildEmailContent(results)
    const subject = `斗鱼荧光棒工具运行报告 - ${new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
    await sendEmail(subject, emailContent)
    logger.info('邮件通知发送完成')
  } catch (error) {
    logger.error(`邮件通知发送失败: ${error.message}`)
  }
}

main().catch(error => {
  logger.error(`未预期的错误: ${error.message}`)
  process.exit(1)
})
