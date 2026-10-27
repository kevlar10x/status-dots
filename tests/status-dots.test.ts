import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const USER_TITLE_REFUSAL =
  "Could not rename this session: its title was set by the user, and replacing it needs their approval, which isn't available in this context."

// The desktop app's view of this session: its title, who set it, and every
// rename; and the other sessions it lists.
type App = {
  title?: string
  source: 'auto' | 'tool' | 'user'
  renames: string[]
  others?: { sessionId: string; title: string }[]
  isMissing?: boolean
}

const text = (value: string, isError = false) => ({ content: [{ type: 'text' as const, text: value }], isError })

// Stands in for the engine and the desktop app's session tools.
function engine(on: On, app: App, seen: string[] = [], toasts: string[] = []) {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'dots' } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.PermissionRequest', () => ({}))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  // The tool itself: notes the title while it runs.
  on('tool.call', () => {
    seen.push(app.title ?? '')
    return { result: 'ok' }
  })
  on('mcp.call', (_, e) => {
    if (app.isMissing) throw new Error(`no MCP server named ${e.server}`)
    if (e.tool === 'get_session') return { value: text(JSON.stringify({ sessionId: 'local_1', title: app.title })) }
    if (e.tool === 'list_sessions') return { value: text(JSON.stringify(app.others ?? [])) }
    const other = app.others?.find(session => session.sessionId === e.args.session_id)
    if (other) {
      other.title = String(e.args.title)
      return { value: text(`Renamed session ${other.sessionId}.`) }
    }
    const title = String(e.args.title)
    if (app.source === 'user' && title !== app.title) return { value: text(USER_TITLE_REFUSAL, true) }
    app.title = title
    app.source = 'tool'
    app.renames.push(title)
    return { value: text(`Renamed this session to "${title}".`) }
  })
}

const start = ($: Engine) => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
const begin = ($: Engine, agentId?: string) => $.turn.start({ text: 'go', turnId: 't1', ...(agentId ? { agentId } : {}) })
const end = ($: Engine, reason: 'answer' | 'aborted' | 'error', agentId?: string) =>
  $.turn.complete({
    answer: reason === 'answer' ? 'Done.' : '',
    durationMs: 10,
    isAborted: reason === 'aborted',
    turnId: 't1',
    reason,
    ...(agentId ? { agentId } : {}),
  })
const dots = ($: Engine, args: string) =>
  $.command.run({ command: 'dots', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

test('no dot while working (the app shows its grey one), green when the turn ends with an answer', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Fix the login bug', source: 'auto', renames: [] }
  engine(on, app)
  await start($)

  await begin($)
  expect(app.title).toBe('Fix the login bug')
  await end($, 'answer')
  expect(app.title).toBe('🟢 Fix the login bug')
  await begin($)
  expect(app.title).toBe('Fix the login bug')
})

test('white when the answer ends with a suggested next step', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Ship the release', source: 'auto', renames: [] }
  engine(on, app)
  await start($)

  await begin($)
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Built it.', ask: 'Publish it?', actions: [] })
  await end($, 'answer')
  expect(app.title).toBe('⚪ Ship the release')

  // A recap alone draws no box: green.
  await begin($)
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Built it.' })
  await end($, 'answer')
  expect(app.title).toBe('🟢 Ship the release')
})

test('red when an error or a refusal ends the turn', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Port the parser', source: 'auto', renames: [] }
  engine(on, app)
  await start($)

  await begin($)
  await end($, 'error')
  expect(app.title).toBe('🔴 Port the parser')

  await begin($)
  await $.turn.complete({
    answer: '',
    durationMs: 10,
    isAborted: false,
    turnId: 't1',
    reason: 'refusal',
    refusal: { category: null, explanation: null },
  })
  expect(app.title).toBe('🔴 Port the parser')
})

test('a turn you stop leaves no dot', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Tidy the docs', source: 'auto', renames: [] }
  engine(on, app)
  await start($)

  await begin($)
  await end($, 'aborted')
  expect(app.title).toBe('Tidy the docs')
})

