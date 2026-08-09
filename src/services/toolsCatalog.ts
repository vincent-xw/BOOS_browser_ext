/**
 * 工具能力说明目录。
 *
 * 供「自由指令」面板的 `?` 图标展示，让用户知道自己的指令能触发什么操作。
 *
 * 注意：工具的实际定义在 BFF 侧 `agent-kit/examples/browser-extension-bff/src/browser-tools.ts`。
 * 这里是面向用户的中文说明副本，两边需保持同步 -- 工具集变动频率极低，
 * 但新增或重命名工具时务必同时更新这里。
 */

export interface ToolDescription {
  /** 工具名，与 BFF 侧一致。 */
  name: string;
  /** 面向用户的中文标题。 */
  title: string;
  /** 中文说明：做什么、何时会被调用、用户怎么触发它。 */
  description: string;
  /** 分类：读还是写。写操作需要审批。 */
  category: 'read' | 'write';
}

export const TOOLS_CATALOG: readonly ToolDescription[] = [
  {
    name: 'browser_snapshot',
    title: '页面快照',
    description: '列出当前页面上所有可交互元素（按钮、链接、输入框等），每个元素带一个编号。模型用编号指定操作目标，不需要你写选择器。这是所有操作的第一步。',
    category: 'read',
  },
  {
    name: 'browser_read_page',
    title: '读取页面',
    description: '读取当前页面的标题、网址和正文摘要。当你想让模型了解页面整体内容时会被调用。',
    category: 'read',
  },
  {
    name: 'browser_locate_element',
    title: '定位元素',
    description: '按编号或 CSS 选择器找到某个元素，返回它的坐标和是否可点击。通常在快照之后、点击之前调用。',
    category: 'read',
  },
  {
    name: 'browser_click',
    title: '点击',
    description: '在指定位置执行真实点击。这是写操作，需要你批准。模型会先快照拿到元素编号，再用编号点击。',
    category: 'write',
  },
  {
    name: 'browser_input_text',
    title: '输入文本',
    description: '在输入框中写入文字（支持中文）。会先点击输入框获取焦点，再写入。这是写操作，需要你批准。',
    category: 'write',
  },
  {
    name: 'browser_press_key',
    title: '按键',
    description: '按下键盘按键，如回车、Tab、Esc 等。常用于提交表单或关闭弹窗。这是写操作，需要你批准。',
    category: 'write',
  },
  {
    name: 'browser_scroll',
    title: '滚动',
    description: '上下滚动页面。滚动后之前的元素编号会失效，模型会重新快照。这是写操作，需要你批准。',
    category: 'write',
  },
  {
    name: 'browser_verify',
    title: '验证',
    description: '检查上一步操作是否真的生效，例如弹窗是否出现、输入框内容是否更新、请求是否发出。模型不会只靠「点击没报错」就认为成功。',
    category: 'read',
  },
  {
    name: 'browser_screenshot',
    title: '截图',
    description: '截取当前屏幕。当模型反复定位失败时用来观察页面实际状态。',
    category: 'read',
  },
  {
    name: 'browser_go_back',
    title: '返回上一页',
    description: '浏览器返回。当点击链接把你带到非预期页面（例如下载跳到外部站点）时，用它回到原页面继续任务。这是写操作，需要批准。',
    category: 'write',
  },
  {
    name: 'browser_save_file',
    title: '生成文件',
    description: '把收集到的数据生成 txt/csv/xlsx/json 文件。文件生成后会在对话区域出现下载按钮，用户点击即可下载。这是只读操作，不需要审批。适合汇总数据导出场景。',
    category: 'read',
  },
  {
    name: 'browser_read_file',
    title: '读取文件',
    description: '从持久化存储读取用户上传的文本文件。跨会话可用。适合读取用户提供的 CSV/JSON/TXT 数据进行处理。',
    category: 'read',
  },
  {
    name: 'browser_write_file',
    title: '保存文件',
    description: '将文本内容保存到持久化存储。跨会话可用，下次会话可直接读取。适合保存中间结果、加工后的数据。',
    category: 'read',
  },
];
