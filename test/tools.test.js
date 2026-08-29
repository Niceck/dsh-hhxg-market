/**
 * 免费工具真实端点冒烟测试 + VIP 工具纯逻辑单测。
 *
 * 运行：node --test test/
 * 免费工具部分需要网络（打真实 hhxg.top 公开端点）；
 * 设 HHXG_SKIP_NETWORK=1 可只跑纯逻辑部分。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FREE_TOOLS, VIP_TOOLS, vipLockedMessage } from '../lib/tools.js'

const SKIP_NET = process.env.HHXG_SKIP_NETWORK === '1'

test('注册表形态：7 免费 + 5 VIP，名称唯一且带 hhxg_ 前缀', () => {
  assert.equal(FREE_TOOLS.length, 7)
  assert.equal(VIP_TOOLS.length, 5)
  const names = [...FREE_TOOLS, ...VIP_TOOLS].map((t) => t.name)
  assert.equal(new Set(names).size, names.length)
  for (const n of names) assert.match(n, /^hhxg_/)
})

test('VIP 工具 buildArgs：股票代码与边界收敛', () => {
  const diag = VIP_TOOLS.find((t) => t.name === 'hhxg_diagnose_stock')
  assert.deepEqual(diag.buildArgs({ stock_code: '000001.SZ' }), { stock_code: '000001.SZ' })

  const alerts = VIP_TOOLS.find((t) => t.name === 'hhxg_stock_alerts')
  assert.deepEqual(alerts.buildArgs({ stock_code: '600246', days: 7 }), { stock_code: '600246', days: 7 })
  // 越界 days 丢弃（走服务端默认），不透传垃圾值
  assert.deepEqual(alerts.buildArgs({ stock_code: '600246', days: 99 }), { stock_code: '600246' })
  assert.deepEqual(alerts.buildArgs({ stock_code: '600246', days: 'x' }), { stock_code: '600246' })

  const query = VIP_TOOLS.find((t) => t.name === 'hhxg_query_dataset')
  assert.deepEqual(
    query.buildArgs({ dataset_id: 'xuangu', filters: { pool: 'a' }, sort: '-pct', limit: 10 }),
    { dataset_id: 'xuangu', filters: { pool: 'a' }, sort: '-pct', limit: 10 },
  )
  assert.deepEqual(query.buildArgs({ dataset_id: 'xuangu', limit: 9999 }), { dataset_id: 'xuangu' })
})

test('未配置 token 的占位文案含开通与配置指引', () => {
  const msg = vipLockedMessage('hhxg_diagnose_stock')
  assert.match(msg, /vip\.html/)
  assert.match(msg, /account\/mcp\.html/)
  assert.match(msg, /mcpToken/)
  assert.match(msg, /hhxg_datasets/)
})

for (const spec of FREE_TOOLS) {
  test(`免费工具 ${spec.name} 真实调用返回非空文本`, { skip: SKIP_NET }, async () => {
    const out = await spec.run(spec.name === 'hhxg_news' ? { limit: 5 } : {}, undefined)
    assert.equal(typeof out, 'string')
    assert.ok(out.length > 50, `${spec.name} 输出过短: ${out.slice(0, 80)}`)
    assert.ok(!out.includes('undefined |'), `${spec.name} 输出含未清洗的 undefined`)
    assert.match(out, /hhxg\.top/, '输出应带数据来源落款')
  })
}
