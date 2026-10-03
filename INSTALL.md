# 安装 Dynamic Island（灵动岛）

一个贴在桌面顶部中央的任务胶囊：显示 DSH 里正在跑的 / 等你的 / 刚完成的会话，鼠标移上去展开细节，
点击任务跳到对应会话，右侧 × 把它从岛上移除。

## 需要什么

| 项目 | 要求 |
| --- | --- |
| 系统 | Windows 10 / 11（悬浮窗是 .NET Framework 4.8 的 WPF 程序，系统自带） |
| DSH | 0.2.x 桌面版（需要 `%USERPROFILE%\.dsh` 里的 desktop profile） |
| PowerShell | Windows 自带的 5.1 即可 |
| 编译 | **不需要**：`overlay\DynamicIsland.exe` 已经打包好了（想自己改再编译见下文） |

## 安装（三步）

1. **解压**到一个固定位置，例如 `C:\Tools\dsh-plugin-dynamic-island`。
   路径可以带空格，但请**不要放在临时目录**里（每次开机自动启动会用到这个路径）。
2. **安装插件行 + 启动悬浮窗**：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
   ```

   它会做三件事：把一行 Loader 记录写进 profile 的 `cordis.patch.yml`（写入前自动备份）、
   启动桌面悬浮窗、并打印备份路径。

   想让它在开机时自动启动：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -AutoStart
   ```

3. **刷新 Harness 页面**（或重启 DSH）。宿主半边与客户端半边这时才加载。

装好后，桌面顶部中央会出现一块黑色小胶囊。没有任务时它就保持这个样子（纯黑块，不带文字）；有任务时立刻显示任务内容。打开 DSH 时插件会自动把悬浮窗拉起来，不需要手动启动。

## 怎么用

| 操作 | 效果 |
| --- | --- |
| 鼠标移到胶囊上 | 展开任务卡片 |
| 鼠标在某个任务上停约 1 秒 | 在该任务下方展开**它自己的**上下文用量（快速划过不会闪出来） |
| 点击某条任务 | DSH 窗口跳到最前并切到该会话（窗口被最小化时会先恢复） |
| 点任务右侧的 × | 把这条任务从岛上移除；它重新开始一轮或有新的待处理交互时会再出现 |
| 看到「请求详情」卡 | 只是**告诉你**有东西在等批准；批准/拒绝请回 DSH 窗口操作，岛上没有应答按钮 |
| Ctrl + 滚轮 | 调整岛的大小（会记住，存在 `overlay\island.settings.json`） |
| Esc | 收起卡片 |

完成的任务会在岛上保留 30 分钟（页面每小时序最多保留 6 条），方便你回看和手动清理。

## 卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
```

它会删掉 profile 里的那一行（同样先备份）、停掉悬浮窗、并移除开机启动项。之后再刷新一次页面即可。

## 出问题了？

| 现象 | 先看这里 |
| --- | --- |
| 完全没有胶囊 | `overlay\island.state.txt`：`win32Visible` 应为 `True`；再看 `overlay\island.log` |
| 有胶囊但没有任务 | 页面是否在推送：`curl http://127.0.0.1:19392/island`（`source=page`、`age` 很小） |
| 点击不跳转 | `overlay\island.log` 里应出现 `queued focus for <会话 id>` 与 `focus window: 0x… foreground=True` |
| 装完没生效 | 刷新页面；仍不行就重启 DSH（宿主半边要重启才加载） |
| 端口被占 | 悬浮窗会自动从 19391 往后试 5 个端口；页面按 `/health` 里的 `overlay` 标记自动找 |

日志与状态文件都在 `overlay\` 下，默认只追加、体积很小。

## 想自己改 / 重新编译悬浮窗

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\overlay\build.ps1     # 需要 VS 2022 的 Roslyn csc
```

改完先跑验证（183 项断言，含真实窗口的 Win32 断言）：

```powershell
node dev\component-test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File .\overlay\overlay-live-test.ps1
```

重新打包：`powershell -NoProfile -ExecutionPolicy Bypass -File .\dev\pack.ps1`
（它会把成品放到 `dist\`，并且**从复制出来的副本**里再验一遍：脚本能解析、exe 能跑、dev 测试全过。）

架构、每个功能的实现细节与踩过的坑都写在 `README.md`。
