/**
 * 契约测试：所有工具 spec 必须能通过真实 defineTool 编译。
 *
 * 背景（2026-08-28 审查 CRITICAL）：defineTool 对 schema 是硬校验，
 * 任一 spec 非法会在 apply() 内同步 throw，cordis 随即回滚整个插件的
 * 全部注册——一个字段笔误 = 用户装上后 0 个工具。此测试是唯一防线。
 *
 * 依赖本机安装的 dsh SDK（~/.dsh/profiles/node_modules）；未安装时跳过
 * （CI 无 SDK 环境下由 npm 安装的 devDependencies 补位，或显式跳过）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { FREE_TOOLS, VIP_TOOLS } from '../lib/tools.js'

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

const defineTool = await loadDefineTool()
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
}

test('全部 11 个工具 spec 通过真实 defineTool 编译', { skip: !defineTool && '本机无 dsh SDK' }, () => {
  const specs = [...FREE_TOOLS, ...VIP_TOOLS]
  assert.equal(specs.length, 11)
  for (const spec of specs) {
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