test('yellow while a permission card is up, back to no dot once the call returns', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Clean the build', source: 'auto', renames: [] }
  engine(on, app)
  await start($)

  await begin($)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } })
  expect(app.title).toBe('🟡 Clean the build')
  await $.tool.call({ tool: 'Bash', command: 'rm -rf dist' })
  expect(app.title).toBe('Clean the build')
})

test('yellow while a question waits for your answer', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Pick a palette', source: 'auto', renames: [] }
  const seen: string[] = []
  engine(on, app, seen)
  await start($)

  await begin($)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] })
  expect(seen).toEqual(['🟡 Pick a palette'])
  expect(app.title).toBe('Pick a palette')
})

test('an answered question clears its yellow dot even when the mod loaded mid-turn', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Loaded late', source: 'tool', renames: [] }
  engine(on, app)
  await start($)

  await $.tool.call({ tool: 'AskUserQuestion', questions: [] })
  expect(app.title).toBe('Loaded late')
  expect(app.renames).toEqual(['🟡 Loaded late', 'Loaded late'])
})

test("a subagent's turns leave the session's dot alone", async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Review the PR', source: 'auto', renames: [] }
  engine(on, app)
  await start($)

  await begin($)
  await begin($, 'agent-1')
  await end($, 'answer', 'agent-1')
  expect(app.title).toBe('Review the PR')
})

test('a title you set yourself is left alone, and why is said once ever', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'My own name', source: 'user', renames: [] }
  const toasts: string[] = []
  engine(on, app, [], toasts)
  await start($)

  await begin($)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })
  await end($, 'answer')
  await begin($)
  await end($, 'answer')
  expect(app.title).toBe('My own name')
  expect(app.renames).toEqual([])
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('named this session yourself')
})

test("no dot before the app has named the session, so its naming isn't blocked", async ($, on) => {
  mock.store(on)
  const app: App = { title: undefined, source: 'auto', renames: [] }
  engine(on, app)
  await start($)

  await begin($)
  expect(app.renames).toEqual([])
  app.title = 'Named by the app'
  await end($, 'answer')
  expect(app.title).toBe('🟢 Named by the app')
})

test('a yellow dot left from a closed app is cleared when the session starts', async ($, on) => {
  mock.store(on)
  const app: App = { title: '🟡 Was waiting', source: 'tool', renames: [] }
  engine(on, app)
  await start($)
  expect(app.title).toBe('Was waiting')
})

test('a green dot stays when the session starts again', async ($, on) => {
  mock.store(on)
  const app: App = { title: '🟢 Finished', source: 'tool', renames: [] }
  engine(on, app)
  await start($)
  expect(app.title).toBe('🟢 Finished')
  expect(app.renames).toEqual([])
})

test('/dots off removes the dot and keeps it off; /dots on brings it back', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Write tests', source: 'auto', renames: [] }
  engine(on, app)
  await start($)

  await begin($)
  await end($, 'answer')
  expect(app.title).toBe('🟢 Write tests')

  const off = await dots($, 'off')
  expect(off.text).toBe('Status dots are off.')
  expect(app.title).toBe('Write tests')
  await begin($)
  await end($, 'answer')
  expect(app.title).toBe('Write tests')

  await dots($, 'on')
  await begin($)
  await end($, 'answer')
  expect(app.title).toBe('🟢 Write tests')
})

test('/dots off also takes the dot off other sessions, and leaves titles without one alone', async ($, on) => {
  mock.store(on)
  const others = [
    { sessionId: 'local_2', title: '🟢 Other done' },
    { sessionId: 'local_3', title: '🔴 Other failed' },
    { sessionId: 'local_4', title: 'No dot here' },
  ]
  const app: App = { title: '⚪ This one', source: 'tool', renames: [], others }
  engine(on, app)
  await start($)

  const off = await dots($, 'off')
  expect(off.text).toBe('Status dots are off. Also took the dot off 2 other sessions.')
  expect(app.title).toBe('This one')
  expect(others.map(session => session.title)).toEqual(['Other done', 'Other failed', 'No dot here'])
})

test('outside the desktop app it does nothing and breaks nothing', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Terminal session', source: 'auto', renames: [], isMissing: true }
  engine(on, app)
  await start($)

  await begin($)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] })
  const result = await end($, 'answer')
  expect(result.text).toBe('')
  expect(app.renames).toEqual([])
})
