/**
 * 粉丝牌保活脚本
 *
 * 功能：将所有荧光棒赠送给指定房间
 * 使用：node keepalive.mjs
 */

import axios from 'axios'
import * as logger from './logger.mjs'

// ==================== 配置 ====================

// 将 cookie 对象转换为字符串
function buildCookieString(cookieObj) {
  return Object.entries(cookieObj)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ')
}

// 动态读取 config.mjs（绕过 ESM 模块缓存）
async function loadConfig() {
  const mod = await import(`./config.mjs?t=${Date.now()}`)
  return mod.default
}

async function getCookie() {
  const config = await loadConfig()
  return buildCookieString(config.cookie)
}

async function getKeepaliveConfig() {
  const config = await loadConfig()
  return config.keepalive
}
// ==================== 配置结束 ====================

const DOUYU_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36 Edg/15.0.1901.188'
const GLOW_STICK_GIFT_ID = 268

// ==================== 工具函数 ====================

function makeHeaders(cookie) {
  return {
    'Cookie': cookie,
    'User-Agent': DOUYU_USER_AGENT,
    'Referer': 'https://www.douyu.com/',
    'Origin': '*',
  }
}

function getCookieValue(cookie, name) {
  const record = cookie.split(';').reduce((acc, chunk) => {
    const [key, ...rest] = chunk.trim().split('=')
    if (key?.trim()) acc[key.trim()] = rest.join('=').trim()
    return acc
  }, {})
  return record[name]
}

function parseDyAndSidFromCookie(cookie) {
  const sid = getCookieValue(cookie, 'acf_uid')
  const dy = getCookieValue(cookie, 'dy_did')
  if (!sid || !dy) {
    throw new Error('Cookie 中没有找到 acf_uid(sid) 和 dy_did(dy)')
  }
  return { sid, dy }
}

function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time))
}

// ==================== API 函数 ====================

