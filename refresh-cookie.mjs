/**
 * LTP0 自动刷新模块
 *
 * 功能：使用 passport LTP0 通过 safeAuth 接口自动刷新主站 Cookie
 * 原理：LTP0 是斗鱼 passport 的长期登录凭证（有效期数月），
 *       通过 safeAuth 接口可以用 LTP0 签发新的短期主站 Cookie（acf_stk、acf_auth 等）
 *
 * 使用：
 *   import { refreshCookieWithLtp0 } from './refresh-cookie.mjs'
 *   const result = await refreshCookieWithLtp0()
 */

import { readFileSync, writeFileSync } from 'node:fs'
import axios from 'axios'
import config from './config.mjs'
import * as logger from './logger.mjs'

// ==================== 常量 ====================

const SAFE_AUTH_URL = 'https://passport.douyu.com/lapi/passport/iframe/safeAuth'
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36 Edg/115.0.1901.188'

// safeAuth 返回的主站 Cookie 必需字段
const REQUIRED_COOKIE_KEYS = ['acf_uid', 'acf_auth', 'acf_stk', 'acf_ltkid', 'acf_username', 'acf_biz', 'acf_ct']

// ==================== 工具函数 ====================

function parseCookieRecord(cookie) {
  return cookie.split(';').reduce((acc, chunk) => {
    const [key, ...rest] = chunk.trim().split('=')
    if (key?.trim()) acc[key.trim()] = rest.join('=').trim()
    return acc
  }, {})
}

function getCookieValue(cookie, name) {
  return parseCookieRecord(cookie)[name]
}

function readSetCookieHeaders(headers) {
  if (!headers) return []
  const value = headers['set-cookie'] ?? headers['Set-Cookie']
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string')
  return typeof value === 'string' ? [value] : []
}

function parseSetCookiePair(header) {
  const firstPart = header.split(';')[0]?.trim() || ''
  const separatorIndex = firstPart.indexOf('=')
  if (separatorIndex <= 0) return null
  const name = firstPart.slice(0, separatorIndex).trim()
  const value = firstPart.slice(separatorIndex + 1)
  return name ? [name, value] : null
}

/**
 * 从 Set-Cookie 响应头中提取指定字段，合并到现有 Cookie
 */
function mergeCookieWithSetCookieHeaders(currentCookie, setCookieHeaders, allowedKeys) {
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
 * 更新 config.mjs 中的 Cookie 字段值
 * 使用正则替换，保留文件注释和格式
 */
function updateConfigCookieFields(updates) {
  const configPath = './config.mjs'
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

// ==================== 核心逻辑 ====================

/**
 * 使用 LTP0 通过 safeAuth 接口刷新主站 Cookie
 *
 * @returns {{ success: boolean, refreshedKeys: string[], error: string|null }}
 */
export async function refreshCookieWithLtp0() {
  const result = { success: false, refreshedKeys: [], error: null }

  const ltp0 = config.ltp0?.trim()
  if (!ltp0) {
    result.error = 'config.mjs 中未配置 ltp0，跳过自动刷新'
    return result
  }

  // 获取 dy_did：优先用配置的 dyDid，其次从 cookie 中取
  let dyDid = config.dyDid?.trim() || getCookieValue(buildCookieString(config.cookie), 'dy_did')
  if (!dyDid) {
    result.error = '缺少 dy_did，请在 config.mjs 中配置 dyDid 字段，或确保 cookie 中包含 dy_did'
    return result
  }

  const mainCookie = buildCookieString(config.cookie)

  logger.info('[Cookie 刷新] 使用 LTP0 通过 safeAuth 刷新主站 Cookie...')

  try {
    const timestamp = String(Date.now())
    const response = await axios.get(SAFE_AUTH_URL, {
      headers: {
        'Cookie': `dy_did=${dyDid}; LTP0=${ltp0}`,
        'User-Agent': USER_AGENT,
        'Referer': 'https://www.douyu.com/',
        'Origin': 'https://www.douyu.com',
      },
      params: {
        client_id: '1',
        t: timestamp,
        _: timestamp,
        callback: 'axiosJsonpCallback',
      },
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 400,
    })

    // 从 Set-Cookie 中提取新字段
    const setCookieHeaders = readSetCookieHeaders(response.headers)
    const { refreshedCookie, returnedKeys } = mergeCookieWithSetCookieHeaders(
      mainCookie,
      setCookieHeaders,
      REQUIRED_COOKIE_KEYS,
    )

    if (returnedKeys.length === 0) {
      result.error = 'safeAuth 未返回任何 Cookie 字段，LTP0 可能已过期'
      logger.warn(`[Cookie 刷新] ${result.error}`)
      return result
    }

    // 检查必需字段是否齐全
    const refreshedRecord = parseCookieRecord(refreshedCookie)
    const missingKeys = REQUIRED_COOKIE_KEYS.filter(key => !refreshedRecord[key])
    if (missingKeys.length > 0) {
      result.error = `safeAuth 返回的 Cookie 缺少字段: ${missingKeys.join(', ')}`
      logger.warn(`[Cookie 刷新] ${result.error}`)
      return result
    }

    // 更新 config.mjs
    const cookieUpdates = {}
    for (const key of REQUIRED_COOKIE_KEYS) {
      if (refreshedRecord[key]) {
        cookieUpdates[key] = refreshedRecord[key]
      }
    }
    updateConfigCookieFields(cookieUpdates)

    result.success = true
    result.refreshedKeys = returnedKeys
    logger.success(`[Cookie 刷新] 成功！已更新字段: ${returnedKeys.join(', ')}`)
    logger.info(`[Cookie 刷新] acf_stk 新值: ${refreshedRecord.acf_stk?.substring(0, 16)}...`)

    return result
  } catch (error) {
    result.error = `safeAuth 请求失败: ${error.message}`
    logger.error(`[Cookie 刷新] ${result.error}`)
    return result
  }
}

/**
 * 从 config.cookie 对象构建 Cookie 字符串
 */
function buildCookieString(cookieObj) {
  return Object.entries(cookieObj)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ')
}
