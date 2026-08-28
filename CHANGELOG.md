# Changelog

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
