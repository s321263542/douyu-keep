/**
 * 斗鱼 API 公共模块
 *
 * 统一管理斗鱼 HTTP API 调用，带超时和错误处理
 */

import axios from 'axios'
import { DOUYU_USER_AGENT, getCookieValue } from './utils.mjs'

// ==================== 常量 ====================

const GLOW_STICK_GIFT_ID = 268
const DEFAULT_BACKPACK_ROOM_IDS = [217331, 557171]
const REQUEST_TIMEOUT = 15000
const MAX_RETRIES = 3

/**
 * 带重试的请求封装
 * 超时或网络错误时自动重试
 */
async function requestWithRetry(fn, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn()
    } catch (error) {
      const isTimeout = error.code === 'ECONNABORTED' || error.message.includes('timeout')
      const isNetwork = error.code === 'ECONNRESET' || error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED'
      if ((isTimeout || isNetwork) && i < retries - 1) {
        await sleep(2000 * (i + 1))
        continue
      }
      throw error
    }
  }
}

/**
 * 创建带默认超时的 axios 请求头
 */
function makeHeaders(cookie, extraHeaders = {}) {
  return {
    'Cookie': cookie,
    'User-Agent': DOUYU_USER_AGENT,
    'Referer': 'https://www.douyu.com/',
    'Origin': '*',
    ...extraHeaders,
  }
}

// ==================== API 函数 ====================

/**
 * 获取粉丝牌列表（带重试）
 */
export async function getFansList(cookie) {
  const res = await requestWithRetry(() => axios.get('https://www.douyu.com/member/cp/getFansBadgeList', {
    headers: makeHeaders(cookie),
    timeout: REQUEST_TIMEOUT,
  }))

  if (typeof res.data !== 'string') {
    throw new TypeError('获取粉丝牌列表失败，返回数据格式异常')
  }

  const table = res.data.match(/fans-badge-list">([\S\s]*?)<\/table>/)?.[1]
  if (!table) {
    throw new Error('获取粉丝牌列表失败，请检查 Cookie 是否有效')
  }

  const list = table.match(/<tr([\s\S]*?)<\/tr>/g)
  list?.shift()
  const fans = list?.map((item) => {
    const name = item.match(/data-anchor_name="([\S\s]+?)"/)?.[1]
    const roomId = item.match(/data-fans-room="(\d+)"/)?.[1]
    const level = item.match(/data-fans-level="(\d+)"/)?.[1]
    const rank = item.match(/data-fans-rank="(\d+)"/)?.[1]
    const tds = item.match(/<td([\s\S]*?)<\/td>/g)
    return {
      name: String(name || ''),
      roomId: Number(roomId),
      level: Number(level),
      rank: Number(rank || 0),
      intimacy: tds?.[2] ? String(tds[2].replace(/<([\s\S]*?)>/g, '').trim()) : '0',
      today: tds?.[3] ? Number(tds[3].replace(/<([\s\S]*?)>/g, '').trim()) : 0,
    }
  }) ?? []

  return fans
}

/**
 * 获取荧光棒数量（带重试）
 */
export async function getGiftNumber(cookie, candidateRoomIds = []) {
  const roomIds = [...new Set([...DEFAULT_BACKPACK_ROOM_IDS, ...candidateRoomIds])]
  const endpoints = roomIds.flatMap(rid => [
    `https://www.douyu.com/japi/prop/backpack/web/v5?rid=${rid}`,
    `https://www.douyu.com/japi/prop/backpack/web/v1?rid=${rid}`,
  ])

  for (const endpoint of endpoints) {
    try {
      const { data } = await requestWithRetry(() => axios.get(endpoint, {
        headers: makeHeaders(cookie),
        timeout: REQUEST_TIMEOUT,
      }))

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

/**
 * 获取房间主播 uid（did，带重试）
 */
export async function getDid(roomId, cookie) {
  const res = await requestWithRetry(() => axios.get(`https://www.douyu.com/${roomId}`, {
    headers: makeHeaders(cookie),
    timeout: REQUEST_TIMEOUT,
  }))
  const did1 = res.data.match(/owner_uid =(.*?);/)?.[1]?.trim()
  const did2 = res.data.match(/owner_uid:(.*?),/)?.[1]?.trim()
  if (did1 !== undefined) return did1
  if (did2 !== undefined) return did2
  throw new Error('获取 did 失败')
}

/**
 * 赠送礼物（带重试）
 */
export async function sendGift(args, job, cookie) {
  const formData = new URLSearchParams()
  formData.append('rid', String(job.roomId))
  formData.append('prop_id', String(job.giftId))
  formData.append('num', String(job.count))
  formData.append('sid', args.sid)
  formData.append('did', args.did)
  formData.append('dy', args.dy)

  const res = await requestWithRetry(() => axios.post('https://www.douyu.com/member/prop/send', formData.toString(), {
    headers: {
      ...makeHeaders(cookie),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    timeout: REQUEST_TIMEOUT,
  }))

  const data = res.data
  if (data?.error !== undefined && data.error !== 0) {
    throw new Error(`赠送失败，错误码 ${data.error}: ${data.msg || data.message || '无错误信息'}`)
  }

  return data
}

/**
 * 从 Cookie 中解析 sid 和 dy
 */
export function parseDyAndSidFromCookie(cookie) {
  const sid = getCookieValue(cookie, 'acf_uid')
  const dy = getCookieValue(cookie, 'dy_did')
  if (!sid || !dy) {
    throw new Error('Cookie 中没有找到 acf_uid(sid) 和 dy_did(dy)')
  }
  return { sid, dy }
}

/**
 * 延时函数
 */
export function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time))
}

/**
 * 验证 Cookie 是否有效（尝试获取粉丝牌列表）
 */
export async function validateCookie(cookie) {
  try {
    const res = await requestWithRetry(() => axios.get('https://www.douyu.com/member/cp/getFansBadgeList', {
      headers: makeHeaders(cookie),
      timeout: REQUEST_TIMEOUT,
    }))
    if (typeof res.data === 'string' && res.data.includes('fans-badge-list')) {
      return true
    }
    return false
  } catch {
    return false
  }
}
