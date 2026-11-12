# Agent Note: composer 通过保存的发送手势发送草稿

Status: implemented

[English](2026-11-12-composer-send-gesture.md) | 中文

## 问题

普通 Enter 会发送 composer 草稿，因此多行消息需要在每一行前按 Shift+Enter，误按 Enter 会发出未写完的消息。发送属于每个用户的习惯而不是产品规则：写长提示词的人希望 Enter 换行、用明确的组合键发送。已有的 `busyEnter` 偏好只选择排队或插话投递，不决定哪个键发送。

## 决策

`ui-conversation` 保存 `sendGesture` 偏好，有两个取值，默认 `chord`：

- `chord` 在 macOS 上用 Cmd+Alt+Enter、其他平台用 Ctrl+Alt+Enter 发送。未加修饰的 Enter 与 Shift+Enter 插入换行。
- `enter` 保持旧手势：未加修饰的 Enter 发送，Shift+Enter 换行。

严格的 Cmd+Enter 或 Ctrl+Enter 在两种手势下含义不变：互补的排队／插话投递，以及空草稿时发送整个队列。composer 键盘映射在两个发送组合键上都先于菜单裁决判定，因此即使触发菜单打开，发送组合键也会直接投递；未加修饰的 Enter 仍会选中高亮的补全项，没有高亮则交给编辑器的换行。发送组合键的 Shift 形式、各类 Alt 组合、AltGraph，以及同时按下 Ctrl 与 Cmd，仍不进入草稿而留给应用快捷键，与之前一致。

该组合键存在一个归属冲突：`pane.fullscreen.toggle` 原本使用 Mod+Alt+Enter，而固定快捷键条目会向可编辑命令保留其组合，从而使面板命令失效。面板全屏的默认键位移到 Mod+Shift+Backslash，与 Mod+Backslash 的分栏成对，Enter 组合键归 composer 所有。

通用设置新增一行，经同一个 `ComposerSubmissionPolicy` store 选择该手势；发送与换行两个固定快捷键条目在偏好变化时重新注册。

## 考虑过的替代方案

**让发送组合键只留在 composer 内，不注册固定快捷键条目。** 否决：快捷键速查就不会列出如何发送，而面板全屏条目会占用同一组合。

**把发送组合键移到别处。** 否决：所要求的组合键就是这个功能本身。

**为互补投递换用新的组合键（Shift+Ctrl+Alt+Enter）。** 否决：Cmd/Ctrl+Enter 保留其既有含义，Shift 继续留给换行。

**保留 Enter 发送为默认，把组合键作为可选项。** 否决：组合键就是所要求的默认值。

## 后果

默认行为对所有 profile 改变：Enter 与 Shift+Enter 不再发送，发送手势在设置中选择。面板全屏快捷键在所有原本拥有它的 profile 上移动。浏览器场景改用组合键发送，而 composer 组件测试显式选择 Enter 手势，使两种模式都保持覆盖。

## 相关决策

[快捷键偏好按设备保存，提交后才激活](../architecture/2026-09-20-device-local-shortcut-preferences.zh.md) 拥有固定条目所遵循的注册与保留规则；[已认领命令作为输入框原子 chip](../architecture/2026-10-09-composer-command-chip.zh.md) 拥有发送组合键现在前置的菜单裁决。
