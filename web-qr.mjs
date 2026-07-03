/**
 * 扫码登录 Web 页面
 *
 * 使用：node web-qr.mjs
 * 然后手机浏览器访问：http://服务器IP:3456
 *
 * 功能：
 *   - 手机打开网页 → 点击按钮 → 页面直接显示二维码
 *   - 用斗鱼 App 扫码 → 页面自动显示登录结果
 *   - 登录成功后自动更新 config.mjs
 *   - 不依赖邮件，没有 5 分钟限制
 */

import http from 'node:http'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import axios from 'axios'
import QRCode from 'qrcode'
import * as logger from './logger.mjs'
import config from './config.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const PORT = 3456
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36 Edg/15.0.1901.188'

const PASSPORT_QR_GENERATE_URL = 'https://passport.douyu.com/scan/generateCode'
const PASSPORT_QR_AUTH_URL = 'https://passport.douyu.com/japi/scan/auth'
const PASSPORT_LOGIN_REFERER = 'https://passport.douyu.com/index/login?type=login&client_id=1'

const PASSPORT_COOKIE_KEYS = ['dy_accounts_main', 'LTP0', 'dy_did', 'acf_did', 'game_did']
const SAFE_AUTH_RETURNED_COOKIE_KEYS = ['acf_uid', 'acf_auth', 'acf_stk', 'acf_ltkid', 'acf_username', 'acf_biz', 'acf_ct', 'dy_auth']
const MAIN_COOKIE_REQUIRED_KEYS = ['acf_uid', 'acf_auth', 'acf_stk', 'acf_ltkid', 'acf_username', 'acf_biz', 'acf_ct']
const YUBA_RETURNED_COOKIE_KEYS = ['acf_yb_auth', 'acf_yb_uid', 'acf_yb_t', 'acf_yb_new_uid', 'acf_jwt_token', 'acf_dmjwt_token', 'dy_did']

import crypto from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

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
  return { refreshedCookie: buildCookieHeader(nextCookies), returnedKeys }
}

function generateDeviceId() {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  const bytes = crypto.randomBytes(31)
  let suffix = ''
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length]
  return `b${suffix}`
}

function createDeviceCookie(deviceId) {
  return `dy_did=${deviceId}; acf_did=${deviceId}; game_did=${deviceId}`
}

function updateConfigFields(updates) {
  const configPath = './config.mjs'
  let content = readFileSync(configPath, 'utf-8')
  for (const [key, value] of Object.entries(updates)) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`(${escapedKey}\\s*:\\s*['"])([^'"]*)(['"])`)
    if (regex.test(content)) content = content.replace(regex, `$1${value}$3`)
  }
  writeFileSync(configPath, content, 'utf-8')
}

// ==================== 任务执行状态 ====================

let taskStatus = { running: false, startTime: null, endTime: null, output: '', error: null }

function runTasks() {
  if (taskStatus.running) return false
  taskStatus = { running: true, startTime: Date.now(), endTime: null, output: '', error: null }

  const runMjsPath = join(__dirname, 'run.mjs')
  execFile(process.execPath, [runMjsPath], { cwd: __dirname, timeout: 120000 }, (error, stdout, stderr) => {
    taskStatus.running = false
    taskStatus.endTime = Date.now()
    taskStatus.output = stdout || ''
    taskStatus.error = error ? (stderr || error.message) : null
    logger.info(`[Web 任务] 执行完成${error ? '（有错误）' : '（成功）'}`)
  })
  return true
}

// ==================== 扫码登录逻辑 ====================

let currentSession = null

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

  if (data?.error !== 0 || !data?.data?.code || !data?.data?.url) {
    throw new Error('生成二维码失败')
  }

  return {
    code: data.data.code,
    qrUrl: data.data.url,
    expiresIn: data.data.expire || 300,
    deviceId,
    deviceCookie,
  }
}

