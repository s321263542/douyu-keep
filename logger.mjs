/**
 * 日志模块
 *
 * 功能：记录运行日志，保存到文件
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const LOGS_DIR = './logs'

// 确保日志文件夹存在
if (!existsSync(LOGS_DIR)) {
  mkdirSync(LOGS_DIR, { recursive: true })
}

function getTimestamp() {
  const now = new Date()
  return now.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function getDateStr() {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function getLogFilePath() {
  return join(LOGS_DIR, `${getDateStr()}.log`)
}

function formatMessage(level, message) {
  return `[${getTimestamp()}] [${level}] ${message}`
}

export function info(message) {
  const formatted = formatMessage('INFO', message)
  console.log(formatted)
  appendFileSync(getLogFilePath(), formatted + '\n')
}

export function error(message) {
  const formatted = formatMessage('ERROR', message)
  console.error(formatted)
  appendFileSync(getLogFilePath(), formatted + '\n')
}

export function warn(message) {
  const formatted = formatMessage('WARN', message)
  console.warn(formatted)
  appendFileSync(getLogFilePath(), formatted + '\n')
}

export function success(message) {
  const formatted = formatMessage('SUCCESS', message)
  console.log(formatted)
  appendFileSync(getLogFilePath(), formatted + '\n')
}

export function separator() {
  const line = '=' .repeat(50)
  console.log(line)
  appendFileSync(getLogFilePath(), line + '\n')
}

export function getLogContent() {
  try {
    return readFileSync(getLogFilePath(), 'utf-8')
  } catch {
    return ''
  }
}

export async function getLogContentAsync() {
  try {
    return readFileSync(getLogFilePath(), 'utf-8')
  } catch {
    return ''
  }
}
