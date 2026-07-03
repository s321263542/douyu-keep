/**
 * 荧光棒领取脚本
 *
 * 功能：通过斗鱼弹幕 WebSocket 协议领取荧光棒
 * 使用：node collect-gift.mjs
 */

import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import WebSocket from 'ws'
import * as logger from './logger.mjs'
import { loadConfig, buildCookieString, getCookieValue, generateDeviceId, DOUYU_USER_AGENT } from './utils.mjs'
import { getFansList, getGiftNumber } from './api.mjs'

// ==================== 常量 ====================

const DOUYU_DANMU_WS_URL = 'wss://wsproxy.douyu.com:6672'
const DOUYU_LOGIN_VK_SECRET = 'r5*^5;}2#${XF[h+;\'./.Q\'1;,-]f\'p['
const COLLECT_TIMEOUT_MS = 15000
const LOGIN_COOKIE_KEYS = ['acf_username', 'acf_ltkid', 'acf_biz', 'acf_stk', 'acf_ct']

// ==================== 弹幕协议工具 ====================

function escapeDouyuValue(value) {
  return value.replace(/@/g, '@A').replace(/\//g, '@S')
}

function encodeDouyuMessage(params) {
  const payload = Object.entries(params)
    .map(([key, value]) => `${escapeDouyuValue(key)}@=${escapeDouyuValue(value)}/`)
    .join('')
  return `${payload}\0`
}

function generateDouyuPacket(message) {
  const payload = Buffer.from(message, 'utf8')
  const packet = Buffer.alloc(12 + payload.length + 1)
  const length = 9 + payload.length
  packet.writeInt32LE(length, 0)
  packet.writeInt32LE(length, 4)
  packet.writeInt32LE(689, 8)
  payload.copy(packet, 12)
  packet.writeUInt8(0, 12 + payload.length)
  return packet
}

function decodeDouyuMessages(data) {
  const buffer = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data)
  return Array.from(buffer.toString('utf8').matchAll(/type@=.*?\0/g), match => match[0].slice(0, -1))
}

function buildLoginPacket(roomId, cookie) {
  const deviceId = generateDeviceId()
  const timestamp = String(Math.floor(Date.now() / 1000))
  const vk = crypto
    .createHash('md5')
    .update(`${timestamp}${DOUYU_LOGIN_VK_SECRET}${deviceId}`)
    .digest('hex')

  const params = {
    type: 'loginreq',
    password: '',
    roomid: roomId,
  }

  const cookieMappings = [
    ['acf_username', 'username'],
    ['acf_ltkid', 'ltkid'],
    ['acf_biz', 'biz'],
    ['acf_stk', 'stk'],
    ['acf_ct', 'ct'],
  ]

  for (const [cookieKey, paramKey] of cookieMappings) {
    const value = getCookieValue(cookie, cookieKey)
    if (value) params[paramKey] = value
  }

  Object.assign(params, {
    devid: deviceId,
    rt: timestamp,
    pt: '2',
    vk,
    ver: '20180222',
    aver: '219032101',
    dmbt: 'mobile safari',
    dmbv: '11',
  })

  return generateDouyuPacket(encodeDouyuMessage(params))
}

function buildEnterRoomPacket(roomId) {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return generateDouyuPacket(encodeDouyuMessage({
    type: 'h5ckreq',
    rid: roomId,
    ti: `2501${year}${month}${day}`,
  }))
}

// ==================== 核心逻辑 ====================

async function collectGiftViaDanmu(cookie, roomId) {
  const normalizedRoomId = String(roomId).trim()
  if (!/^\d+$/.test(normalizedRoomId)) {
    throw new Error(`无效的房间号: ${normalizedRoomId}`)
  }

  const missingKeys = LOGIN_COOKIE_KEYS.filter(key => !getCookieValue(cookie, key))
  if (missingKeys.length > 0) {
    logger.warn(`Cookie 缺少以下字段，可能导致领取失败: ${missingKeys.join(', ')}`)
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let loginAccepted = false
    let timer

    const ws = new WebSocket(DOUYU_DANMU_WS_URL, {
      handshakeTimeout: 10000,
      headers: {
        'Cookie': cookie,
        'User-Agent': DOUYU_USER_AGENT,
        'Origin': 'https://www.douyu.com',
        'Referer': `https://www.douyu.com/${normalizedRoomId}`,
      },
    })

    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ws.close()
      error ? reject(error) : resolve()
    }

    timer = setTimeout(() => {
      finish(new Error('等待斗鱼弹幕连接响应超时'))
    }, COLLECT_TIMEOUT_MS)

    ws.on('open', () => {
      logger.info('[WS] 已连接，发送登录包...')
      ws.send(buildLoginPacket(normalizedRoomId, cookie))
    })

    ws.on('message', (data) => {
      for (const message of decodeDouyuMessages(data)) {
        if (message.startsWith('type@=loginres')) {
          if (message.includes('roomgroup@=1')) {
            logger.info('[WS] 登录成功，发送进入房间包...')
            loginAccepted = true
            ws.send(buildEnterRoomPacket(normalizedRoomId))
          } else {
            finish(new Error('Cookie 弹幕鉴权失败，请检查 Cookie'))
          }
        }

        if (message.startsWith('type@=h5ckres')) {
          logger.info('[WS] 收到 h5ckres 响应，荧光棒领取完成！')
          finish()
        }
      }
    })

    ws.on('error', (error) => {
      finish(new Error(`WebSocket 错误: ${error.message}`))
    })

    ws.on('close', () => {
      if (!settled) {
        const suffix = loginAccepted ? '进入房间前连接关闭' : '登录前连接关闭'
        finish(new Error(`弹幕连接${suffix}`))
      }
    })
  })
}

