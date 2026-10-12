/**
 * 一机一卖：开通失败的收尾与多台订单的批次汇总。
 *
 * 失败结算（清理 Incus 残留、实例进 error、全额退款）仍由
 * cleanupAndSettleFailedProvision 完成；这里只做它之后的事：
 *   1. 退款已到账，失败实例自动删除，机器不再被这条 error 行占用；
 *   2. 失败的宿主机置为维护、退出销售，通知管理员确认后再恢复；
 *   3. 多台订单不逐台通知，全部到达终态后只发一条汇总。
 *
 * 本文件刻意不导入 create-async / pool-orders，避免循环导入。
 */
import { prisma } from '../db/prisma.js'
import { createLog } from '../db/logs.js'
import { sharedAddOnce } from '../lib/shared-state.js'
import { sendNotification, sendToChannel } from '../lib/notifier.js'

const SUMMARY_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000

/** 实例属于多台订单（同批次不止一台）时返回批次号，否则返回 null。 */
export async function multiInstanceBatchOf(instanceId: number): Promise<string | null> {
  const instance = await prisma.instance.findUnique({ where: { id: instanceId }, select: { purchaseBatchId: true } })
  if (!instance?.purchaseBatchId) return null
  const siblings = await prisma.instance.count({ where: { purchaseBatchId: instance.purchaseBatchId } })
  return siblings > 1 ? instance.purchaseBatchId : null
}

/**
 * 批次内没有「创建中」的实例时发一条汇总；用共享状态去重，多个 worker 同时收尾也只发一次。
 */
export async function maybeSendPoolOrderSummary(batchId: string): Promise<void> {
  const [creating, total] = await Promise.all([
    prisma.instance.count({ where: { purchaseBatchId: batchId, status: 'creating' } }),
    prisma.instance.count({ where: { purchaseBatchId: batchId } })
  ])
  if (total === 0 || creating > 0) return

  const first = await sharedAddOnce(`pool-order-summary:${batchId}`, SUMMARY_DEDUPE_TTL_MS)
  if (!first) return

  const [ready, owner, refunds] = await Promise.all([
    prisma.instance.count({ where: { purchaseBatchId: batchId, status: { in: ['running', 'stopped'] } } }),
    prisma.instance.findFirst({ where: { purchaseBatchId: batchId }, select: { userId: true } }),
    prisma.instanceBillingRecord.aggregate({
      where: { type: 'refund', instance: { purchaseBatchId: batchId } },
      _sum: { amount: true }
    })
  ])
  if (!owner) return

  await sendNotification(owner.userId, 'pool_order_completed', {
    batchId,
    totalCount: total,
    readyCount: ready,
    failedCount: total - ready,
    refundAmount: Math.abs(Number(refunds._sum.amount ?? 0))
  })
}

/**
 * 池子实例失败结算之后的收尾。只对 poolPriceId 非空、且已进入 error 的实例生效；
 * 对旧模型实例是空操作，所以两个调用方（立即失败、10 分钟超时）可以无条件调用。
 */
export async function handlePoolProvisionFailure(instanceId: number, reason: string): Promise<void> {
  const instance = await prisma.instance.findUnique({
    where: { id: instanceId },
    select: {
      id: true, name: true, userId: true, hostId: true, status: true,
      poolPriceId: true, purchaseBatchId: true, provisioningCleanupPending: true,
      host: { select: { id: true, name: true, status: true } }
    }
  })
  if (!instance?.poolPriceId) return
  if (instance.status !== 'error' || instance.provisioningCleanupPending) return

  // 1. 退款已经完成，失败行没有保留价值：清掉关联数据并软删除，机器立刻不再被它占用。
  //    关联数据的清单与销毁路径一致；资源计数在失败结算里已经回滚过，这里不再动。
  await prisma.$transaction(async tx => {
    const claimed = await tx.instance.updateMany({
      where: { id: instanceId, status: 'error' },
      data: {
        status: 'deleted',
        deletionRemoteDeleted: true,
        deletionBillingPending: false,
        version: { increment: 1 }
      }
    })
    if (claimed.count !== 1) return
    await tx.ipAddress.deleteMany({ where: { instanceId } })
    await tx.ipv6Subnet.deleteMany({ where: { instanceId } })
    await tx.portMapping.deleteMany({ where: { instanceId } })
    await tx.proxySite.deleteMany({ where: { instanceId } })
    await tx.dailyTraffic.deleteMany({ where: { instanceId } })
    await tx.instanceTask.deleteMany({ where: { instanceId, status: { in: ['COMPLETED', 'FAILED'] } } })
    // 2. 失败的宿主机退出销售。连续把客户派到一台坏机器上，比少卖一台严重得多。
    await tx.host.updateMany({ where: { id: instance.hostId, status: { not: 'maintenance' } }, data: { status: 'maintenance' } })
  })

  await createLog(
    instance.userId,
    'instance',
    'instance.pool_provision_failed',
    `Dedicated machine "${instance.host.name}" failed to provision "${instance.name}" (${reason}); instance removed after refund, host set to maintenance`,
    'failed',
    { instanceId }
  )

  // 3. 通知管理员：站内信逐个管理员一条，全局通知渠道一条。失败不影响主流程。
  try {
    const admins = await prisma.user.findMany({ where: { role: 'admin' }, select: { id: true } })
    for (const admin of admins) {
      await sendNotification(admin.id, 'pool_host_provision_failed', {
        hostName: instance.host.name,
        instanceName: instance.name,
        error: reason
      })
    }
    const globalChannel = await prisma.notificationChannel.findFirst({ where: { isGlobal: true }, select: { id: true } })
    if (globalChannel) {
      await sendToChannel(
        globalChannel.id,
        '🛠️ 宿主机开通失败，已置为维护',
        `宿主机「${instance.host.name}」上的实例「${instance.name}」开通失败，客户已退款。\n错误: ${reason}\n机器已退出销售，请检查后恢复在线。`
      )
    }
  } catch (error) {
    console.error('[PoolProvisionFailure] 通知管理员失败:', error)
  }

  // 4. 多台订单的批次汇总
  if (instance.purchaseBatchId) {
    await maybeSendPoolOrderSummary(instance.purchaseBatchId).catch(error => {
      console.error('[PoolProvisionFailure] 批次汇总失败:', error)
    })
  }
}
