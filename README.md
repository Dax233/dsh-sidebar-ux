# dsh-sidebar-ux

DeepSeek Harness（DSH）Web 客户端侧边栏的轻量增强插件：**右键开菜单**、**拖拽会话插入引用**、**工作区菜单里打开资源管理器**。

纯浏览器侧实现（Host 半区是空 `apply`），不替换、不重注册任何官方槽位，不改宿主源码。

## 功能

### 1. 右键会话行 → 官方「…」菜单

右键侧边栏任意会话行，等价于左键点该行的 `…`：置顶 / 重命名 / 分叉 / 归档 / 复制 Session ID 全部沿用宿主菜单，插件不复制一份菜单，也不会与宿主版本漂移。

干净「新会话」行没有 `…` 触发器，右键不做任何事（与宿主一致）。

### 2. 右键工作区行 → 官方菜单 +「在文件资源管理器中打开」

右键工作区行打开宿主自己的「重命名 / 删除工作区」菜单，并在「删除工作区」之前追加一行 **在文件资源管理器中打开**。点击后通过宿主 `session.openWorkspacePath` Remote 打开该工作区目录（路径由 Host 组合文件系统校验后交给桌面端默认处理程序）。

工作区行菜单在 DSH 0.2.1-rc.3 没有客户端槽位（只有会话行菜单有 `sidebar.workspaces.session.menu.item`），因此新增行是从当前打开的菜单里**克隆**官方菜单行的 DOM，再换文案、图标和点击处理器——样式、材质、主题、键盘行为仍由宿主菜单负责。菜单打开期间若 React 重渲染，`MutationObserver` 会把这一行补回；菜单关闭或插件卸载时自动清理。

### 3. 拖拽会话行到输入框 → 插入会话引用 chip

按住侧边栏任意会话行，拖到右侧输入框（composer）松开：插入的是**真正的会话引用 chip**，走与输入框里 `@` 选择会话完全相同的通道（`conversation.input.for(actx).insertReference(reference, span)`），不是一段裸文本。

模型/剪贴板形态是宿主规范的 `@[标题](dsh-session:<base64url(id)>)` mention，发送后由宿主 session-reference 服务校验并准备上下文。拖拽当前正在看的会话到自己 → 只在输入框提示「当前会话不需要引用自己」。拖回侧边栏不拦截，官方行内排序原样保留。

## 与已有插件的关系（调研结论）

先检索了社区已有方案（详见本地 `research/sidebar-ux-survey.md`）：

| 需求 | 最接近的已有插件 | 结论 |
| --- | --- | --- |
| 会话行右键开菜单 | `cannebergeee/dsh-session-folder`（BSD-3）、`afterrealism/dsh-session-ctxmenu`（MIT） | 已有实现，但会话右键之外的形态不同 |
| 拖拽会话进输入框插引用 | `ttmouse/dsh-drag`（MIT） | 已完整覆盖该单点，机制被本插件沿用 |
| 工作区行右键开菜单 | 无（社区插件多为右键直接打开目录/自绘菜单） | 需要自行接线 |
| 工作区菜单内「打开资源管理器」 | 无（0.2.1-rc.3 无工作区菜单槽位） | 需要自行接线 |

**没有任何一个已有插件同时满足四项**：`dsh-session-folder` 把「打开目录」放在会话菜单并把工作区右键直接做成打开目录（没有工作区菜单）；`dsh-drag` 只做拖拽；`@qzsy/dsh-workspace-context-menu` 是自绘整份工作区菜单、与「沿用官方菜单」冲突。把 2–3 个插件组合安装会互相抢 `contextmenu`、且菜单形态不一致。

因此本插件只在**缺的那一层**写代码，并复用经过验证的机制：

- 会话/工作区右键：捕获阶段 `contextmenu` → 命中 `[data-row-key]` → 点该行自己的 `…` 触发器（`dsh-session-folder` 的 BSD-3 机制）；
- 拖拽插入：`dragstart` 读取宿主行已有 payload → 捕获阶段 `dragover`/`drop` → `conversation.input.for(actx).insertReference` + `caretSpan()`/`snapshot.draftRev` span CAS（`dsh-drag` 的 MIT 机制与 API 契约）；
- 本插件新增：工作区菜单行注入、工作区目录的 `session.openWorkspacePath` 交接。

## 安装

本仓库即可运行的 bundle（无构建步骤，`node --check` 校验）。

```powershell
# 装进当前 profile（示例为桌面端）
dsh plugin --profile desktop add file:F:/github/dsh-sidebar-ux
# 然后重启 DSH Desktop（客户端 bundle 在启动时扫描进 boot 清单）
```

或在 DSH「设置 → 插件」里安装该目录的绝对路径，重启后生效。卸载：

```powershell
dsh plugin --profile desktop remove @local/dsh-sidebar-ux
```

## 兼容性

- DSH `0.2.1-rc.3`（桌面端，Windows 实测）；依赖以下宿主契约：
  - 行标记 `[data-row-key="session:<id>"]` / `[data-row-key="workspace:<id>"]` 与行内 `…` 触发按钮；
  - `ctx.sessions`（`list` 快照、`scope(id)`）、`ctx.conversation.input.for(actx)`（`caretSpan` / `snapshot.draftRev` / `insertReference` / `notify`）；
  - `ctx.workspaces.list` 快照的 `workspaceId` / `path`；
  - `ctx.remote.session.openWorkspacePath` / `canOpenWorkspacePath`。
- 纯远程/无桌面的 Web 部署：打开目录会失败并给出输入框提示（其余功能正常）。
- 空白「新会话」行没有 `…` 触发器，不参与右键；官方拖拽排序不受影响。

## 已知限制

- 右键弹出的菜单锚定在 `…` 按钮处而不是鼠标坐标（宿主 `Menu` 只支持 anchor 定位）。
- 工作区菜单行的实现依赖宿主菜单 DOM 的克隆安装；宿主若大改菜单结构，该项会静默不出现（不影响其余功能）。升级 DSH 后请复核这一条。
- 会话标题在拖拽开始时取自会话列表快照的 `displayTitle`/`title`；重命名后下一次拖拽即使用新标题。

## 开发与验证

```powershell
node --check client.js
node --check index.js
node --test tests/sidebar-ux.test.mjs
```

已在隔离的真实 DSH Web 实例（同版本 `0.2.1-rc.3`，独立 `DSH_HOME` + 真实浏览器）中逐项验证：

1. 右键会话行 → 菜单项为「置顶会话 / 重命名 / 分叉会话 / 归档会话 / 复制 Session ID」；
2. 右键工作区行 → 菜单为「重命名 / **在文件资源管理器中打开** / 删除工作区」，点击后 Host 返回 `{"opened":true}` 且菜单关闭；
3. 把**另一个**会话拖到输入框 → `[data-composer-chip="reference"]` 出现，label/title 正确；拖当前会话 → 不插 chip、给出提示。

## License

MIT。前作机制（`dsh-session-folder` BSD-3、`dsh-drag` MIT）仅作技术参考与 API 契约核对，代码为本仓库重新实现；如需逐段复用请遵循其许可证并注明来源。
