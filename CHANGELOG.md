# Changelog

## 0.2.2 (2026-08-29)

- **修复**：MCP 上游返回 429/5xx 等非 2xx HTTP 状态时不再把空 JSON 误判成成功结果，统一返回带状态码且已脱敏的错误。
- **修复**：User-Agent 自动读取 package version，免费工具数量日志与未解锁提示统一为 7 个并补上 `hhxg_datasets`。
- **工程化**：新增 package lock、Node 18/20/22 确定性 CI、定时真实端点冒烟和 Dependabot。

## 0.1.0 (2026-08-28)

首个版本。

- 6 个免费工具：`hhxg_snapshot` / `hhxg_news` / `hhxg_margin` / `hhxg_calendar` / `hhxg_sentiment` / `hhxg_themes`，直调 hhxg.top 公开端点，零配置可用。
- 5 个 VIP 工具：`hhxg_diagnose_stock` / `hhxg_strategy_signals` / `hhxg_predict_lianban` / `hhxg_stock_alerts` / `hhxg_query_dataset`，经 JSON-RPC 桥接 hhxg MCP server（`mcpToken` 配置解锁）。
- 未配置 Token 时 VIP 工具注册为引导占位；`enableVipTools: false` 可关闭。
- 纯 ESM JavaScript，免构建；`node --test` 测试套件（真实端点冒烟 + 纯逻辑单测）。

## 0.2.0 (2026-08-28)

真机（dsh v0.1.1-rc.1 web profile）实测后的修复与增强。

- **修复**：MCP 业务性「无数据」响应（`NO_DATA` / `NOT_FOUND` / `UNSUPPORTED_FORMAT` / `UNSUPPORTED_ASSET` / `INVALID_ARGUMENT`）不再当作工具故障抛出，改为返回可读文本——此前"这只票今天没涨停"会被模型误判成工具坏了。
- **修复**：上游错误不再以裸 JSON 透给模型，统一渲染为「无结果：<原因>（<代码>）」。
- **新增** `hhxg_datasets`（免费）：列出全部 46 个开放数据集的 id / 分类 / 格式 / 更新频率，并标注哪些可用 `hhxg_query_dataset` 查询（仅 JSON 类，34 个）——补上了 `dataset_id` 此前缺失的发现路径。
- 免费工具 6 → 7 个。

## 0.2.1 (2026-08-28)

- **修复**：公开端点遇 5xx（真机实测 EdgeOne CDN 偶发 545 CPU 超限击杀）与网络抖动时自动重试一次（800ms 退避），此前一次抖动即整个工具调用失败。4xx 与用户取消不重试。
