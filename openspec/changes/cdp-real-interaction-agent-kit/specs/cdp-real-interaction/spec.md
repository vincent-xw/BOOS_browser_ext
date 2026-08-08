## ADDED Requirements

### Requirement: 系统 SHALL 通过 chrome.debugger 会话执行页面写操作
系统 SHALL 在 Service Worker 中维护 `chrome.debugger` 会话，并且所有页面写操作（点击、文本输入、按键、滚动）MUST 经由 Chrome DevTools Protocol 的 `Input` 域下发。系统 MUST NOT 使用 `element.click()`、`element.dispatchEvent()`、直接赋值 `input.value` 或 `element.textContent` 等 DOM 层合成方式执行写操作，因为这些事件的 `event.isTrusted` 为 `false`，无法触发目标站点依赖的真实焦点、用户激活与输入法逻辑。

#### Scenario: 任务开始时建立调试会话
- **WHEN** 自动化任务启动并指定目标标签页
- **THEN** 系统对该标签页执行 `chrome.debugger.attach({ tabId }, '1.3')`，并在整个任务期间复用这一个会话

#### Scenario: 任务期间不重复 attach/detach
- **WHEN** 同一任务内连续执行多个页面写操作
- **THEN** 系统复用已建立的调试会话下发 CDP 命令，且不在每个操作前后重新 attach 或 detach

#### Scenario: 拒绝合成事件写操作
- **WHEN** 任何代码路径尝试以 DOM 合成事件方式执行页面写操作
- **THEN** 该路径不存在于系统实现中；所有写操作请求都被路由到 CDP 执行器

### Requirement: 系统 SHALL 以三段鼠标事件序列执行真实点击
系统 SHALL 通过依次下发 `Input.dispatchMouseEvent` 的 `mouseMoved`、`mousePressed`、`mouseReleased` 三个事件完成一次点击；`mousePressed` 与 `mouseReleased` MUST 携带 `button: 'left'` 与 `clickCount: 1`。

#### Scenario: 完成一次真实点击
- **WHEN** 系统收到针对坐标 `{ x, y }` 的点击请求
- **THEN** 系统在同一调试会话上按 `mouseMoved` → `mousePressed` → `mouseReleased` 顺序下发三个 CDP 事件，并在全部成功后报告点击已下发

#### Scenario: 中途某个事件失败
- **WHEN** 三段序列中的任一 CDP 命令返回错误
- **THEN** 系统中止该次点击，并返回包含失败阶段与错误原因的结构化失败结果

### Requirement: CDP 坐标 SHALL 使用相对主页面 viewport 的 CSS 像素
系统在下发 `Input` 域事件时，坐标 MUST 是相对主页面 viewport 左上角的 CSS 像素值，并且 MUST NOT 乘以 `devicePixelRatio`。

#### Scenario: 高 DPI 屏幕上的坐标不做缩放
- **WHEN** 在 `devicePixelRatio` 大于 1 的设备上执行点击
- **THEN** 系统下发的坐标与 `getBoundingClientRect()` 得到的 CSS 像素值一致，未做任何 DPR 缩放

#### Scenario: 子 frame 内元素的坐标换算到主页面
- **WHEN** 目标元素位于子 frame 中
- **THEN** 系统将该元素在子 frame 内的坐标换算为相对主页面 viewport 的坐标后再下发

### Requirement: 系统 SHALL 通过 CDP 执行文本输入与按键
系统 SHALL 对普通文本与中文内容优先使用 `Input.insertText`；对 Enter、Tab、Escape、退格及组合快捷键 SHALL 使用 `Input.dispatchKeyEvent`。文本输入前系统 MUST 先通过 CDP 点击目标输入框以建立真实焦点。

#### Scenario: 输入中文内容
- **WHEN** 系统需要向输入框写入中文文本
- **THEN** 系统先通过 CDP 点击该输入框，再调用 `Input.insertText` 写入完整文本

#### Scenario: 触发 Enter 键
- **WHEN** 系统需要按下 Enter 键
- **THEN** 系统通过 `Input.dispatchKeyEvent` 下发对应的 `keyDown` 与 `keyUp` 事件

#### Scenario: 输入框未获得焦点时
- **WHEN** 点击输入框后验证发现焦点未落在该元素上
- **THEN** 系统返回失败结果而不继续写入文本

### Requirement: 系统 SHALL 管理调试会话的完整生命周期并处理断连
系统 SHALL 在任务正常完成、任务异常终止、目标标签页关闭以及用户主动停止这四种情况下执行 `chrome.debugger.detach`。系统 MUST 监听 `chrome.debugger.onDetach`，并对用户关闭调试横幅、用户为当前标签页打开 DevTools、标签页被关闭这三类断连给出可读的用户提示。

#### Scenario: 任务正常结束后释放会话
- **WHEN** 自动化任务全部步骤执行完毕
- **THEN** 系统 detach 调试会话，且目标标签页的调试横幅消失

#### Scenario: 任务抛出异常
- **WHEN** 任务执行中出现未捕获异常
- **THEN** 系统仍然 detach 调试会话，并向 UI 报告失败原因

#### Scenario: 用户手动关闭调试横幅
- **WHEN** 用户点击标签页顶部调试提示的关闭按钮，触发 `onDetach`
- **THEN** 系统中止当前任务，将状态置为失败，并提示用户调试连接已被手动断开

#### Scenario: 用户打开 DevTools 抢占连接
- **WHEN** 用户为正在被自动化的标签页打开 DevTools，导致调试会话被抢占
- **THEN** 系统中止当前任务并提示用户关闭 DevTools 后重试

#### Scenario: 标签页在任务中被关闭
- **WHEN** 目标标签页在任务执行期间被关闭
- **THEN** 系统清理会话状态，不再向该标签页下发命令，并将任务标记为失败

### Requirement: 系统 SHALL 通过 CDP Network 域观测请求结果
系统 SHALL 使用 CDP `Network` 域事件观测页面请求的发出与响应，用于验证写操作的真实副作用。系统 MUST NOT 通过在页面上下文中改写 `window.fetch` 或 `XMLHttpRequest.prototype` 的方式做请求观测。

#### Scenario: 记录写操作触发的请求
- **WHEN** 系统执行一次点击并开启了 Network 观测
- **THEN** 系统记录该动作时间窗内匹配的请求 URL、方法与响应状态码

#### Scenario: 预期请求未发出
- **WHEN** 点击完成后在约定的等待窗口内未观测到任何匹配的请求
- **THEN** 系统将该步骤判定为验证失败并返回该原因

### Requirement: 单个标签页 SHALL 只允许一个活动调试会话
系统 SHALL 保证同一时刻对同一标签页最多持有一个调试会话；当已存在活动会话时，新的任务请求 MUST 被拒绝或排队，而不是重复 attach。

#### Scenario: 重复启动任务
- **WHEN** 用户在任务运行中再次对同一标签页启动任务
- **THEN** 系统拒绝新请求并提示已有任务正在运行

#### Scenario: attach 因已有调试客户端而失败
- **WHEN** `chrome.debugger.attach` 因该标签页已被其他调试客户端占用而失败
- **THEN** 系统返回可读的失败原因，指明需要先关闭 DevTools 或其他调试工具
