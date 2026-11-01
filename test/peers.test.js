/**
 * peer 范围契约：严格 semver 与 includePrerelease 两种匹配语义下都要接受已知的 dsh 宿主版本、
 * 拒绝更低版本与下一主 / 次版本。dsh 生态全是预发布版本，严格 semver 不会用一个普通区间接纳
 * 不同 patch 的预发布，所以 dsh-tools 另列出已知版本。版本匹配 ≠ 运行兼容：真正的 API 兼容
 * 仍靠 contract.test.js 用真实 SDK 编译。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

async function loadSemver() {
  try {
    return (await import('semver')).default
  } catch {
    return null
  }
}
const semver = await loadSemver()
const SKIP = !semver && (process.env.CI ? false : '本机未安装 devDependency semver（npm ci 后可跑）')

test('CI 必须装到 semver（peer 范围测试不得在 CI 静默跳过）', { skip: !process.env.CI && '仅 CI' }, () => {
  assert.ok(semver, 'CI 环境没有 semver：检查 npm ci / lockfile 的 devDependencies')
})

test('peer 范围：两种预发布匹配模式都接受已知宿主版本、拒绝更低与下一主/次版本', { skip: SKIP }, () => {
  const pkg = createRequire(import.meta.url)('../package.json')
  const peers = pkg.peerDependencies
  const matrix = {
    '@deepseek-ai/dsh-tools': {
      ok: ['0.1.1-rc.1', '0.1.7-rc.2', '0.2.0-rc.1', '0.2.1-rc.5', '0.2.2-alpha.2', '0.2.2'],
      no: ['0.1.0', '0.1.1-rc.0', '0.3.0-alpha.1', '0.3.0', '1.0.0'],
    },
    '@deepseek-ai/cordis': { ok: ['4.0.1', '4.0.5', '4.9.0'], no: ['3.9.9', '4.0.0', '5.0.0-alpha.1', '5.0.0'] },
    '@deepseek-ai/schemastery': { ok: ['3.18.1', '3.18.5', '3.99.0'], no: ['3.17.9', '4.0.0-0', '4.0.0'] },
  }
  for (const [name, { ok, no }] of Object.entries(matrix)) {
    const range = peers[name]
    assert.ok(range, `package.json 缺 peer ${name}`)
    for (const opts of [{}, { includePrerelease: true }]) {
      for (const v of ok) assert.ok(semver.satisfies(v, range, opts), `${name}@${v} 应满足 ${range} ${JSON.stringify(opts)}`)
      for (const v of no) assert.ok(!semver.satisfies(v, range, opts), `${name}@${v} 不应满足 ${range} ${JSON.stringify(opts)}`)
    }
  }
})