async function pollQrAuth(code, deviceCookie) {
  const response = await axios.get(PASSPORT_QR_AUTH_URL, {
    headers: {
      'Cookie': deviceCookie,
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': USER_AGENT,
      'Referer': PASSPORT_LOGIN_REFERER,
    },
    params: { time: String(Date.now()), code },
    validateStatus: status => status >= 200 && status < 500,
  })

  const body = response.data || {}
  const errorCode = body.error

  if (errorCode === 0) {
    const loginUrl = body.data?.url || ''
    const setCookieHeaders = readSetCookieHeaders(response.headers)
    const { refreshedCookie: passportCookie } = mergeCookieWithSetCookieHeaders(deviceCookie, setCookieHeaders, PASSPORT_COOKIE_KEYS)
    return { status: 'confirmed', passportCookie, loginUrl }
  }
  if (errorCode === 1) return { status: 'scanned' }
  if (errorCode === -2) return { status: 'waiting' }
  if (errorCode === -3 || errorCode === 2) return { status: 'expired' }
  return { status: 'waiting' }
}

async function fetchMainCookies(loginUrl, passportCookie) {
  const url = new URL(loginUrl)
  if (!url.searchParams.has('callback')) url.searchParams.set('callback', 'appClient_json_callback')
  if (!url.searchParams.has('_')) url.searchParams.set('_', String(Date.now()))

  const response = await axios.get(url.toString(), {
    headers: { 'Cookie': passportCookie, 'User-Agent': USER_AGENT, 'Referer': 'https://www.douyu.com/' },
    validateStatus: status => status >= 200 && status < 400,
  })

  const setCookieHeaders = readSetCookieHeaders(response.headers)
  const { refreshedCookie, returnedKeys } = mergeCookieWithSetCookieHeaders('', setCookieHeaders, SAFE_AUTH_RETURNED_COOKIE_KEYS)
  if (returnedKeys.length === 0) throw new Error('主站登录未返回任何 Cookie')
  return { mainCookie: refreshedCookie, returnedKeys }
}

async function fetchYubaCookies(passportCookie, mainCookie) {
  const mergedCookie = [passportCookie, mainCookie].filter(Boolean).join('; ')

  const seedResponse = await axios.get('https://yuba.douyu.com/mygroups', {
    headers: { 'Cookie': mergedCookie, 'User-Agent': USER_AGENT, 'Referer': 'https://yuba.douyu.com/mygroups' },
    validateStatus: status => status >= 200 && status < 400,
  })

  let yubaCookie = ''
  const seedSetCookies = readSetCookieHeaders(seedResponse.headers)
  const { refreshedCookie } = mergeCookieWithSetCookieHeaders('', seedSetCookies, YUBA_RETURNED_COOKIE_KEYS)
  yubaCookie = refreshedCookie

  const dyDid = getCookieValue(mergedCookie, 'dy_did')
  const safeAuthResponse = await axios.get('https://passport.douyu.com/lapi/passport/iframe/safeAuth', {
    headers: {
      'Cookie': [mergedCookie, yubaCookie].filter(Boolean).join('; '),
      'User-Agent': USER_AGENT, 'Referer': 'https://yuba.douyu.com/mygroups', 'Origin': 'https://yuba.douyu.com',
    },
    params: { client_id: '5', ...(dyDid ? { did: dyDid } : {}), t: String(Date.now()), callback: 'axiosJsonpCallback' },
    maxRedirects: 0, validateStatus: status => status >= 200 && status < 400,
  })

  const rawLocation = safeAuthResponse.headers['location'] || safeAuthResponse.headers['Location'] || ''
  if (!rawLocation) return { yubaCookie: yubaCookie || mainCookie, returnedKeys: [] }

  const location = rawLocation.startsWith('http') ? rawLocation : `https://yuba.douyu.com${rawLocation.startsWith('/') ? '' : '/'}${rawLocation}`

  const authResponse = await axios.get(location, {
    headers: { 'Cookie': [passportCookie, mainCookie, yubaCookie].filter(Boolean).join('; '), 'User-Agent': USER_AGENT, 'Referer': 'https://yuba.douyu.com/mygroups' },
    validateStatus: status => status >= 200 && status < 400,
  })

  const authSetCookies = readSetCookieHeaders(authResponse.headers)
  const { refreshedCookie: finalYubaCookie, returnedKeys } = mergeCookieWithSetCookieHeaders(yubaCookie, authSetCookies, YUBA_RETURNED_COOKIE_KEYS)
  return { yubaCookie: finalYubaCookie, returnedKeys }
}