// ==================== 主流程 ====================

export async function run() {
  const result = {
    success: false,
    count: 0,
    error: null,
  }

  // 动态读取 config
  const config = await loadConfig()
  const COOKIE = buildCookieString(config.cookie)
  const ROOM_ID = config.roomId

  if (!COOKIE) {
    result.error = '请先在 config.mjs 中填入你的斗鱼 Cookie'
    logger.error(result.error)
    return result
  }

  logger.info('=== 荧光棒领取 ===')
  logger.separator()

  // 1. 获取粉丝牌列表
  let roomId = ROOM_ID
  let roomIds = []

  if (!roomId) {
    logger.info('[1/3] 获取粉丝牌列表...')
    try {
      const fans = await getFansList(COOKIE)
      if (fans.length === 0) {
        result.error = '未找到任何粉丝牌，请检查 Cookie 是否有效'
        logger.error(result.error)
        return result
      }
      roomIds = fans.map(f => f.roomId)
      roomId = roomIds[Math.floor(Math.random() * roomIds.length)]
      logger.info(`  找到 ${fans.length} 个粉丝牌:`)
      for (const fan of fans) {
        logger.info(`    - ${fan.name} (房间 ${fan.roomId}, 等级 ${fan.level})`)
      }
      logger.info(`  随机选择房间: ${roomId}`)
    } catch (error) {
      result.error = `获取粉丝牌失败: ${error.message}`
      logger.error(result.error)
      return result
    }
  } else {
    logger.info(`[1/3] 使用指定房间: ${roomId}`)
  }

  // 2. 领取前荧光棒数量
  logger.info('[2/3] 查询领取前荧光棒数量...')
  let beforeCount = 0
  try {
    beforeCount = await getGiftNumber(COOKIE, roomIds)
    logger.info(`  当前荧光棒数量: ${beforeCount}`)
  } catch (error) {
    logger.warn(`  查询失败: ${error.message}，继续领取...`)
  }

  // 3. 执行领取
  logger.info(`[3/3] 通过弹幕协议领取荧光棒 (房间 ${roomId})...`)
  try {
    await collectGiftViaDanmu(COOKIE, roomId)
  } catch (error) {
    result.error = `领取失败: ${error.message}`
    logger.error(result.error)
    return result
  }

  // 等待一下再查询
  await new Promise(r => setTimeout(r, 2000))

  // 查询领取后数量
  logger.info('查询领取后荧光棒数量...')
  try {
    const afterCount = await getGiftNumber(COOKIE, roomIds)
    logger.info(`  领取后荧光棒数量: ${afterCount}`)
    const diff = afterCount - beforeCount
    if (diff > 0) {
      result.success = true
      result.count = diff
      logger.success(`成功领取 ${diff} 个荧光棒！`)
    } else if (diff === 0) {
      result.success = true
      logger.warn('领取完成但数量未变化，可能今天已经领取过了')
    } else {
      result.success = true
      logger.warn(`数量变化: ${diff}（可能有其他操作同时进行）`)
    }
  } catch (error) {
    logger.warn(`查询领取后数量失败: ${error.message}`)
    logger.info('领取流程已完成，请手动确认荧光棒数量')
    result.success = true
  }

  return result
}

// 如果直接运行此文件
if (process.argv[1]?.endsWith('collect-gift.mjs')) {
  run().then(result => {
    if (!result.success) process.exit(1)
  }).catch(error => {
    logger.error(`未预期的错误: ${error.message}`)
    process.exit(1)
  })
}
