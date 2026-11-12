---
kind: upgrade-guide
description: "The composer sends on Cmd/Ctrl+Alt+Enter by default and the panel fullscreen shortcut moves to Cmd/Ctrl+Shift+Backslash."
---

# 输入框默认使用 Cmd/Ctrl+Alt+Enter 发送

[English](guide.md) | 中文

## 变更

Web 与桌面端的 composer 原先用普通 Enter 发送，Shift+Enter 换行。现在它遵循 `ui-conversation` 设置文档中的 `sendGesture` 字段，默认值为 `chord`：macOS 上用 Cmd+Alt+Enter、其他平台用 Ctrl+Alt+Enter 发送草稿，Enter 与 Shift+Enter 插入换行。`enter` 恢复旧手势。两种模式下 Cmd/Ctrl+Enter 都保留互补的排队／插话投递，空草稿时发送整个队列的行为不变。

同一组合键原先用于切换右侧面板全屏。由于 composer 现在拥有它，`pane.fullscreen.toggle` 默认改为 Cmd/Ctrl+Shift+Backslash，与 Cmd/Ctrl+Backslash 的分栏成对。

在 composer 中输入、使用面板全屏快捷键，或用自动化驱动 composer 的人都会观察到这些变化。

## 迁移

1. 继续保持用 Enter 发送：在 **设置 → 通用 → 发送方式** 中选择 **Enter 发送**，或在 profile patch 文件的 `ui-conversation` 条目 `config` 中设置 `sendGesture: enter`。
2. 改用 Cmd/Ctrl+Alt+Enter 发送，或连按两次 Enter 分段；草稿内容不受影响。
3. 把文档或自动化中的面板全屏快捷键替换为 Cmd/Ctrl+Shift+Backslash，或在 **设置 → 快捷键** 中重新绑定 `pane.fullscreen.toggle`。
4. 确认输入的草稿在按 Enter 后仍然保留、Cmd/Ctrl+Alt+Enter 能将其发送，并且面板全屏控件显示新的键位。
