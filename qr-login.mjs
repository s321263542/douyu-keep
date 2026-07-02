/**
 * 扫码登录模块
 *
 * 功能：
 *   1. 生成斗鱼 passport 二维码
 *   2. 将二维码图片通过邮件发送
 *   3. 轮询等待用户扫码确认
 *   4. 扫码成功后获取 LTP0 + 主站 Cookie + 鱼吧 Cookie
 *   5. 自动写入 config.mjs
 *
 * 使用：
 *   import { startQrLogin } from './qr-login.mjs'
 *   const result = await startQrLogin()
 */

import { readFileSync, writeFileSync } from 'node:fs'
import crypto from 'node:crypto'
import axios from 'axios'
import QRCode from 'qrcode'
import config from './config.mjs'
import * as logger from './logger.mjs'
import { sendEmail } from './email.mjs'

// ==================== 常量 ====================

const PASSPORT_QR_GENERATE_URL = 'https://passport.douyu.com/scan/generateCode'
const PASSPORT_QR_AUTH_URL = 'https://passport.douyu.com/japi/scan/auth'
const PASSPORT_LOGIN_REFERER = 'https://passport.douyu.com/index/login?type=login&client_id=1'
const SAFE_AUTH_URL = 'https://passport.douyu.com/lapi/passport/iframe/safeAuth'

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36 Edg/15.0.1901.188'

const QR_POLL_INTERVAL_MS = 2000
const QR_MAX_POLLS = 150 // 300 秒

const MAIN_COOKIE_REQUIRED_KEYS = ['acf_uid', 'acf_auth', 'acf_stk', 'acf_ltkid', 'acf_username', 'acf_biz', 'acf_ct']
const PASSPORT_COOKIE_KEYS = ['dy_accounts_main', 'LTP0', 'dy_did', 'acf_did', 'game_did']
const YUBA_COOKIE_REQUIRED_KEYS = ['acf_yb_auth', 'acf_yb_uid', 'acf_yb_t']
const YUBA_RETURNED_COOKIE_KEYS = ['acf_yb_auth', 'acf_yb_uid', 'acf_yb_t', 'acf_yb_new_uid', 'acf_jwt_token', 'acf_dmjwt_token', 'dy_did']
const SAFE_AUTH_RETURNED_COOKIE_KEYS = ['acf_uid', 'acf_auth', 'acf_stk', 'acf_ltkid', 'acf_username', 'acf_biz', 'acf_ct', 'dy_auth']

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

function buildCookieHeader(cookieRecord) {
  return Object.entries(cookieRecord)
    .filter(([, value]) => value !== '')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
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

  return {
    refreshedCookie: buildCookieHeader(nextCookies),
    returnedKeys,
  }
}

function generateDeviceId() {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  const bytes = crypto.randomBytes(31)
  let suffix = ''
  for (const byte of bytes) {
    suffix += alphabet[byte % alphabet.length]
  }
  return `b${suffix}`
}

function createDeviceCookie(deviceId) {
  return `dy_did=${deviceId}; acf_did=${deviceId}; game_did=${deviceId}`
}

/**
 * 更新 config.mjs 中的字段值
 */
function updateConfigFields(updates) {
  const configPath = './config.mjs'
  let content = readFileSync(configPath, 'utf-8')

  for (const [key, value] of Object.entries(updates)) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

    // 处理 cookie 对象内的字段
    const cookieRegex = new RegExp(`(${escapedKey}\\s*:\\s*['"])([^'"]*)(['"])`)
    if (cookieRegex.test(content)) {
      content = content.replace(cookieRegex, `$1${value}$3`)
      continue
    }

    // 处理顶层字段（如 ltp0、dyDid）
    const topRegex = new RegExp(`(${escapedKey}\\s*:\\s*['"])([^'"]*)(['"])`)
    if (topRegex.test(content)) {
      content = content.replace(topRegex, `$1${value}$3`)
    }
  }

  writeFileSync(configPath, content, 'utf-8')
}

// ==================== 扫码登录核心逻辑 ====================

/**
 * 生成斗鱼 passport 二维码
 */
async function generateQrChallenge() {
  const deviceId = generateDeviceId()
  const deviceCookie = createDeviceCookie(deviceId)

  const formData = new URLSearchParams()
  formData.set('client_id', '1')
  formData.set('isMultiAccount', '0')

  const { data } = await axios.post(PASSPORT_QR_GENERATE_URL, formData.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': USER_AGENT,
      'Referer': PASSPORT_LOGIN_REFERER,
      'Cookie': deviceCookie,
    },
  })

  const errorCode = data?.error
  const code = data?.data?.code
  const qrUrl = data?.data?.url
  const expiresIn = data?.data?.expire || 300

  if (errorCode !== 0 || !code || !qrUrl) {
    throw new Error('生成二维码失败，斗鱼接口返回异常')
  }

  return { code, qrUrl, expiresIn, deviceId, deviceCookie }
}

