/** Copy owned by the independent Automations page. */
export const automationEn = {
  title: 'Automations', intro: 'Saved Flows, on your schedule. Runs continue while this page is closed.',
  create: 'New automation', edit: 'Edit automation', refresh: 'Refresh', run: 'Run now', pause: 'Pause', enable: 'Enable', delete: 'Delete automation',
  confirmDelete: 'Delete this automation? Existing runs will remain.', close: 'Close', save: 'Save automation',
  name: 'Name', flow: 'Flow', inputs: 'Inputs (JSON)', schedule: 'Schedule', cron: 'Cron (five fields)', timezone: 'Time zone', enabled: 'Enabled',
  manual: 'Manual', on: 'On', paused: 'Paused', daily: 'daily {time}', cronRule: '{expr} · {tz}',
  outcomes: 'Outcomes', duration: 'Duration per run', grid: 'Where runs stop', runColumn: 'Run', gridHint: 'Newest first · rows are runs, columns are blocks',
  median: 'Median {seconds}s', seconds: '{value}s', oldest: 'Oldest', latest: 'Latest',
  successCount: '{ok} of {total} succeeded', stop: '{count} failed runs stopped at {block}. Check that block’s brief or model first.', noStops: 'No failed runs stopped at a block in this window.',
  noRuns: 'Never run', empty: 'No automations yet. Choose a saved Flow to get started.', missingFlow: 'Flow unavailable',
  failedLoad: 'Could not load automations. Retry with Refresh.', failedSave: 'Could not save. Check the Flow, inputs, cron expression and time zone.',
  invalidInputs: 'Inputs must be a JSON object with string, number or boolean values.',
  loading: 'Loading automations', saved: 'Automation saved.', deleted: 'Automation deleted.', updated: 'Automation updated.',
  started: 'Run started.', skippedRun: 'Skipped: the previous run is still active.', failedRun: 'Run could not start. Check the saved Flow and its inputs.', failedAction: 'Could not complete the action.',
  pending: 'Awaiting admission', preflight: 'Preflight', checking: 'Checking readiness…', failedPreflight: 'Could not check readiness. Retry with Refresh.',
  queued: 'Queued', running: 'Running', 'needs-you': 'Needs you', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped', unreached: 'Not reached', recovered: 'Recovered in a later round',
  cell: '{block}: {state}', runLabel: '{at} · {state}', chartLabel: 'Duration per run in seconds',
} as const
/** Typed dictionary keys. */
export type AutomationKey = keyof typeof automationEn
/** Chinese dictionary shares the exact English key inventory. */
export const automationZh: Record<AutomationKey, string> = {
  title: '自动化', intro: '按计划运行已保存的流程。关闭页面后运行仍会继续。',
  create: '新建自动化', edit: '编辑自动化', refresh: '刷新', run: '立即运行', pause: '暂停', enable: '启用', delete: '删除自动化',
  confirmDelete: '删除此自动化？现有运行将保留。', close: '关闭', save: '保存自动化',
  name: '名称', flow: '流程', inputs: '输入（JSON）', schedule: '计划', cron: 'Cron（五个字段）', timezone: '时区', enabled: '启用',
  manual: '手动', on: '已启用', paused: '已暂停', daily: '每天 {time}', cronRule: '{expr} · {tz}',
  outcomes: '运行结果', duration: '每次运行时长', grid: '运行停止位置', runColumn: '运行', gridHint: '最新在前 · 行为运行，列为区块',
  median: '中位数 {seconds} 秒', seconds: '{value} 秒', oldest: '最早', latest: '最新',
  successCount: '{ok} 次成功，共 {total} 次', stop: '{count} 次失败运行停止于 {block}。请先检查该区块的任务说明或模型。', noStops: '此范围内没有停止于区块的失败运行。',
  noRuns: '尚未运行', empty: '尚无自动化。请选择已保存的流程开始。', missingFlow: '流程不可用',
  failedLoad: '无法加载自动化，请刷新重试', failedSave: '无法保存，请检查流程、输入、Cron 表达式和时区', invalidInputs: '输入必须为 JSON 对象，值为字符串、数字或布尔值',
  loading: '正在加载自动化', saved: '自动化已保存', deleted: '自动化已删除', updated: '自动化已更新',
  started: '运行已开始', skippedRun: '已跳过：上一次运行仍在进行', failedRun: '无法开始运行，请检查已保存的流程及输入', failedAction: '无法完成操作',
  pending: '等待准入', preflight: '运行前检查', checking: '正在检查就绪状态…', failedPreflight: '无法检查就绪状态，请刷新重试',
  queued: '排队中', running: '运行中', 'needs-you': '等待审批', succeeded: '成功', failed: '失败', cancelled: '已取消', skipped: '已跳过', unreached: '未到达', recovered: '后续轮次已恢复',
  cell: '{block}：{state}', runLabel: '{at} · {state}', chartLabel: '每次运行时长（秒）',
}