// ==================== HTTP 服务 ====================

function sendJson(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>斗鱼扫码登录</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f5; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 20px; }
  .card { background: #fff; border-radius: 16px; padding: 24px; width: 100%; max-width: 380px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); text-align: center; }
  h1 { font-size: 20px; color: #ff6a00; margin-bottom: 8px; }
  .subtitle { font-size: 13px; color: #999; margin-bottom: 20px; }
  .btn { display: inline-block; background: #ff6a00; color: #fff; border: none; padding: 12px 32px; border-radius: 8px; font-size: 16px; cursor: pointer; transition: background 0.2s; }
  .btn:hover { background: #e55d00; }
  .btn:disabled { background: #ccc; cursor: not-allowed; }
  .qr-box { margin: 20px 0; }
  .qr-box img { max-width: 260px; border: 1px solid #eee; border-radius: 8px; padding: 8px; }
  .status { margin-top: 16px; font-size: 14px; min-height: 24px; }
  .status.success { color: #22c55e; font-weight: 600; }
  .status.error { color: #ef4444; }
  .status.info { color: #3b82f6; }
  .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #ff6a00; border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: middle; margin-right: 6px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .tip { font-size: 12px; color: #bbb; margin-top: 12px; }
  .btn-run { display: none; background: #22c55e; color: #fff; border: none; padding: 12px 32px; border-radius: 8px; font-size: 16px; cursor: pointer; margin-top: 12px; width: 100%; }
  .btn-run:hover { background: #16a34a; }
  .btn-run:disabled { background: #ccc; cursor: not-allowed; }
  .btn-run.show { display: inline-block; }
</style>
</head>
<body>
<div class="card">
  <h1>🐟 斗鱼扫码登录</h1>
  <p class="subtitle">生成二维码 → 用斗鱼 App 扫码 → 自动登录</p>
  <button class="btn" id="btn" onclick="startLogin()">生成二维码</button>
  <button class="btn-run" id="btnRun" onclick="runTasks()">🚀 执行任务（领取 + 保活）</button>
  <div class="qr-box" id="qrBox"></div>
  <div class="status" id="status"></div>
  <p class="tip" id="tip"></p>
</div>
<script>
let polling = false
async function startLogin() {
  const btn = document.getElementById('btn')
  const qrBox = document.getElementById('qrBox')
  const status = document.getElementById('status')
  const tip = document.getElementById('tip')
  const btnRun = document.getElementById('btnRun')
  btn.disabled = true
  btn.textContent = '生成中...'
  qrBox.innerHTML = ''
  status.className = 'status'
  status.textContent = ''
  tip.textContent = ''
  btnRun.classList.remove('show')

  try {
    const res = await fetch('/api/qr/generate')
    const data = await res.json()
    if (!data.success) { throw new Error(data.error) }
    qrBox.innerHTML = '<img src="' + data.qrDataUrl + '" alt="扫码登录" />'
    status.className = 'status info'
    status.textContent = '请用斗鱼 App 扫描上方二维码'
    tip.textContent = '二维码有效期 5 分钟，过期后可重新生成'
    btn.textContent = '重新生成'
    btn.disabled = false
    startPolling(data.sessionId)
  } catch (e) {
    status.className = 'status error'
    status.textContent = '生成失败: ' + e.message
    btn.textContent = '重新生成'
    btn.disabled = false
  }
}

async function startPolling(sessionId) {
  if (polling) return
  polling = true
  const status = document.getElementById('status')
  const tip = document.getElementById('tip')
  const btn = document.getElementById('btn')
  const qrBox = document.getElementById('qrBox')
  const btnRun = document.getElementById('btnRun')

  for (let i = 0; i < 150; i++) {
    await new Promise(r => setTimeout(r, 2000))
    try {
      const res = await fetch('/api/qr/poll?sessionId=' + sessionId)
      const data = await res.json()
      if (data.status === 'scanned') {
        status.className = 'status info'
        status.innerHTML = '<span class="spinner"></span>已扫码，等待确认...'
      } else if (data.status === 'confirmed') {
        status.className = 'status info'
        status.innerHTML = '<span class="spinner"></span>扫码成功，正在获取 Cookie...'
      } else if (data.status === 'done') {
        status.className = 'status success'
        status.innerHTML = '✅ 登录成功！LTP0 和 Cookie 已保存'
        tip.textContent = '点击下方按钮立即执行任务，或等待定时任务自动执行'
        qrBox.innerHTML = ''
        btn.style.display = 'none'
        btnRun.classList.add('show')
        polling = false
        return
      } else if (data.status === 'expired') {
        status.className = 'status error'
        status.textContent = '二维码已过期，请重新生成'
        btn.textContent = '重新生成'
        btn.disabled = false
        polling = false
        return
      } else if (data.status === 'failed') {
        status.className = 'status error'
        status.textContent = '登录失败: ' + (data.error || '未知错误')
        btn.textContent = '重新生成'
        btn.disabled = false
        polling = false
        return
      }
    } catch (e) {
      // 继续重试
    }
  }
  polling = false
}

async function runTasks() {
  const btnRun = document.getElementById('btnRun')
  const status = document.getElementById('status')
  const tip = document.getElementById('tip')
  btnRun.disabled = true
  btnRun.innerHTML = '<span class="spinner"></span>执行中...'

  try {
    const res = await fetch('/api/run-tasks')
    const data = await res.json()
    if (!data.success) {
      btnRun.textContent = data.message
      btnRun.disabled = false
      return
    }
    status.className = 'status info'
    status.innerHTML = '<span class="spinner"></span>任务执行中，请等待...'
    tip.textContent = '完成后会自动发送邮件通知，也可以查看邮箱'

    // 轮询任务状态
    pollTaskStatus()
  } catch (e) {
    btnRun.textContent = '执行失败，请重试'
    btnRun.disabled = false
  }
}

async function pollTaskStatus() {
  const btnRun = document.getElementById('btnRun')
  const status = document.getElementById('status')
  const tip = document.getElementById('tip')

  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 2000))
    try {
      const res = await fetch('/api/task-status')
      const data = await res.json()
      if (!data.running && data.endTime) {
        if (data.error) {
          status.className = 'status error'
          status.innerHTML = '⚠️ 任务执行完成（可能有部分失败）'
        } else {
          status.className = 'status success'
          status.innerHTML = '✅ 任务执行完成！'
        }
        tip.textContent = '请查看邮箱获取详细执行结果'
        btnRun.textContent = '执行完成'
        return
      }
    } catch (e) {
      // 继续重试
    }
  }
  status.className = 'status info'
  status.textContent = '任务仍在执行中，请查看邮箱获取结果'
  btnRun.textContent = '任务执行中...'
}
</script>
</body>
</html>`

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  // 主页面
  if (url.pathname === '/' || url.pathname === '/index.html') {
    sendHtml(res, HTML_PAGE)
    return
  }

  // 生成二维码
  if (url.pathname === '/api/qr/generate') {
    try {
      const challenge = await generateQrChallenge()
      const qrDataUrl = await QRCode.toDataURL(challenge.qrUrl, { width: 260, margin: 2 })

      const sessionId = crypto.randomUUID()
      currentSession = {
        sessionId,
        code: challenge.code,
        deviceCookie: challenge.deviceCookie,
        status: 'waiting',
        createdAt: Date.now(),
      }

      logger.info(`[Web 扫码] 二维码已生成，会话: ${sessionId}`)
      sendJson(res, { success: true, sessionId, qrDataUrl, expiresIn: challenge.expiresIn })
    } catch (error) {
      logger.error(`[Web 扫码] 生成二维码失败: ${error.message}`)
      sendJson(res, { success: false, error: error.message })
    }
    return
  }

  // 轮询状态
  if (url.pathname === '/api/qr/poll') {
    const sessionId = url.searchParams.get('sessionId')

    if (!currentSession || currentSession.sessionId !== sessionId) {
      sendJson(res, { status: 'expired', error: '会话不存在或已过期' })
      return
    }

    if (currentSession.status === 'done') {
      sendJson(res, { status: 'done' })
      return
    }

    if (Date.now() - currentSession.createdAt > 300000) {
      currentSession = null
      sendJson(res, { status: 'expired' })
      return
    }

    try {
      const pollResult = await pollQrAuth(currentSession.code, currentSession.deviceCookie)

      if (pollResult.status === 'scanned') {
        currentSession.status = 'scanned'
        sendJson(res, { status: 'scanned' })
      } else if (pollResult.status === 'confirmed') {
        currentSession.status = 'confirmed'
        sendJson(res, { status: 'confirmed' })

        // 执行后续登录流程
        try {
          logger.info('[Web 扫码] 扫码确认，正在获取 Cookie...')
          const mainResult = await fetchMainCookies(pollResult.loginUrl, pollResult.passportCookie)
          logger.success(`[Web 扫码] 主站 Cookie 获取成功: ${mainResult.returnedKeys.join(', ')}`)

          let yubaResult = { yubaCookie: '', returnedKeys: [] }
          try {
            yubaResult = await fetchYubaCookies(pollResult.passportCookie, mainResult.mainCookie)
            if (yubaResult.returnedKeys.length > 0) {
              logger.success(`[Web 扫码] 鱼吧 Cookie 获取成功: ${yubaResult.returnedKeys.join(', ')}`)
            }
          } catch (e) {
            logger.warn(`[Web 扫码] 鱼吧 Cookie 获取失败（非必需）: ${e.message}`)
          }

          const ltp0 = getCookieValue(pollResult.passportCookie, 'LTP0')
          const dyDid = getCookieValue(pollResult.passportCookie, 'dy_did') || getCookieValue(mainResult.mainCookie, 'dy_did') || currentSession.deviceId

          const mainCookieRecord = parseCookieRecord(mainResult.mainCookie)
          const cookieUpdates = {}
          for (const key of MAIN_COOKIE_REQUIRED_KEYS) {
            if (mainCookieRecord[key]) cookieUpdates[key] = mainCookieRecord[key]
          }
          if (dyDid) cookieUpdates['dy_did'] = dyDid
          if (ltp0) cookieUpdates['ltp0'] = ltp0
          if (dyDid) cookieUpdates['dyDid'] = dyDid

          updateConfigFields(cookieUpdates)

          currentSession.status = 'done'
          logger.success('[Web 扫码] 登录完成！LTP0 和 Cookie 已保存到 config.mjs')
        } catch (error) {
          currentSession.status = 'failed'
          currentSession.error = error.message
          logger.error(`[Web 扫码] 登录流程失败: ${error.message}`)
        }
      } else if (pollResult.status === 'expired') {
        currentSession = null
        sendJson(res, { status: 'expired' })
      } else {
        sendJson(res, { status: 'waiting' })
      }
    } catch (error) {
      sendJson(res, { status: 'waiting' })
    }
    return
  }

  // 获取当前状态
  if (url.pathname === '/api/qr/status') {
    if (!currentSession) {
      sendJson(res, { status: 'idle' })
      return
    }
    sendJson(res, {
      status: currentSession.status,
      error: currentSession.error,
      expiresIn: Math.max(0, Math.floor((300000 - (Date.now() - currentSession.createdAt)) / 1000)),
    })
    return
  }

  // 执行任务
  if (url.pathname === '/api/run-tasks') {
    const started = runTasks()
    sendJson(res, { success: started, message: started ? '任务已启动，完成后邮件通知' : '任务正在执行中，请勿重复触发' })
    return
  }

  // 查询任务执行状态
  if (url.pathname === '/api/task-status') {
    sendJson(res, taskStatus)
    return
  }

  res.writeHead(404)
  res.end('Not Found')
})

server.listen(PORT, '0.0.0.0', () => {
  logger.info(`=== 扫码登录 Web 服务已启动 ===`)
  logger.info(`手机浏览器访问: http://服务器IP:${PORT}`)
  logger.info(`本机访问: http://localhost:${PORT}`)
  logger.info('等待扫码登录...')
})
