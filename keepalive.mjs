/**
 * 粉丝牌保活脚本
 *
 * 功能：将所有荧光棒赠送给指定房间
 * 使用：node keepalive.mjs
 */

import axios from 'axios'
import * as logger from './logger.mjs'
import { loadConfig, buildCookieString, DOUYU_USER_AGENT } from './utils.mjs'
import { getFansList, getGiftNumber, getDid, sendGift, parseDyAndSidFromCookie, sleep } from './api.mjs'

// ==================== 常量 ====================

const GLOW_STICK_GIFT_ID = 268

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

  // 动态读取 config
  const config = await loadConfig()
  const COOKIE = buildCookieString(config.cookie)
  const KEEPALIVE_CONFIG = config.keepalive

  if (!COOKIE) {
    result.error = '请先在 config.mjs 中填入你的斗鱼 Cookie'
    logger.error(result.error)
    return result
  }

  logger.info('=== 粉丝牌保活 ===')
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

    const originalCount = item.count
    item.count = originalCount + failedNumber

    try {
      logger.info(`  正在赠送房间 ${item.roomId} ${item.count} 个荧光棒...`)
      const did = await getDid(item.roomId.toString(), COOKIE)
      args.did = did
      await sendGift(args, item, COOKIE)
      failedNumber = 0
      successCount += item.count
      logger.success(`    赠送成功`)
    } catch (error) {
      failedNumber += originalCount
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
    if (!result.success) process.exit(1)
  }).catch(error => {
    logger.error(`未预期的错误: ${error.message}`)
    process.exit(1)
  })
}
