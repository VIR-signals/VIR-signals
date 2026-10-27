# 语音包制作指南

[English](voice-pack-authoring.md) | [简体中文](voice-pack-authoring.zh-CN.md)

语音包是包含清单文件（`manifest.json`）及其引用的音频资源的目录。扩展会加载语音包目录中所有合法的包目录；该目录由「VIR: 打开语音包文件夹」命令创建。本文档按扩展的实际校验规则描述包格式。

扩展自带的 `demo` 包是一个最小可用参考：一份完整清单，覆盖两个槽位。

## 包目录结构

```
my-pack/
  manifest.json
  sounds/
    error.wav
    save.mp3
    ...
```

- 音频资源须为 WAV 或 MP3 格式；扩展按文件内容（魔数）识别格式，不依据扩展名。
- 清单中的路径一律相对于包目录，且仅使用正斜杠（`sounds/error.wav`）。
- 包不要求覆盖全部槽位；未覆盖的槽位保留编辑器官方音效。

## 清单字段

| 字段 | 必填 | 规格说明 |
|---|---|---|
| `schema` | 是 | 固定为 `1`。更大的值以「schema 版本更新」提示拒绝。 |
| `id` | 是 | 包标识。在语音包目录内必须唯一；两个目录声明相同 id 时，排序靠后的目录被拒绝。 |
| `name` | 是 | 选择列表中显示的包名。 |
| `version` | 是 | 三段以点分隔的数字，例如 `1.0.0`。 |
| `author` | 否 | 索引条目在选择列表详情行中显示的作者。 |
| `license` | 是 | 包本身的许可，例如 `CC0-1.0` 或 `MIT`。 |
| `sourceLicense` | 是 | 音频来源。仅可取：`original`、`game-asset`、`third-party-cc0`、`unknown`。 |
| `language` | 否 | 自由标签，如 `zh`、`en`；缺省为 `none`。 |
| `categories` | 否 | 自由字符串数组，显示于选择列表。 |
| `slots` | 是 | 对象：槽位名 → 音频文件路径。至少一条。 |

清单级违规将拒绝整个包。仅涉及单个音频文件的缺陷只禁用对应槽位，其余槽位保持可用，具体原因由「VIR: 重新扫描语音包」报告。

### 示例

扩展自带 demo 包的清单：

```json
{
  "schema": 1,
  "id": "demo",
  "name": "Demo save+err",
  "version": "1.0.0",
  "author": "VIR Signals",
  "license": "CC0-1.0",
  "sourceLicense": "third-party-cc0",
  "slots": {
    "error": "sounds/error_004.wav",
    "save": "sounds/confirmation_002.wav"
  }
}
```

该包覆盖两个槽位，其余二十六个槽位保留官方音效。demo 包附有 `SOURCE.txt` 文件，记录其音频来源；包含第三方音频的包建议以同样方式注明出处。

## 槽位

槽位对应编辑器的一个音效位置，槽位名与该位置官方媒体文件的基本名一致。经编辑器 1.143.1 核实的音效组共 28 个槽位：

| 槽位 | 触发场景 |
|---|---|
| `error` | 错误行、错误位置或终端命令失败 |
| `warning` | 警告行或警告位置 |
| `break` | 断点行提示或调试暂停命中 |
| `quickFixes` | 行内建议或终端快速修复 |
| `taskCompleted` | 后台任务完成（含笔记本单元格） |
| `taskFailed` | 后台任务失败（含笔记本单元格） |
| `voiceRecordingStarted` | 语音记录开始或语音模式开启 |
| `voiceRecordingStopped` | 语音记录结束或语音模式关闭 |
| `save` | 文件保存成功 |
| `format` | 文档格式化完成 |
| `clear` | 终端清屏 |
| `progress` | 长任务进行中 |
| `foldedAreas` | 光标跳到折叠区域 |
| `confetti` | 撒花庆祝动画 |
| `terminalBell` | 终端响铃 |
| `terminalCommandSucceeded` | 终端命令成功 |
| `diffLineInserted` | 差异视图：新增行 |
| `diffLineModified` | 差异视图：修改行 |
| `diffLineDeleted` | 差异视图：删除行 |
| `chatEditModifiedFile` | 聊天修改了文件 |
| `chatUserActionRequired` | 聊天等待用户操作 |
| `codeActionTriggered` | 代码操作被触发 |
| `codeActionApplied` | 代码操作已应用 |
| `editsKept` | 聊天编辑被保留 |
| `editsUndone` | 聊天编辑被撤销 |
| `nextEditSuggestion` | 下一步编辑建议 |
| `requestSent` | 聊天请求已发出 |
| `responseReceived` | 聊天回复到达 |

表外的槽位名在清单层即被拒绝。编辑器安装目录中的官方媒体文件缺失或改名时，替换阶段会报告相应情况，受影响槽位保留官方音效。

### 聊天回复槽位

编辑器为聊天回复音效提供四个媒体文件，每次事件触发时随机选取其一。清单必须且只能以下列两种形式之一指定；两种形式在同一份清单中同时出现将被拒绝：

- `"responseReceived": "sounds/reply.mp3"` —— 单个文件替换全部四个位置。
- `"responseReceived1"` 至 `"responseReceived4"` —— 四条独立条目，与四个位置一一对应。

## 音频校验

| 检查项 | 限制 | 不通过时 |
|---|---|---|
| 格式 | 按魔数识别的 WAV 或 MP3 | 该槽位禁用，并报告原因。 |
| 文件大小 | 20 MB 硬性上限 | 该槽位禁用，并报告原因。 |
| 时长 | 软性上限 2 秒（`progress` 为 1 秒） | 仅产生警告；槽位保持可装载、可播放。 |

「VIR: 识别音效」命令会应用校准包并输出一张工作表，列出全部槽位及其触发点与设置键，用于按听感确定声音与槽位的对应关系。

## 经索引仓发布

语音包通过索引仓库分发。索引仓仅存储条目；音频资源始终保存在包作者本人的 Git 仓库中，所有下载均固定到确切的提交，因此用户获得的内容与作者发布的内容逐字节一致。

索引条目包含以下字段：`id`、`names`（按语言的显示名）、`categories`、`language`、`author`、`version`、`repo`（`owner/repo` 形式）、`branch`、`commit`、`packPath`（仓库中包含 `manifest.json` 的目录）、`license`、`sourceLicense`。选择列表将条目 `version` 与本地已安装副本比对，存在新版本时以升级箭头标记。

索引仓的变更一律通过该仓库的 pull request 流程提交，不接受直接推送。
