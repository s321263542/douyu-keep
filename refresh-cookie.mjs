/**
 * LTP0 自动刷新模块
 *
 * 功能：使用 passport LTP0 通过 safeAuth 接口自动刷新主站 Cookie
 */

import axios from 'axios'
import * as logger from './logger.mjs'
import { loadConfig, buildCookieString, getCookieValue, parseCookieRecord, readSetCookieHeaders, mergeCookieWithSetCookieHeaders, updateConfigFields, DOUYU_USER_AGENT } from './utils.mjs'

// ==================== 常量 ====================

const SAFE_AUTH_URL = 'https://passport.douyu.com/lapi/passport/iframe/safeAuth'
const REQUIRED_COOKIE_KEYS = ['acf_uid', 'acf_auth', 'acf_stk', 'acf_ltkid', 'acf_username', 'acf_biz', 'acf_ct']

// ==================== 核心逻辑 ====================

/**
 * 使用 LTP0 通过 safeAuth 接口刷新主站 Cookie
 *
 * @returns {{ success: boolean, refreshedKeys: string[], error: string|null }}
 */
export async function refreshCookieWithLtp0() {
  const result = { success: false, refreshedKeys: [], error: null }

  // 动态读取 config
  const config = await loadConfig()
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
        'User-Agent': DOUYU_USER_AGENT,
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
    updateConfigFields(cookieUpdates)

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
