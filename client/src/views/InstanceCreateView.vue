<script setup lang="ts">
/**
 * 「创建实例」页 = 池子购买向导（一机一卖）
 *
 * 本站只卖池子商品（一台宿主机只卖给一位客户），所以这一页直接就是向导：
 * 洲 → 国家/地区 → 机型（E2 / ARM，ARM 再分 1C~4C）→ 硬盘档 → 镜像 → 凭据 → 付款。
 *
 * 旧的 ?poolPriceId=N 链接映射成向导的商品参数 ?product=N，老书签/分享仍可用。
 * 保留组件名 InstanceCreateView，供 KeepAlive exclude 与路由匹配。
 */
defineOptions({ name: 'InstanceCreateView' })

import { onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PoolPurchaseWizard from '@/components/purchase/PoolPurchaseWizard.vue'
import { parsePackageIdQuery } from '@/utils/publicCatalog'

const route = useRoute()
const router = useRouter()

onMounted(() => {
  const legacyProductId = parsePackageIdQuery(route.query.poolPriceId)
  if (legacyProductId !== null && parsePackageIdQuery(route.query.product) === null) {
    void router.replace({
      query: {
        ...route.query,
        product: String(legacyProductId),
        poolPriceId: undefined
      }
    })
  }
})
</script>

<template>
  <PoolPurchaseWizard />
</template>
