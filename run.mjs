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
import config from './config.mjs'

async function main() {
  logger.info('=== 斗鱼荧光棒工具 ===')
  logger.info(`运行时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`)
  logger.separator()

  // 0. 尝试自动刷新 Cookie（如果配置了 LTP0）
  const refreshResult = { attempted: false, success: false, method: null }
  const ltp0 = config.ltp0?.trim()

  if (ltp0) {
    logger.info('[Cookie 管理] 检测到 LTP0 配置，尝试自动刷新 Cookie...')
    logger.separator()
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
          logger.warn('[Cookie 管理] 将使用现有 Cookie 继续执行（可能失败）')
        }
      } catch (error) {
        logger.error(`[Cookie 管理] 扫码登录模块异常: ${error.message}`)
        logger.warn('[Cookie 管理] 将使用现有 Cookie 继续执行（可能失败）')
      }
    }
  } else {
    logger.info('[Cookie 管理] 未配置 LTP0，跳过自动刷新')
    logger.info('[Cookie 管理] 提示：在 config.mjs 中填入 ltp0 可启用自动刷新，避免手动更新 Cookie')
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
    results.collect = {
      success: false,
      error: error.message,
    }
    logger.error(`荧光棒领取任务异常: ${error.message}`)
  }

  logger.info('')

  // 2. 执行粉丝牌保活
  logger.info('[任务 2/2] 粉丝牌保活')
  logger.separator()
  try {
    results.keepalive = await keepalive()
  } catch (error) {
    results.keepalive = {
      success: false,
      error: error.message,
    }
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
