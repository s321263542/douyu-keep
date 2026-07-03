/**
 * 公共工具模块
 *
 * 统一管理 Cookie 解析、config 加载、设备 ID 生成等工具函数
 */

import crypto from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ==================== 常量 ====================

export const DOUYU_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36 Edg/115.0.1901.188'

// ==================== Cookie 工具 ====================

/**
 * 将 cookie 对象转换为字符串
 */
export function buildCookieString(cookieObj) {
  return Object.entries(cookieObj)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ')
}

/**
 * 将 cookie 字符串解析为对象
 */
export function parseCookieRecord(cookie) {
  return cookie.split(';').reduce((acc, chunk) => {
    const [key, ...rest] = chunk.trim().split('=')
    if (key?.trim()) acc[key.trim()] = rest.join('=').trim()
    return acc
  }, {})
}

/**
 * 从 cookie 字符串中获取指定字段的值
 */
export function getCookieValue(cookie, name) {
  return parseCookieRecord(cookie)[name]
}

/**
 * 从 Set-Cookie 响应头中提取指定字段，合并到现有 Cookie
 */
export function mergeCookieWithSetCookieHeaders(currentCookie, setCookieHeaders, allowedKeys) {
  const nextCookies = parseCookieRecord(currentCookie)
  const returnedKeys = []

  for (const header of setCookieHeaders) {
    const pair = parseSetCookiePair(header)
    if (!pair) continue
    const [name, value] = pair
    if (allowedKeys.includes(name)) {
      nextCookies[name] = value
      if (!returnedKeys.includes(name)) returnedKeys.push(name)
    }
  }

  const refreshedCookie = Object.entries(nextCookies)
    .filter(([, value]) => value !== '')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')

  return { refreshedCookie, returnedKeys }
}

/**
 * 读取响应头中的 Set-Cookie
 */
export function readSetCookieHeaders(headers) {
  if (!headers) return []
  const value = headers['set-cookie'] ?? headers['Set-Cookie']
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string')
  return typeof value === 'string' ? [value] : []
}

/**
 * 解析 Set-Cookie 头的单个 cookie 键值对
 */
export function parseSetCookiePair(header) {
  const firstPart = header.split(';')[0]?.trim() || ''
  const separatorIndex = firstPart.indexOf('=')
  if (separatorIndex <= 0) return null
  const name = firstPart.slice(0, separatorIndex).trim()
  const value = firstPart.slice(separatorIndex + 1)
  return name ? [name, value] : null
}

// ==================== Config 工具 ====================

/**
 * 动态加载配置（绕过 ESM 模块缓存）
 * 优先读取 config.local.mjs（本地真实配置），不存在则读取 config.mjs（模板）
 */
export async function loadConfig() {
  const localPath = join(__dirname, 'config.local.mjs')
  const configPath = existsSync(localPath) ? './config.local.mjs' : './config.mjs'
  const mod = await import(`${configPath}?t=${Date.now()}`)
  return mod.default
}

/**
 * 更新配置文件中的字段值（正则替换，保留注释和格式）
 * 优先写入 config.local.mjs，不存在则写入 config.mjs
 */
export function updateConfigFields(updates) {
  const localPath = join(__dirname, 'config.local.mjs')
  const configPath = existsSync(localPath) ? localPath : join(__dirname, 'config.mjs')
  let content = readFileSync(configPath, 'utf-8')

  for (const [key, value] of Object.entries(updates)) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`(${escapedKey}\\s*:\\s*['"])([^'"]*)(['"])`)
    if (regex.test(content)) {
      content = content.replace(regex, `$1${value}$3`)
    }
  }

  writeFileSync(configPath, content, 'utf-8')
}

// ==================== 设备 ID ====================

/**
 * 生成随机设备 ID
 */
export function generateDeviceId() {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  const bytes = crypto.randomBytes(31)
  let suffix = ''
  for (const byte of bytes) {
    suffix += alphabet[byte % alphabet.length]
  }
  return `b${suffix}`
}

/**
 * 创建设备 Cookie 字符串
 */
export function createDeviceCookie(deviceId) {
  return `dy_did=${deviceId}; acf_did=${deviceId}; game_did=${deviceId}`
}