async function getFansList(cookie) {
  const res = await axios.get('https://www.douyu.com/member/cp/getFansBadgeList', {
    headers: makeHeaders(cookie),
  })

  logger.info(`  API 响应状态: ${res.status}`)
  logger.info(`  响应类型: ${typeof res.data}`)

  if (typeof res.data !== 'string') {
    // 尝试解析 JSON 格式
    if (typeof res.data === 'object' && res.data !== null) {
      logger.info('  尝试解析 JSON 格式响应...')
      if (Array.isArray(res.data)) {
        return res.data.map(item => ({
          name: item.name || item.anchor_name || '未知',
          roomId: Number(item.roomId || item.room_id || item.fans_room),
          level: Number(item.level || item.fans_level || 1),
        }))
      }
      if (res.data.data && Array.isArray(res.data.data)) {
        return res.data.data.map(item => ({
          name: item.name || item.anchor_name || '未知',
          roomId: Number(item.roomId || item.room_id || item.fans_room),
          level: Number(item.level || item.fans_level || 1),
        }))
      }
    }
    throw new Error(`获取粉丝牌列表失败，返回数据格式异常: ${JSON.stringify(res.data).substring(0, 200)}`)
  }

  const table = res.data.match(/fans-badge-list">([\S\s]*?)<\/table>/)?.[1]
  if (!table) {
    // 打印响应内容帮助调试
    logger.info(`  响应内容前500字符: ${res.data.substring(0, 500)}`)
    throw new Error('获取粉丝牌列表失败，请检查 Cookie 是否有效')
  }

  const list = table.match(/<tr([\s\S]*?)<\/tr>/g)
  list?.shift()
  const fans = list?.map((item) => {
    const name = item.match(/data-anchor_name="([\S\s]+?)"/)?.[1]
    const roomId = item.match(/data-fans-room="(\d+)"/)?.[1]
    const level = item.match(/data-fans-level="(\d+)"/)?.[1]
    return { name, roomId: Number(roomId), level: Number(level) }
  }) ?? []

  return fans
}

async function getGiftNumber(cookie, candidateRoomIds = []) {
  const roomIds = [...new Set([217331, 557171, ...candidateRoomIds])]
  const endpoints = roomIds.flatMap(rid => [
    `https://www.douyu.com/japi/prop/backpack/web/v5?rid=${rid}`,
    `https://www.douyu.com/japi/prop/backpack/web/v1?rid=${rid}`,
  ])

  for (const endpoint of endpoints) {
    try {
      const { data } = await axios.get(endpoint, {
        headers: makeHeaders(cookie),
      })

      if (data?.error !== 0) continue
      if (!data?.data?.list) continue

      const glowSticks = data.data.list.filter(item => item.id === GLOW_STICK_GIFT_ID)
      const count = glowSticks.reduce((sum, item) => sum + (item.count || 0), 0)
      return count
    } catch {
      continue
    }
  }

  throw new Error('获取荧光棒数量失败')
}

async function getDid(roomId, cookie) {
  const res = await axios.get(`https://www.douyu.com/${roomId}`, {
    headers: makeHeaders(cookie),
  })
  const did1 = res.data.match(/owner_uid =(.*?);/)?.[1]?.trim()
  const did2 = res.data.match(/owner_uid:(.*?),/)?.[1]?.trim()
  if (did1 !== undefined) return did1
  if (did2 !== undefined) return did2
  throw new Error('获取 did 失败')
}

async function sendGift(args, job, cookie) {
  const formData = new URLSearchParams()
  formData.append('rid', String(job.roomId))
  formData.append('prop_id', String(job.giftId))
  formData.append('num', String(job.count))
  formData.append('sid', args.sid)
  formData.append('did', args.did)
  formData.append('dy', args.dy)

  const res = await axios.post('https://www.douyu.com/member/prop/send', formData.toString(), {
    headers: {
      ...makeHeaders(cookie),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  })

  const data = res.data
  if (data?.error !== undefined && data.error !== 0) {
    throw new Error(`赠送失败，错误码 ${data.error}: ${data.msg || data.message || '无错误信息'}`)
  }

  return data
}

// ==================== 计算函数 ====================

function computeGiftCountOfProportion(number, send) {
  const sendSort = Object.values(send).map(item => ({ ...item })).sort((a, b) => a.weight - b.weight)
  const totalWeight = sendSort.reduce((sum, item) => sum + item.weight, 0)

  if (totalWeight <= 0) {
    throw new Error('按权重模式至少需要一个房间填写大于 0 的权重值')
  }

  for (let i = 0; i < sendSort.length; i++) {
    const item = sendSort[i]
    if (i === sendSort.length - 1) {
      const count = number - sendSort.reduce((sum, entry) => sum + (entry.count || 0), 0)
      if (count < 0) {
        throw new Error(`荧光棒数量不足，请重新配置。当前 ${number} 个，需求至少 ${sendSort.filter(entry => entry.weight > 0).length} 个`)
      }
      item.count = count
    } else {
      if (item.weight === 0) {
        item.count = 0
        continue
      }
      const count = Math.floor((item.weight / totalWeight) * number)
      item.count = count === 0 ? 1 : count
    }
  }

  const newSend = sendSort.reduce((acc, item) => {
    acc[item.roomId] = item
    return acc
  }, {})

  const cfgCountNumber = Object.values(newSend).reduce((a, b) => a + (b.count || 0), 0)
  if (cfgCountNumber > number) {
    throw new Error(`荧光棒数量不足，请重新配置。当前 ${number} 个，需求 ${cfgCountNumber} 个`)
  }

  return newSend
}

function computeGiftCountOfNumber(number, send) {
  const sendSort = Object.values(send).map(item => ({ ...item })).sort((a, b) => b.number - a.number)
  const cfgCountNumber = sendSort.reduce((a, b) => a + (b.number === -1 ? 0 : b.number), 0)

  if (cfgCountNumber > number) {
    throw new Error(`荧光棒数量不足，请重新配置。当前 ${number} 个，需求 ${cfgCountNumber} 个`)
  }

  const remainderRooms = sendSort.filter(item => item.number === -1)
  if (remainderRooms.length > 1) {
    throw new Error('固定数量模式最多只能有一个房间配置为 -1')
  }

  let assignedCount = 0
  for (const item of sendSort) {
    if (item.number === -1) {
      item.count = 0
    } else {
      item.count = item.number
      assignedCount += item.number
    }
  }

  if (remainderRooms.length === 1) {
    remainderRooms[0].count = number - assignedCount
  }

  return sendSort.reduce((acc, item) => {
    acc[item.roomId] = item
    return acc
  }, {})
}

// ==================== 主流程 ====================

export async function run() {
  const result = {
    success: false,
    count: 0,
    error: null,
  }

  // 动态读取 config，确保扫码登录更新后能读到最新值
  const COOKIE = await getCookie()
  const KEEPALIVE_CONFIG = await getKeepaliveConfig()

  if (!COOKIE) {
    result.error = '请先在 config.mjs 中填入你的斗鱼 Cookie'
    logger.error(result.error)
    return result
  }

  logger.info('=== 斗鱼粉丝牌保活 ===')
  logger.separator()

  // 1. 获取粉丝牌列表
  logger.info('[1/4] 获取粉丝牌列表...')
  let fans = []
  try {
    fans = await getFansList(COOKIE)
    if (fans.length === 0) {
      result.error = '未找到任何粉丝牌，请检查 Cookie 是否有效'
      logger.error(result.error)
      return result
    }
    logger.info(`  找到 ${fans.length} 个粉丝牌:`)
    for (const fan of fans) {
      logger.info(`    - ${fan.name} (房间 ${fan.roomId}, 等级 ${fan.level})`)
    }
  } catch (error) {
    result.error = `获取粉丝牌失败: ${error.message}`
    logger.error(result.error)
    return result
  }

  // 2. 准备赠送配置
  const sendConfig = {}
  for (const [key, value] of Object.entries(KEEPALIVE_CONFIG.send)) {
    sendConfig[key] = {
      roomId: value.roomId,
      giftId: value.giftId || GLOW_STICK_GIFT_ID,
      weight: value.weight || 1,
      number: value.number || 0,
      count: 0,
    }
  }

  const roomIds = Object.values(sendConfig).map(item => item.roomId)

  // 3. 获取荧光棒数量
  logger.info('[2/4] 获取当前荧光棒数量...')
  let giftNumber
  try {
    giftNumber = await getGiftNumber(COOKIE, roomIds)
    logger.info(`  当前荧光棒数量: ${giftNumber}`)
  } catch (error) {
    result.error = `获取荧光棒数量失败: ${error.message}`
    logger.error(result.error)
    return result
  }

  if (giftNumber === 0) {
    result.success = true
    logger.info('荧光棒数量为 0，无需赠送')
    return result
  }

  // 4. 计算赠送分配
  logger.info('[3/4] 计算赠送分配...')
  let jobs
  try {
    const model = KEEPALIVE_CONFIG.model || 1
    if (model === 1) {
      logger.info('  模式: 按权重比例分配')
      jobs = computeGiftCountOfProportion(giftNumber, sendConfig)
    } else {
      logger.info('  模式: 按固定数量分配')
      jobs = computeGiftCountOfNumber(giftNumber, sendConfig)
    }

    logger.info('  赠送计划:')
    for (const item of Object.values(jobs)) {
      if (item.count > 0) {
        logger.info(`    - 房间 ${item.roomId}: ${item.count} 个荧光棒`)
      }
    }
  } catch (error) {
    result.error = `计算赠送分配失败: ${error.message}`
    logger.error(result.error)
    return result
  }

  // 5. 执行赠送
  logger.info('[4/4] 执行赠送...')
  let args
  try {
    args = parseDyAndSidFromCookie(COOKIE)
  } catch (error) {
    result.error = `获取参数失败: ${error.message}`
    logger.error(result.error)
    return result
  }

  let failedNumber = 0
  let successCount = 0

  for (const item of Object.values(jobs)) {
    if (item.count === 0) continue

    item.count = (item.count ?? 0) + failedNumber

    try {
      logger.info(`  正在赠送房间 ${item.roomId} ${item.count} 个荧光棒...`)
      const did = await getDid(item.roomId.toString(), COOKIE)
      args.did = did
      await sendGift(args, item, COOKIE)
      failedNumber = 0
      successCount += item.count
      logger.success(`    赠送成功`)
    } catch (error) {
      failedNumber += item?.count ?? 0
      logger.error(`    赠送失败: ${error.message}`)
      logger.info(`    ${item.count} 个荧光棒自动移交给下一个房间`)
    }

    await sleep(2000)
  }

  logger.separator()
  if (failedNumber > 0) {
    result.success = false
    result.error = `有 ${failedNumber} 个荧光棒未赠送成功`
    logger.warn(result.error)
  } else {
    result.success = true
    result.count = successCount
    logger.success(`成功赠送 ${successCount} 个荧光棒`)
  }

  // 查询剩余数量
  logger.info('查询剩余荧光棒数量...')
  try {
    const remaining = await getGiftNumber(COOKIE, roomIds)
    logger.info(`  剩余荧光棒数量: ${remaining}`)
  } catch (error) {
    logger.warn(`  查询失败: ${error.message}`)
  }

  return result
}

// 如果直接运行此文件
if (process.argv[1]?.endsWith('keepalive.mjs')) {
  run().then(result => {
    if (!result.success) {
      process.exit(1)
    }
  }).catch(error => {
    logger.error(`未预期的错误: ${error.message}`)
    process.exit(1)
  })
}
