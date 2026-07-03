/**
 * 扫码登录 Web 页面
 *
 * 使用：node web-qr.mjs
 * 然后手机浏览器访问：http://服务器IP:3456
 */

import http from 'node:http'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import axios from 'axios'
import QRCode from 'qrcode'
import * as logger from './logger.mjs'
import { validateCookie } from './api.mjs'
import {
  loadConfig,
  buildCookieString,
  getCookieValue,
  parseCookieRecord,
  readSetCookieHeaders,
  mergeCookieWithSetCookieHeaders,
  generateDeviceId,
  createDeviceCookie,
  updateConfigFields,
  DOUYU_USER_AGENT,
} from './utils.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = 3456

const PASSPORT_QR_GENERATE_URL = 'https://passport.douyu.com/scan/generateCode'
const PASSPORT_QR_AUTH_URL = 'https://passport.douyu.com/japi/scan/auth'
const PASSPORT_LOGIN_REFERER = 'https://passport.douyu.com/index/login?type=login&client_id=1'

const PASSPORT_COOKIE_KEYS = ['dy_accounts_main', 'LTP0', 'dy_did', 'acf_did', 'game_did']
const SAFE_AUTH_RETURNED_COOKIE_KEYS = ['acf_uid', 'acf_auth', 'acf_stk', 'acf_ltkid', 'acf_username', 'acf_biz', 'acf_ct', 'dy_auth']
const MAIN_COOKIE_REQUIRED_KEYS = ['acf_uid', 'acf_auth', 'acf_stk', 'acf_ltkid', 'acf_username', 'acf_biz', 'acf_ct']
const YUBA_RETURNED_COOKIE_KEYS = ['acf_yb_auth', 'acf_yb_uid', 'acf_yb_t', 'acf_yb_new_uid', 'acf_jwt_token', 'acf_dmjwt_token', 'dy_did']

// ==================== 任务执行状态 ====================

let taskStatus = { running: false, startTime: null, endTime: null, output: '', error: null }

function runTasks() {
  if (taskStatus.running) return false
  taskStatus = { running: true, startTime: Date.now(), endTime: null, output: '', error: null }

  const runMjsPath = join(__dirname, 'run.mjs')
  const child = spawn(process.execPath, [runMjsPath], { cwd: __dirname })

  child.stdout.on('data', (data) => {
    taskStatus.output += data.toString()
  })
  child.stderr.on('data', (data) => {
    taskStatus.output += data.toString()
  })
  child.on('close', (code) => {
    taskStatus.running = false
    taskStatus.endTime = Date.now()
    if (code !== 0) {
      taskStatus.error = `进程退出码: ${code}`
    }
    logger.info(`[Web 任务] 执行完成（退出码: ${code}）`)
  })
  child.on('error', (error) => {
    taskStatus.running = false
    taskStatus.endTime = Date.now()
    taskStatus.error = error.message
    logger.error(`[Web 任务] 执行失败: ${error.message}`)
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
      'User-Agent': DOUYU_USER_AGENT,
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
      'User-Agent': DOUYU_USER_AGENT,
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
    headers: { 'Cookie': passportCookie, 'User-Agent': DOUYU_USER_AGENT, 'Referer': 'https://www.douyu.com/' },
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
    headers: { 'Cookie': mergedCookie, 'User-Agent': DOUYU_USER_AGENT, 'Referer': 'https://yuba.douyu.com/mygroups' },
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
      'User-Agent': DOUYU_USER_AGENT, 'Referer': 'https://yuba.douyu.com/mygroups', 'Origin': 'https://yuba.douyu.com',
    },
    params: { client_id: '5', ...(dyDid ? { did: dyDid } : {}), t: String(Date.now()), callback: 'axiosJsonpCallback' },
    maxRedirects: 0, validateStatus: status => status >= 200 && status < 400,
  })

  const rawLocation = safeAuthResponse.headers['location'] || safeAuthResponse.headers['Location'] || ''
  if (!rawLocation) return { yubaCookie: yubaCookie || mainCookie, returnedKeys: [] }

  const location = rawLocation.startsWith('http') ? rawLocation : `https://yuba.douyu.com${rawLocation.startsWith('/') ? '' : '/'}${rawLocation}`

  const authResponse = await axios.get(location, {
    headers: { 'Cookie': [passportCookie, mainCookie, yubaCookie].filter(Boolean).join('; '), 'User-Agent': DOUYU_USER_AGENT, 'Referer': 'https://yuba.douyu.com/mygroups' },
    validateStatus: status => status >= 200 && status < 400,
  })

  const authSetCookies = readSetCookieHeaders(authResponse.headers)
  const { refreshedCookie: finalYubaCookie, returnedKeys } = mergeCookieWithSetCookieHeaders(yubaCookie, authSetCookies, YUBA_RETURNED_COOKIE_KEYS)
  return { yubaCookie: finalYubaCookie, returnedKeys }
}