/**
 * 将二维码 URL 转为 PNG 图片 Buffer
 */
async function generateQrPngBuffer(qrUrl) {
  return await QRCode.toBuffer(qrUrl, {
    type: 'png',
    width: 300,
    margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' },
  })
}

/**
 * 发送二维码邮件
 */
async function sendQrCodeEmail(qrPngBuffer, expiresIn) {
  const subject = `斗鱼扫码登录 - 请在 ${Math.floor(expiresIn / 60)} 分钟内扫码`

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 400px; margin: 0 auto;">
      <h2 style="color: #ff6a00;">斗鱼扫码登录</h2>
      <p>请使用<strong>斗鱼 App</strong> 扫描下方二维码完成登录：</p>
      <div style="text-align: center; margin: 20px 0;">
        <img src="cid:qrcode@douyu" alt="扫码登录二维码" style="border: 1px solid #ddd; padding: 10px;" />
      </div>
      <p style="color: #999; font-size: 12px;">
        二维码有效期：${expiresIn} 秒<br/>
        如果无法扫描图片，请将图片保存到相册后用斗鱼 App 扫一扫识别
      </p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
      <p style="color: #999; font-size: 11px;">此邮件由斗鱼荧光棒工具自动发送</p>
    </div>
  `

  if (!config.email?.enabled) {
    logger.warn('[扫码登录] 邮件未启用，请在 config.mjs 中配置 email')
    return false
  }

  const { smtp, to } = config.email

  const nodemailer = await import('nodemailer')
  const transporter = nodemailer.default.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
  })

  const mailOptions = {
    from: `"斗鱼荧光棒工具" <${smtp.user}>`,
    to: to,
    subject: subject,
    html: htmlContent,
    attachments: [{
      filename: 'qrcode.png',
      content: qrPngBuffer,
      cid: 'qrcode@douyu',
    }],
  }

  try {
    const info = await transporter.sendMail(mailOptions)
    logger.info(`[扫码登录] 二维码邮件已发送: ${info.messageId}`)
    return true
  } catch (error) {
    logger.error(`[扫码登录] 邮件发送失败: ${error.message}`)
    return false
  }
}

/**
 * 轮询扫码状态
 * 返回: { status, message, passportCookie, loginUrl }
 */
async function pollQrAuth(code, deviceCookie) {
  for (let i = 0; i < QR_MAX_POLLS; i++) {
    try {
      const response = await axios.get(PASSPORT_QR_AUTH_URL, {
        headers: {
          'Cookie': deviceCookie,
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': USER_AGENT,
          'Referer': PASSPORT_LOGIN_REFERER,
        },
        params: {
          time: String(Date.now()),
          code: code,
        },
        validateStatus: status => status >= 200 && status < 500,
      })

      const body = response.data || {}
      const errorCode = body.error
      const message = body.msg || body.message || ''

      // -2=等待扫码, 1=已扫码待确认, 0=已确认, -3/2=过期, -4/-1=取消
      if (errorCode === 0) {
        // 扫码确认成功
        const loginUrl = body.data?.url || ''
        const setCookieHeaders = readSetCookieHeaders(response.headers)
        const { refreshedCookie: passportCookie } = mergeCookieWithSetCookieHeaders(
          deviceCookie,
          setCookieHeaders,
          PASSPORT_COOKIE_KEYS,
        )
        return { status: 'confirmed', message: '扫码成功', passportCookie, loginUrl }
      }

      if (errorCode === 1) {
        logger.info('[扫码登录] 已扫码，等待确认...')
      } else if (errorCode === -2) {
        // 等待中，静默
      } else if (errorCode === -3 || errorCode === 2) {
        return { status: 'expired', message: '二维码已过期' }
      } else if (errorCode === -4 || errorCode === -1) {
        return { status: 'cancelled', message: '扫码已取消' }
      }
    } catch (error) {
      // 网络错误，继续重试
    }

    await new Promise(r => setTimeout(r, QR_POLL_INTERVAL_MS))
  }

  return { status: 'expired', message: '等待扫码超时' }
}

/**
 * 通过 loginUrl 获取主站 Cookie
 */
async function fetchMainCookies(loginUrl, passportCookie) {
  // 补全 callback 参数
  const url = new URL(loginUrl)
  if (!url.searchParams.has('callback')) {
    url.searchParams.set('callback', 'appClient_json_callback')
  }
  if (!url.searchParams.has('_')) {
    url.searchParams.set('_', String(Date.now()))
  }

  const response = await axios.get(url.toString(), {
    headers: {
      'Cookie': passportCookie,
      'User-Agent': USER_AGENT,
      'Referer': 'https://www.douyu.com/',
    },
    validateStatus: status => status >= 200 && status < 400,
  })

  // 检查 JSONP 响应中的错误
  const bodyText = typeof response.data === 'string' ? response.data : ''
  const jsonMatch = bodyText.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const body = JSON.parse(jsonMatch[0])
      if (body.error !== undefined && body.error !== 0) {
        throw new Error(`主站登录失败: ${body.msg || body.message || body.error}`)
      }
    } catch (e) {
      if (e.message.includes('主站登录失败')) throw e
    }
  }

  const setCookieHeaders = readSetCookieHeaders(response.headers)
  const { refreshedCookie, returnedKeys } = mergeCookieWithSetCookieHeaders(
    '',
    setCookieHeaders,
    SAFE_AUTH_RETURNED_COOKIE_KEYS,
  )

  if (returnedKeys.length === 0) {
    throw new Error('主站登录未返回任何 Cookie 字段')
  }

  return { mainCookie: refreshedCookie, returnedKeys }
}

/**
 * 通过 passport 获取鱼吧 Cookie
 * 流程：访问鱼吧页面 → safeAuth → authlogin → 提取鱼吧 Cookie
 */
async function fetchYubaCookies(passportCookie, mainCookie) {
  const mergedCookie = [passportCookie, mainCookie].filter(Boolean).join('; ')

  // 1. 访问鱼吧首页，获取初始鱼吧 Cookie
  const seedResponse = await axios.get('https://yuba.douyu.com/mygroups', {
    headers: {
      'Cookie': mergedCookie,
      'User-Agent': USER_AGENT,
      'Referer': 'https://yuba.douyu.com/mygroups',
    },
    validateStatus: status => status >= 200 && status < 400,
  })

  let yubaCookie = ''
  const seedSetCookies = readSetCookieHeaders(seedResponse.headers)
  const { refreshedCookie } = mergeCookieWithSetCookieHeaders('', seedSetCookies, YUBA_RETURNED_COOKIE_KEYS)
  yubaCookie = refreshedCookie

  // 2. safeAuth 获取鱼吧跳转地址
  const dyDid = getCookieValue(mergedCookie, 'dy_did')
  const safeAuthResponse = await axios.get(SAFE_AUTH_URL, {
    headers: {
      'Cookie': [mergedCookie, yubaCookie].filter(Boolean).join('; '),
      'User-Agent': USER_AGENT,
      'Referer': 'https://yuba.douyu.com/mygroups',
      'Origin': 'https://yuba.douyu.com',
    },
    params: {
      client_id: '5',
      ...(dyDid ? { did: dyDid } : {}),
      t: String(Date.now()),
      callback: 'axiosJsonpCallback',
    },
    maxRedirects: 0,
    validateStatus: status => status >= 200 && status < 400,
  })

  // 从 safeAuth 响应中提取 location 跳转地址
  const rawLocation = safeAuthResponse.headers['location'] || safeAuthResponse.headers['Location'] || ''
  if (!rawLocation) {
    logger.warn('[扫码登录] 鱼吧 SSO 未返回跳转地址，跳过鱼吧 Cookie 获取')
    return { yubaCookie: yubaCookie || mainCookie, returnedKeys: [] }
  }

  // 处理相对路径（如 /ybapi/authlogin?...）→ 拼接为完整 URL
  const location = rawLocation.startsWith('http')
    ? rawLocation
    : `https://yuba.douyu.com${rawLocation.startsWith('/') ? '' : '/'}${rawLocation}`

  // 3. 访问 authlogin 获取鱼吧 Cookie
  const authResponse = await axios.get(location, {
    headers: {
      'Cookie': [passportCookie, mainCookie, yubaCookie].filter(Boolean).join('; '),
      'User-Agent': USER_AGENT,
      'Referer': 'https://yuba.douyu.com/mygroups',
    },
    validateStatus: status => status >= 200 && status < 400,
  })

  const authSetCookies = readSetCookieHeaders(authResponse.headers)
  const { refreshedCookie: finalYubaCookie, returnedKeys } = mergeCookieWithSetCookieHeaders(
    yubaCookie,
    authSetCookies,
    YUBA_RETURNED_COOKIE_KEYS,
  )

  return { yubaCookie: finalYubaCookie, returnedKeys }
}

