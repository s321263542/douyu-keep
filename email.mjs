/**
 * 邮件模块
 *
 * 功能：发送邮件通知
 */

import nodemailer from 'nodemailer'
import { loadConfig } from './utils.mjs'

export async function sendEmail(subject, content) {
  const config = await loadConfig()

  if (!config.email?.enabled) {
    console.log('邮件通知已禁用')
    return
  }

  const { smtp, to } = config.email

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: {
      user: smtp.user,
      pass: smtp.pass,
    },
  })

  const mailOptions = {
    from: `"脚本工具" <${smtp.user}>`,
    to: to,
    subject: subject,
    text: content,
    html: content.replace(/\n/g, '<br>'),
  }

  try {
    const info = await transporter.sendMail(mailOptions)
    console.log(`邮件发送成功: ${info.messageId}`)
    return true
  } catch (error) {
    console.error(`邮件发送失败: ${error.message}`)
    return false
  }
}

export function buildEmailContent(results) {
  const lines = [
    '脚本工具运行报告',
    '=' .repeat(40),
    '',
    `运行时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    '',
  ]

  // Cookie 刷新结果
  if (results.refresh && results.refresh.attempted) {
    lines.push('Cookie 管理:')
    lines.push('-'.repeat(40))
    if (results.refresh.success) {
      const method = results.refresh.method === 'qr' ? '扫码登录' : 'LTP0 自动刷新'
      lines.push(`  刷新方式: ${method}`)
      lines.push(`  刷新结果: 成功`)
    } else {
      lines.push('  刷新结果: 失败（使用现有 Cookie）')
    }
    lines.push('')
  }

  lines.push('任务执行结果:')
  lines.push('-'.repeat(40))

  if (results.collect) {
    lines.push(`荧光棒领取: ${results.collect.success ? '成功' : '失败'}`)
    if (results.collect.count !== undefined) {
      lines.push(`  领取数量: ${results.collect.count} 个`)
    }
    if (results.collect.error) {
      lines.push(`  错误信息: ${results.collect.error}`)
    }
  }

  if (results.keepalive) {
    lines.push(`粉丝牌保活: ${results.keepalive.success ? '成功' : '失败'}`)
    if (results.keepalive.count !== undefined) {
      lines.push(`  赠送数量: ${results.keepalive.count} 个`)
    }
    if (results.keepalive.error) {
      lines.push(`  错误信息: ${results.keepalive.error}`)
    }
  }

  lines.push('')
  lines.push('-'.repeat(40))
  lines.push('此邮件由脚本工具自动发送')

  return lines.join('\n')
}