// ==================== Cookie 检查 ====================

async function checkCookieValid() {
  try {
    const config = await loadConfig()
    const cookie = buildCookieString(config.cookie)
    if (!cookie) return { valid: false, reason: 'Cookie 未配置' }

    const valid = await validateCookie(cookie)
    return valid
      ? { valid: true }
      : { valid: false, reason: 'Cookie 已失效，请重新登录' }
  } catch (error) {
    return { valid: false, reason: `检查失败: ${error.message}` }
  }
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
<title>脚本工具</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; background: #f0f2f5; min-height: 100vh; display: flex; justify-content: center; align-items: center; padding: 20px; }
  .container { width: 100%; max-width: 440px; }
  .header { text-align: center; margin-bottom: 16px; }
  .header h1 { font-size: 20px; color: #1a1a1a; font-weight: 600; }
  .header p { font-size: 13px; color: #999; margin-top: 4px; }
  .card { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  .card-title { font-size: 14px; font-weight: 600; color: #333; margin-bottom: 14px; display: flex; align-items: center; gap: 6px; }
  .card-title .dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
  .dot-green { background: #22c55e; }
  .dot-orange { background: #ff6a00; }
  .dot-gray { background: #ccc; }
  .btn { display: block; width: 100%; padding: 11px 0; border: none; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.15s; text-align: center; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: #ff6a00; color: #fff; }
  .btn-primary:hover:not(:disabled) { background: #e55d00; }
  .btn-success { background: #22c55e; color: #fff; }
  .btn-success:hover:not(:disabled) { background: #16a34a; }
  .btn-outline { background: transparent; color: #666; border: 1px solid #e0e0e0; margin-top: 8px; font-size: 13px; padding: 8px 0; }
  .btn-outline:hover:not(:disabled) { background: #f5f5f5; border-color: #ccc; }
  .status-bar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 12px; }
  .status-bar.ok { background: #f0fdf4; color: #16a34a; }
  .status-bar.err { background: #fef2f2; color: #dc2626; }
  .status-bar.loading { background: #eff6ff; color: #2563eb; }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; flex-shrink: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .qr-box { text-align: center; margin: 12px 0; }
  .qr-box img { width: 200px; border-radius: 8px; }
  .countdown { text-align: center; font-size: 12px; color: #ff6a00; margin-top: 6px; }
  .log-box { background: #1a1a2e; color: #c9d1d9; border-radius: 8px; padding: 14px; font-size: 12px; font-family: "Cascadia Code", "Fira Code", "SF Mono", monospace; max-height: 300px; overflow-y: auto; line-height: 1.8; display: none; margin-top: 12px; }
  .log-box .s { color: #7ee787; }
  .log-box .e { color: #f85149; }
  .log-box .w { color: #d29922; }
  .sep { border: none; border-top: 1px dashed #30363d; margin: 4px 0; }
  .hidden { display: none !important; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>脚本工具</h1>
    <p>扫码登录 · 自动执行 · 邮件通知</p>
  </div>

  <!-- 状态卡片 -->
  <div class="card" id="statusCard">
    <div class="card-title"><span class="dot dot-gray" id="statusDot"></span>登录状态</div>
    <div id="statusArea">
      <div class="status-bar loading"><span class="spinner"></span>正在检查 Cookie...</div>
    </div>
  </div>

  <!-- 登录卡片 -->
  <div class="card hidden" id="loginCard">
    <div class="card-title"><span class="dot dot-orange"></span>扫码登录</div>
    <div class="qr-box" id="qrBox"></div>
    <div class="countdown" id="countdown"></div>
    <button class="btn btn-primary" id="btnQr" onclick="startLogin()">生成二维码</button>
  </div>

  <!-- 任务卡片 -->
  <div class="card hidden" id="taskCard">
    <div class="card-title"><span class="dot dot-green"></span>任务执行</div>
    <button class="btn btn-success" id="btnRun" onclick="runTasks()">执行任务</button>
    <button class="btn btn-outline" id="btnRelogin" onclick="showQrLogin()">重新登录</button>
    <div class="log-box" id="logBox"></div>
  </div>
</div>
<script>
let polling = false, countdownTimer = null

function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }

function formatLog(text) {
  return text.split('\\n').map(line => {
    line = esc(line)
    if (line.includes('[SUCCESS]') || line.includes('成功')) return '<span class="s">' + line + '</span>'
    if (line.includes('[ERROR]') || line.includes('失败') || line.includes('异常')) return '<span class="e">' + line + '</span>'
    if (line.includes('[WARN]')) return '<span class="w">' + line + '</span>'
    if (line.includes('====')) return '<hr class="sep">'
    return line
  }).join('<br>')
}

function showStatus(type, html) {
  const area = document.getElementById('statusArea')
  const dot = document.getElementById('statusDot')
  dot.className = 'dot ' + (type === 'ok' ? 'dot-green' : type === 'err' ? 'dot-orange' : 'dot-gray')
  area.innerHTML = '<div class="status-bar ' + (type === 'ok' ? 'ok' : type === 'err' ? 'err' : 'loading') + '">' + html + '</div>'
}

window.onload = async function() {
  const loginCard = document.getElementById('loginCard')
  const taskCard = document.getElementById('taskCard')

  try {
    const res = await fetch('/api/check-cookie')
    const data = await res.json()
    if (data.valid) {
      showStatus('ok', '✅ Cookie 有效，可以直接执行任务')
      taskCard.classList.remove('hidden')
    } else {
      showStatus('err', '❌ ' + esc(data.reason))
      loginCard.classList.remove('hidden')
    }
  } catch (e) {
    showStatus('err', '检查失败: ' + e.message)
    loginCard.classList.remove('hidden')
  }
}

function showQrLogin() {
  document.getElementById('loginCard').classList.remove('hidden')
  document.getElementById('taskCard').classList.add('hidden')
  document.getElementById('qrBox').innerHTML = ''
  document.getElementById('countdown').textContent = ''
  document.getElementById('btnQr').textContent = '生成二维码'
  document.getElementById('btnQr').disabled = false
  document.getElementById('logBox').style.display = 'none'
  showStatus('err', '需要重新登录')
}

function startCountdown(seconds, el) {
  if (countdownTimer) clearInterval(countdownTimer)
  let r = seconds
  el.textContent = '剩余 ' + r + ' 秒'
  countdownTimer = setInterval(() => {
    r--
    el.textContent = r > 0 ? '剩余 ' + r + ' 秒' : '已过期'
    if (r <= 0) clearInterval(countdownTimer)
  }, 1000)
}

async function startLogin() {
  const btn = document.getElementById('btnQr')
  const qrBox = document.getElementById('qrBox')
  const countdown = document.getElementById('countdown')
  btn.disabled = true
  btn.textContent = '生成中...'
  qrBox.innerHTML = ''
  countdown.textContent = ''

  try {
    const res = await fetch('/api/qr/generate')
    const data = await res.json()
    if (!data.success) throw new Error(data.error)
    qrBox.innerHTML = '<img src="' + data.qrDataUrl + '" />'
    btn.textContent = '重新生成'
    btn.disabled = false
    startCountdown(data.expiresIn, countdown)
    startPolling(data.sessionId)
  } catch (e) {
    btn.textContent = '重新生成'
    btn.disabled = false
    showStatus('err', '生成失败: ' + e.message)
  }
}

async function startPolling(sessionId) {
  if (polling) return
  polling = true
  const btn = document.getElementById('btnQr')
  const qrBox = document.getElementById('qrBox')
  const countdown = document.getElementById('countdown')
  const loginCard = document.getElementById('loginCard')
  const taskCard = document.getElementById('taskCard')

  for (let i = 0; i < 150; i++) {
    await new Promise(r => setTimeout(r, 2000))
    try {
      const res = await fetch('/api/qr/poll?sessionId=' + sessionId)
      const data = await res.json()
      if (data.status === 'scanned') {
        showStatus('loading', '<span class="spinner"></span>已扫码，等待确认...')
      } else if (data.status === 'confirmed') {
        showStatus('loading', '<span class="spinner"></span>正在获取 Cookie...')
      } else if (data.status === 'done') {
        if (countdownTimer) clearInterval(countdownTimer)
        showStatus('ok', '✅ 登录成功，Cookie 已保存')
        loginCard.classList.add('hidden')
        taskCard.classList.remove('hidden')
        document.getElementById('logBox').style.display = 'none'
        polling = false
        return
      } else if (data.status === 'expired') {
        if (countdownTimer) clearInterval(countdownTimer)
        countdown.textContent = ''
        btn.textContent = '重新生成'
        btn.disabled = false
        showStatus('err', '二维码已过期')
        polling = false
        return
      } else if (data.status === 'failed') {
        if (countdownTimer) clearInterval(countdownTimer)
        countdown.textContent = ''
        btn.textContent = '重新生成'
        btn.disabled = false
        showStatus('err', '登录失败: ' + esc(data.error || ''))
        polling = false
        return
      }
    } catch (e) {}
  }
  polling = false
}

async function runTasks() {
  const btn = document.getElementById('btnRun')
  const logBox = document.getElementById('logBox')
  btn.disabled = true
  btn.innerHTML = '<span class="spinner"></span>执行中...'
  logBox.style.display = 'block'
  logBox.innerHTML = '<span class="s">任务启动中...</span><br>'

  try {
    const res = await fetch('/api/run-tasks')
    const data = await res.json()
    if (!data.success) { btn.textContent = data.message; btn.disabled = false; return }
    pollTaskStatus()
  } catch (e) {
    btn.textContent = '执行失败，请重试'
    btn.disabled = false
  }
}

async function pollTaskStatus() {
  const btn = document.getElementById('btnRun')
  const logBox = document.getElementById('logBox')

  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 2000))
    try {
      const res = await fetch('/api/task-status')
      const data = await res.json()
      if (data.output) { logBox.innerHTML = formatLog(data.output); logBox.scrollTop = logBox.scrollHeight }
      if (!data.running && data.endTime) {
        if (data.output) { logBox.innerHTML = formatLog(data.output); logBox.scrollTop = logBox.scrollHeight }
        showStatus(data.error ? 'err' : 'ok', data.error ? '⚠️ 执行完成（部分失败）' : '✅ 执行完成')
        btn.textContent = '执行完成'
        btn.disabled = false
        return
      }
    } catch (e) {}
  }
  btn.textContent = '执行中...'
  showStatus('loading', '任务仍在执行，可查看邮箱获取结果')
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

  // 检查 Cookie 有效性
  if (url.pathname === '/api/check-cookie') {
    const result = await checkCookieValid()
    sendJson(res, result)
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