// ==================== 主流程 ====================

/**
 * 启动扫码登录流程
 *
 * @returns {{ success: boolean, ltp0: string|null, error: string|null }}
 */
export async function startQrLogin() {
  const result = { success: false, ltp0: null, error: null }

  logger.info('=== 扫码登录 ===')
  logger.info('[扫码登录] 正在生成二维码...')

  // 1. 生成二维码
  let challenge
  try {
    challenge = await generateQrChallenge()
  } catch (error) {
    result.error = `生成二维码失败: ${error.message}`
    logger.error(`[扫码登录] ${result.error}`)
    return result
  }

  logger.info(`[扫码登录] 二维码已生成，有效期 ${challenge.expiresIn} 秒`)

  // 2. 生成二维码图片并发送邮件
  try {
    const qrPngBuffer = await generateQrPngBuffer(challenge.qrUrl)
    const sent = await sendQrCodeEmail(qrPngBuffer, challenge.expiresIn)
    if (sent) {
      logger.info('[扫码登录] 二维码已发送到邮箱，请在手机上用斗鱼 App 扫码')
    } else {
      logger.warn('[扫码登录] 邮件发送失败，请检查邮件配置')
    }
  } catch (error) {
    logger.warn(`[扫码登录] 生成/发送二维码图片失败: ${error.message}`)
  }

  // 3. 轮询等待扫码
  logger.info('[扫码登录] 等待扫码中（最长 300 秒）...')
  const pollResult = await pollQrAuth(challenge.code, challenge.deviceCookie)

  if (pollResult.status !== 'confirmed') {
    result.error = `扫码失败: ${pollResult.message}`
    logger.error(`[扫码登录] ${result.error}`)
    return result
  }

  logger.success('[扫码登录] 扫码确认成功！')

  // 4. 获取主站 Cookie
  logger.info('[扫码登录] 正在获取主站 Cookie...')
  let mainCookieResult
  try {
    if (!pollResult.loginUrl) {
      throw new Error('未获取到主站登录地址')
    }
    mainCookieResult = await fetchMainCookies(pollResult.loginUrl, pollResult.passportCookie)
    logger.success(`[扫码登录] 主站 Cookie 获取成功: ${mainCookieResult.returnedKeys.join(', ')}`)
  } catch (error) {
    result.error = `获取主站 Cookie 失败: ${error.message}`
    logger.error(`[扫码登录] ${result.error}`)
    return result
  }

  // 5. 获取鱼吧 Cookie
  logger.info('[扫码登录] 正在获取鱼吧 Cookie...')
  let yubaResult
  try {
    yubaResult = await fetchYubaCookies(pollResult.passportCookie, mainCookieResult.mainCookie)
    if (yubaResult.returnedKeys.length > 0) {
      logger.success(`[扫码登录] 鱼吧 Cookie 获取成功: ${yubaResult.returnedKeys.join(', ')}`)
    }
  } catch (error) {
    logger.warn(`[扫码登录] 鱼吧 Cookie 获取失败（非必需）: ${error.message}`)
    yubaResult = { yubaCookie: mainCookieResult.mainCookie, returnedKeys: [] }
  }

  // 6. 提取 LTP0
  const ltp0 = getCookieValue(pollResult.passportCookie, 'LTP0')
  const dyDid = getCookieValue(pollResult.passportCookie, 'dy_did')
    || getCookieValue(mainCookieResult.mainCookie, 'dy_did')
    || challenge.deviceId

  // 7. 更新 config.mjs
  logger.info('[扫码登录] 正在更新 config.mjs...')

  const mainCookieRecord = parseCookieRecord(mainCookieResult.mainCookie)
  const cookieUpdates = {}
  for (const key of MAIN_COOKIE_REQUIRED_KEYS) {
    if (mainCookieRecord[key]) {
      cookieUpdates[key] = mainCookieRecord[key]
    }
  }
  // 确保 dy_did 也被更新
  if (dyDid) {
    cookieUpdates['dy_did'] = dyDid
  }

  // 同时更新顶层字段
  if (ltp0) cookieUpdates['ltp0'] = ltp0
  if (dyDid) cookieUpdates['dyDid'] = dyDid

  updateConfigFields(cookieUpdates)

  result.success = true
  result.ltp0 = ltp0

  logger.success('[扫码登录] 全部完成！Cookie 和 LTP0 已保存到 config.mjs')
  if (ltp0) {
    logger.info(`[扫码登录] LTP0: ${ltp0.substring(0, 20)}...`)
    logger.info('[扫码登录] 下次 Cookie 过期时将自动使用 LTP0 刷新，无需再次扫码')
  }

  return result
}
