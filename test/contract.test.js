/**
 * 契约测试：所有工具 spec 必须能通过真实 defineTool 编译；插件 apply() 统一注册 13 个工具。
 *
 * 背景（2026-08-28 审查 CRITICAL）：defineTool 对 schema 是硬校验，
 * 任一 spec 非法会在 apply() 内同步 throw，cordis 随即回滚整个插件的
 * 全部注册——一个字段笔误 = 用户装上后 0 个工具。此测试是唯一防线。
 *
 * 依赖 dsh SDK（npm ci 装的 peer，或本机 ~/.dsh/profiles/node_modules）；未安装时跳过
 * （CI 无 SDK 环境下由 npm 安装的 devDependencies 补位，或显式跳过）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { TOOLS, tokenRequiredMessage } from '../lib/tools.js'
import { VALID_ARGS } from './tools.test.js'

async function loadDefineTool() {
  try {
    // 优先常规解析（npm 安装了 peer/dev 依赖时）
    const mod = await import('@deepseek-ai/dsh-tools')
    return mod.defineTool
  } catch {
    // 回落到本机 dsh profile 的 SDK
    try {
      const req = createRequire(import.meta.url)
      const resolved = req.resolve('@deepseek-ai/dsh-tools', {
        paths: [path.join(os.homedir(), '.dsh/profiles/node_modules')],
      })
      const mod = await import(pathToFileURL(resolved).href)
      return mod.defineTool
    } catch {
      return null
    }
  }
}

/** 插件入口按裸包名 import peer（schemastery / dsh-tools）：只有 npm 装了依赖才能加载。 */
async function loadPlugin() {
  try {
    return await import('../lib/index.js')
  } catch {
    return null
  }
}

const defineTool = await loadDefineTool()
const plugin = await loadPlugin()
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
}

// CI 里 npm ci 会按 lockfile 装上 peer 的真实 SDK：那里缺 SDK 不是「可跳过」而是环境坏了（Codex 评审）
const SKIP = !defineTool && (process.env.CI ? false : '本机无 dsh SDK')
const SKIP_PLUGIN = !plugin && (process.env.CI ? false : '本机未 npm ci（lib/index.js 的 peer 依赖不可解析）')

test('CI 必须装到真实 dsh SDK（契约测试不得在 CI 静默跳过）', { skip: !process.env.CI && '仅 CI' }, () => {
  assert.ok(defineTool, 'CI 环境没有 @deepseek-ai/dsh-tools：检查 npm ci / lockfile 的 peer 依赖')
  assert.ok(plugin, 'CI 环境加载不了 lib/index.js：检查 npm ci / lockfile 的 peer 依赖')
})

test('全部 13 个工具 spec 通过真实 defineTool 编译', { skip: SKIP }, () => {
  assert.equal(TOOLS.length, 13)
  for (const spec of TOOLS) {
    assert.doesNotThrow(
      () => defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: TEXT_OUTPUT,
        async execute() { return '' },
      }),
      `defineTool(${spec.name}) 必须不抛错——否则整个插件在装载时被回滚`,
    )
  }
})

test('带 presentationMeta 的 output（hhxg_realtime 桌面卡投影）也通过 defineTool 编译', { skip: SKIP }, () => {
  const rt = TOOLS.find((t) => t.name === 'hhxg_realtime')
  assert.doesNotThrow(() => defineTool({
    name: rt.name,
    description: rt.description,
    parameters: rt.parameters,
    output: { ...TEXT_OUTPUT, presentationMeta: () => undefined },
    async execute() { return '' },
  }))
})

test('apply()：13 个工具统一注册；没 token 时每个工具的 execute 返回开通指引且不发请求；Config 只剩 mcpToken', { skip: SKIP_PLUGIN }, async () => {
  const registered = []
  const logs = []
  const ctx = {
    tools: { register(tool) { registered.push(tool) } },
    logger: { info(msg) { logs.push(msg) } },
  }
  const savedEnv = process.env.HHXG_MCP_TOKEN
  delete process.env.HHXG_MCP_TOKEN
  const origFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    throw new Error('must not fetch')
  }
  try {
    plugin.apply(ctx, { mcpToken: '' })
    assert.equal(registered.length, 13)
    assert.deepEqual(registered.map((t) => t.name).sort(), TOOLS.map((t) => t.name).sort())
    assert.match(logs.at(-1), /^\[hhxg-market\] 已注册 13 个工具（token 来源：未配置/)
    for (const tool of registered) {
      // defineTool 的 execute 先按 schema 校验参数：传各工具的合法参数，证明是 token 先拦住
      const out = await tool.execute(VALID_ARGS[tool.name] ?? {}, {})
      assert.equal(out, tokenRequiredMessage(tool.name), tool.name)
      assert.equal(typeof tool.output?.render, 'function', `${tool.name} 要有文本渲染`)
    }
    assert.equal(calls, 0, '没 token 不得发任何请求')
    // hhxg_realtime 带桌面卡投影，其余没有
    assert.equal(typeof registered.find((t) => t.name === 'hhxg_realtime').output.presentationMeta, 'function')
    assert.equal(registered.find((t) => t.name === 'hhxg_snapshot').output.presentationMeta, undefined)
    // 配置项只剩 mcpToken（enableVipTools 已删）
    const cfg = new plugin.Config({})
    assert.deepEqual(Object.keys(cfg), ['mcpToken'])
    assert.equal(cfg.mcpToken, '')
    // schema 只声明 mcpToken（enableVipTools 已删；schemastery 对未声明键只是透传，旧 profile 残留不影响装载）
    assert.deepEqual(Object.keys(plugin.Config.dict), ['mcpToken'])
    assert.doesNotThrow(() => new plugin.Config({ enableVipTools: false }))
    // 有 token 时日志只记来源，不记值
    plugin.apply({ tools: { register() {} }, logger: { info(msg) { logs.push(msg) } } }, { mcpToken: 'secret_token_value_123' })
    assert.match(logs.at(-1), /token 来源：配置）$/)
    assert.ok(!logs.join('\n').includes('secret_token_value_123'))
  } finally {
    globalThis.fetch = origFetch
    if (savedEnv !== undefined) process.env.HHXG_MCP_TOKEN = savedEnv
  }
})
