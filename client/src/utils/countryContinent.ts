/**
 * 国家代码 → 洲。
 *
 * 洲这一层**不落库**：地区只存国家代码，洲是推导出来的。这样加一个地区不需要
 * 同时维护「它属于哪个洲」，购买页与定价表也不会各存一份分组。
 * 国家名与旗帜仍由 `countryDisplay.ts` 负责，这里只做分组。
 */
export type ContinentCode = 'asia-pacific' | 'north-america' | 'europe' | 'middle-east-africa' | 'south-america' | 'other'

/** 展示顺序，与产品方案里的顺序一致。 */
export const CONTINENT_ORDER: ContinentCode[] = [
  'asia-pacific',
  'north-america',
  'europe',
  'middle-east-africa',
  'south-america',
  'other'
]

const CONTINENT_BY_COUNTRY: Record<string, ContinentCode> = {
  // 北美地区
  us: 'north-america',
  ca: 'north-america',
  mx: 'north-america',
  // 南美地区
  br: 'south-america',
  cl: 'south-america',
  co: 'south-america',
  // 欧洲
  fr: 'europe',
  de: 'europe',
  it: 'europe',
  nl: 'europe',
  rs: 'europe',
  es: 'europe',
  se: 'europe',
  ch: 'europe',
  gb: 'europe',
  // 中东和非洲地区
  il: 'middle-east-africa',
  ke: 'middle-east-africa',
  ma: 'middle-east-africa',
  sa: 'middle-east-africa',
  za: 'middle-east-africa',
  ae: 'middle-east-africa',
  // 亚太地区
  au: 'asia-pacific',
  in: 'asia-pacific',
  id: 'asia-pacific',
  jp: 'asia-pacific',
  my: 'asia-pacific',
  sg: 'asia-pacific',
  kr: 'asia-pacific'
}

/** 推不出洲的国家归入 `other`，界面上显示为「其他」而不是隐藏。 */
export function continentOf(countryCode: string | null | undefined): ContinentCode {
  const code = (countryCode || '').trim().toLowerCase()
  return CONTINENT_BY_COUNTRY[code] ?? 'other'
}

/** 把带国家代码的条目按洲分组，并保持 `CONTINENT_ORDER` 的顺序。 */
export function groupByContinent<T extends { countryCode?: string | null }>(items: T[]) {
  const buckets = new Map<ContinentCode, T[]>()
  for (const item of items) {
    const code = continentOf(item.countryCode)
    const bucket = buckets.get(code) ?? []
    bucket.push(item)
    buckets.set(code, bucket)
  }
  return CONTINENT_ORDER
    .filter(code => buckets.has(code))
    .map(code => ({ code, items: buckets.get(code)! }))
}
