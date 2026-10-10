type ReleaseCandidate = Record<string, unknown> & { tag_name: string; assets: unknown[] }

// GitHub's release listing order is not a semantic-version ordering.
export function selectLatestAgentRelease(value: unknown): ReleaseCandidate | null {
  if (!Array.isArray(value)) return null
  let latest: ReleaseCandidate | null = null
  let latestParts: bigint[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const release = item as Record<string, unknown>
    if (release.draft === true || release.prerelease === true || typeof release.tag_name !== 'string' || release.tag_name.length > 128 || !Array.isArray(release.assets) || !release.assets.length) continue
    const match = release.tag_name.trim().match(/^agent-v(\d+)\.(\d+)\.(\d+)$/)
    if (!match) continue
    const parts = match.slice(1).map(part => BigInt(part))
    let comparison = latest ? 0 : 1
    if (latest) {
      for (let index = 0; index < 3; index += 1) {
        if (parts[index] === latestParts[index]) continue
        comparison = parts[index] > latestParts[index] ? 1 : -1
        break
      }
    }
    if (comparison > 0) {
      latest = release as ReleaseCandidate
      latestParts = parts
    }
  }
  return latest
}
