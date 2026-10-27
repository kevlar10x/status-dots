import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
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
  // Whether the app shows this session in a window; shown unless a test says not.
  isOffScreen?: boolean
  isMissing?: boolean
  // The app's tools aren't connected yet, as in a process that has just started.
  isConnecting?: boolean
  // The app's own record of the session (its data file), when a test gives one.
  record?: Record<string, unknown>
  // Renames of this session never answer, as a stuck call wouldn't.
  isStuck?: boolean
  // How many times the mod read this session from the app.
  reads?: number
  // Every call the mod made to the app, answered or not.
  calls?: number
  // Renames answer without saying which title they replaced.
  isTerse?: boolean
  // How many times the mod read the record file, and asked if the app shows the session.
  fileReads?: number
  layoutChecks?: number
}

const text = (value: string, isError = false) => ({ content: [{ type: 'text' as const, text: value }], isError })

const DATA = 'C:/Users/me/AppData/Local/Claude-Data'
const RECORD = `${DATA}/claude_abc/claude-code-sessions/org/acct/local_1.json`

// The clock of the test that's running; the helpers below settle it, since the
// mod's hooks don't wait for the title to be written.
let current: MockClock

// Lets a few rounds of pending work run, inside a hook where the clock can't settle.
const flush = async () => {
  for (let i = 0; i < 50; i += 1) await Promise.resolve()
}

const RENAME = 'mcp__ccd_session_mgmt__set_session_title'

// Stands in for the engine, the desktop app's session tools and its data folder.
// Returns the mocked clock.
function engine(on: On, app: App, seen: string[] = [], toasts: string[] = []) {
  const clock = mock.clock(on, { now: 0 })
  current = clock
  mock.env(on, { LOCALAPPDATA: 'C:/Users/me/AppData/Local' })
  const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
  // The engine may hand paths over in Windows form.
  const norm = (path: string) => path.replace(/\\/g, '/')
  on('fs.exists', (_, e) => ({ value: app.record !== undefined && [DATA, `${DATA}/claude_abc/claude-code-sessions`, RECORD].includes(norm(e.path)) }))
  on('fs.list', (_, e) => ({
    value:
      norm(e.path) === DATA ? [dir('claude_abc')]
      : norm(e.path).endsWith('claude-code-sessions') ? [dir('org')]
      : norm(e.path).endsWith('/org') ? [dir('acct')]
      : [],
  }))
  on('fs.read', (_, e) => {
    if (norm(e.path) !== RECORD || app.record === undefined) throw new Error(`ENOENT ${e.path}`)
    app.fileReads = (app.fileReads ?? 0) + 1
    return { value: JSON.stringify(app.record) }
  })
  // The file's time changes whenever the record does.
  on('fs.stat', (_, e) => {
    if (norm(e.path) !== RECORD || app.record === undefined) throw new Error(`ENOENT ${e.path}`)
    const json = JSON.stringify(app.record)
    let mtimeMs = 0
    for (let i = 0; i < json.length; i += 1) mtimeMs = (mtimeMs * 31 + json.charCodeAt(i)) % 1_000_000_007
    return { value: { kind: 'file' as const, size: json.length, mtimeMs, isLink: false } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'dots' } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.Notification', () => ({}))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  // The tool itself: notes the title while it runs, once the mod has had a
  // moment to write it. Claude's own rename of this session renames it.
  on('tool.call', async (_, e) => {
    if (e.tool === RENAME) app.title = String((e as { title?: unknown }).title)
    await flush()
    seen.push(app.title ?? '')
    return { result: 'ok' }
  })
  on('mcp.call', (_, e) => {
    app.calls = (app.calls ?? 0) + 1
    if (app.isMissing || app.isConnecting) throw new Error(`no MCP server named ${e.server}`)
    if (e.tool === 'get_session') {
      app.reads = (app.reads ?? 0) + 1
      return { value: text(JSON.stringify({ sessionId: 'local_1', title: app.title })) }
    }
    if (e.tool === 'list_sessions') return { value: text(JSON.stringify(app.others ?? [])) }
    if (e.tool === 'get_window_layout') {
      app.layoutChecks = (app.layoutChecks ?? 0) + 1
      return { value: text(JSON.stringify({ this_session: { session_id: 'local_1', on_screen: !app.isOffScreen } })) }
    }
    const other = app.others?.find(session => session.sessionId === e.args.session_id)
    if (other) {
      other.title = String(e.args.title)
      return { value: text(`Renamed session ${other.sessionId}.`) }
    }
    if (app.isStuck) return new Promise<never>(() => undefined)
    const title = String(e.args.title)
    if (app.source === 'user' && title !== app.title) return { value: text(USER_TITLE_REFUSAL, true) }
    const was = app.title
    app.title = title
    app.source = 'tool'
    app.renames.push(title)
    const replaced = was === undefined || app.isTerse ? '' : ` (was ${JSON.stringify(was)})`
    return { value: text(`Renamed this session to ${JSON.stringify(title)}${replaced}.`) }
  })
  return clock
}

const start = async ($: Engine) => {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await current.settle()
}
const begin = async ($: Engine, agentId?: string) => {
  await $.turn.start({ text: 'go', turnId: 't1', ...(agentId ? { agentId } : {}) })
  await current.settle()
}
const end = async ($: Engine, reason: 'answer' | 'aborted' | 'error', agentId?: string, answer = 'Done.') => {
  const result = await $.turn.complete({
    answer: reason === 'answer' ? answer : '',
    durationMs: 10,
    isAborted: reason === 'aborted',
    turnId: 't1',
    reason,
    ...(agentId ? { agentId } : {}),
  })
  await current.settle()
  return result
}
const dots = async ($: Engine, args: string) => {
  const result = await $.command.run({ command: 'dots', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  await current.settle()
  return result
}
const tool = async ($: Engine, input: Record<string, unknown> & { tool: string }) => {
  await $.tool.call(input as Parameters<Engine['tool']['call']>[0])
  await current.settle()
}
const notify = async ($: Engine) => {
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
  await current.settle()
}

test('white while working, green when the turn ends with an answer', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Fix the login bug', source: 'auto', renames: [] }
  engine(on, app)
  await start($)

  await begin($)
  expect(app.title).toBe('⚪ Fix the login bug')
  await end($, 'answer')
  expect(app.title).toBe('🟢 Fix the login bug')
  await begin($)
  expect(app.title).toBe('⚪ Fix the login bug')
})

test('yellow when the turn ends by asking you something', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Ship the release', source: 'auto', renames: [] }
  engine(on, app)
  await start($)

  await begin($)
  await tool($, { tool: 'mcp__ccd_turn__wrap_up', recap: 'Built it.', ask: 'Publish it?', actions: [] })
  await end($, 'answer')
  expect(app.title).toBe('🟡 Ship the release')

  // A recap alone asks nothing: green.
  await begin($)
  await tool($, { tool: 'mcp__ccd_turn__wrap_up', recap: 'Built it.' })
  await end($, 'answer')
  expect(app.title).toBe('🟢 Ship the release')
})

test("a question only in the reply's text stays green: nothing on screen waits for you", async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Fix the build', source: 'auto', renames: [] }
  engine(on, app)
  await start($)

  await begin($)
  await end($, 'answer', undefined, 'The build passes now.\n\nWant me to push it?')
  expect(app.title).toBe('🟢 Fix the build')
})

test('blue when it finishes while you are not looking, green once you open it', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Long build', source: 'auto', renames: [], isOffScreen: true }
  const clock = engine(on, app)
  await start($)

  await begin($)
  await end($, 'answer')
  expect(app.title).toBe('🔵 Long build')
  await clock.advance(15_000)
  expect(app.title).toBe('🔵 Long build')

  app.isOffScreen = false
  await clock.advance(5_000)
  expect(app.title).toBe('🟢 Long build')
})

test('a new turn while blue stops the check', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Quick fix', source: 'auto', renames: [], isOffScreen: true }
  const clock = engine(on, app)
  await start($)

  await begin($)
  await end($, 'answer')
  expect(app.title).toBe('🔵 Quick fix')
  await begin($)
  app.isOffScreen = false
  await clock.advance(10_000)
  expect(app.title).toBe('⚪ Quick fix')
})

test('a blue dot turns green when you open the session after a restart', async ($, on) => {
  mock.store(on)
  const app: App = { title: '🔵 Finished overnight', source: 'tool', renames: [], isOffScreen: true }
  const clock = engine(on, app)
  await start($)
  expect(app.title).toBe('🔵 Finished overnight')

  app.isOffScreen = false
  await clock.advance(5_000)
  expect(app.title).toBe('🟢 Finished overnight')
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

test('yellow while a permission card is up, back to white once the call returns', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Clean the build', source: 'auto', renames: [] }
  engine(on, app)
  await start($)

  await begin($)
  await notify($)
  expect(app.title).toBe('🟡 Clean the build')
  await tool($, { tool: 'Bash', command: 'rm -rf dist' })
  expect(app.title).toBe('⚪ Clean the build')
})

test('yellow while a question waits for your answer', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Pick a palette', source: 'auto', renames: [] }
  const seen: string[] = []
  engine(on, app, seen)
  await start($)

  await begin($)
  await tool($, { tool: 'AskUserQuestion', questions: [] })
  expect(seen).toEqual(['🟡 Pick a palette'])
  expect(app.title).toBe('⚪ Pick a palette')
})

test('an answered question clears its yellow dot even when the mod loaded mid-turn', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Loaded late', source: 'tool', renames: [] }
  engine(on, app)
  await start($)

  await tool($, { tool: 'AskUserQuestion', questions: [] })
  expect(app.title).toBe('⚪ Loaded late')
  expect(app.renames).toEqual(['🟡 Loaded late', '⚪ Loaded late'])
})

test("a subagent's turns leave the session's dot alone", async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Review the PR', source: 'auto', renames: [] }
  engine(on, app)
  await start($)

  await begin($)
  await begin($, 'agent-1')
  await end($, 'answer', 'agent-1')
  expect(app.title).toBe('⚪ Review the PR')
})

test('a title you set yourself is left alone, and why is said once ever', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'My own name', source: 'user', renames: [] }
  const toasts: string[] = []
  engine(on, app, [], toasts)
  await start($)

  await begin($)
  await notify($)
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

test('a yellow dot stays when the session starts again, since it still needs you', async ($, on) => {
  mock.store(on)
  const app: App = { title: '🟡 Was waiting', source: 'tool', renames: [] }
  engine(on, app)
  await start($)
  expect(app.title).toBe('🟡 Was waiting')
  expect(app.renames).toEqual([])
})

test("0.1.0's white dot now reads as working and gives way when the turn ends", async ($, on) => {
  mock.store(on)
  const app: App = { title: '⚪ Old suggestion', source: 'tool', renames: [] }
  engine(on, app)
  await start($)

  await begin($)
  expect(app.title).toBe('⚪ Old suggestion')
  await end($, 'answer')
  expect(app.title).toBe('🟢 Old suggestion')
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

test("dots still work when the app's tools connect after the session starts", async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Fresh process', source: 'tool', renames: [], isConnecting: true }
  const clock = engine(on, app)
  await start($)
  app.isConnecting = false
  await clock.advance(10_000)

  await begin($)
  await end($, 'answer')
  expect(app.title).toBe('🟢 Fresh process')
})

test('a blue dot left from before is still checked when the tools connect late', async ($, on) => {
  mock.store(on)
  const app: App = { title: '🔵 Seen later', source: 'tool', renames: [], isConnecting: true }
  const clock = engine(on, app)
  await start($)
  app.isConnecting = false
  await clock.advance(10_000)
  expect(app.title).toBe('🟢 Seen later')
})

// A next-step box that asks you something, as the app records it.
const ASKED = { description: 'Done.', needsUser: 'Pick one?' }

// The app's record once it has summed up the reply `uuid`.
const summed = (category: string, uuid = 'a2', wrapUp?: Record<string, unknown>) => ({
  lastAssistantUuid: uuid,
  postTurnSummaryFor: uuid,
  postTurnSummary: { status_category: category },
  ...(wrapUp ? { turnWrapUp: wrapUp } : {}),
})

test("the summary's guess that Claude is blocked on you doesn't make it yellow", async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Ship the build', source: 'auto', renames: [] }
  const clock = engine(on, app)
  await start($)

  await begin($)
  await end($, 'answer', undefined, 'The build is ready. You need to sign the installer before I can upload it.')
  app.record = summed('blocked')
  await clock.advance(2_000)
  expect(app.title).toBe('🟢 Ship the build')
})

test('red when the app recorded an error for the turn, not for a summary that says it failed', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Deploy', source: 'auto', renames: [], record: summed('failed') }
  const clock = engine(on, app)
  await start($)

  await begin($)
  await end($, 'answer', undefined, 'The deploy did not go through.')
  await clock.advance(2_000)
  expect(app.title).toBe('🟢 Deploy')

  await begin($)
  app.record = { ...summed('completed', 'a3'), errorCategory: 'api_error' }
  await end($, 'answer')
  await clock.advance(2_000)
  expect(app.title).toBe('🔴 Deploy')
})

test("a next-step question the mod didn't see is put back from the app's record", async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Tidy imports', source: 'auto', renames: [] }
  const clock = engine(on, app)
  await start($)

  await begin($)
  await end($, 'answer')
  expect(app.title).toBe('🟢 Tidy imports')
  app.record = summed('completed', 'a2', ASKED)
  await clock.advance(2_000)
  expect(app.title).toBe('🟡 Tidy imports')
})

test('a question in the end-of-turn box stays yellow whatever the summary says', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Release', source: 'auto', renames: [] }
  const clock = engine(on, app)
  await start($)

  await begin($)
  await tool($, { tool: 'mcp__ccd_turn__wrap_up', recap: 'Built it.', ask: 'Publish it?' })
  await end($, 'answer')
  app.record = summed('completed', 'a2', { description: 'Built it.', needsUser: 'Publish it?' })
  await clock.advance(2_000)
  expect(app.title).toBe('🟡 Release')
})

test('the verdict waits for the summary of the latest reply', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Refactor', source: 'auto', renames: [] }
  const clock = engine(on, app)
  await start($)

  await begin($)
  await end($, 'answer')
  // Still the summary of an earlier reply.
  app.record = { ...summed('completed', 'a1', ASKED), lastAssistantUuid: 'a2' }
  await clock.advance(4_000)
  expect(app.title).toBe('🟢 Refactor')
  app.record = summed('completed', 'a2', ASKED)
  await clock.advance(2_000)
  expect(app.title).toBe('🟡 Refactor')
})

test('a new turn stops the verdict check of the one before', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Quick turns', source: 'auto', renames: [] }
  const clock = engine(on, app)
  await start($)

  await begin($)
  await end($, 'answer')
  await begin($)
  app.record = summed('completed', 'a2', ASKED)
  await clock.advance(10_000)
  expect(app.title).toBe('⚪ Quick turns')
})

test('a turn whose end was missed gets its dot when the session starts again', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Missed end', source: 'tool', renames: [], record: summed('completed', 'a2', ASKED) }
  engine(on, app)
  await start($)
  expect(app.title).toBe('🟡 Missed end')
})

test('a white dot left by a run that stopped mid-turn goes when no turn picks it up', async ($, on) => {
  mock.store(on)
  const app: App = { title: '⚪ Stopped mid-turn', source: 'tool', renames: [] }
  const clock = engine(on, app)
  await start($)
  expect(app.title).toBe('⚪ Stopped mid-turn')
  await clock.advance(20_000)
  expect(app.title).toBe('Stopped mid-turn')
})

test('a white dot stays when the turn picks up again after a restart', async ($, on) => {
  mock.store(on)
  const app: App = { title: '⚪ Resumed', source: 'tool', renames: [] }
  const clock = engine(on, app)
  await start($)
  await begin($)
  await clock.advance(20_000)
  expect(app.title).toBe('⚪ Resumed')
})

test('a yellow dot that came from a guess goes back to green when the session starts', async ($, on) => {
  mock.store(on)
  const app: App = { title: '🟡 btt', source: 'tool', renames: [], record: summed('blocked') }
  engine(on, app)
  await start($)
  expect(app.title).toBe('🟢 btt')
})

test('a missed finish comes back blue when you are not looking, and a seen green stays green', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Missed finish', source: 'tool', renames: [], record: summed('completed'), isOffScreen: true }
  engine(on, app)
  await start($)
  expect(app.title).toBe('🔵 Missed finish')
})

test('a green dot is not turned blue at start by a finished verdict', async ($, on) => {
  mock.store(on)
  const app: App = { title: '🟢 Seen already', source: 'tool', renames: [], record: summed('completed'), isOffScreen: true }
  engine(on, app)
  await start($)
  expect(app.title).toBe('🟢 Seen already')
  expect(app.renames).toEqual([])
})

test('a stuck app call times out, and the dots after it still work', async ($, on) => {
  mock.store(on)
  const app: App = { title: '🟢 Stuck once', source: 'tool', renames: [] }
  const clock = engine(on, app)
  await start($)

  app.isStuck = true
  // The hook doesn't wait for the stuck write; the turn goes on.
  await begin($)
  await clock.advance(10_000)
  app.isStuck = false
  await clock.advance(1_000)
  expect(app.title).toBe('⚪ Stuck once')
  await end($, 'answer')
  expect(app.title).toBe('🟢 Stuck once')
})

test('once the title is known, a dot change is a single call to the app', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'One call', source: 'tool', renames: [] }
  engine(on, app)
  await start($)
  const reads = app.reads

  await begin($)
  await end($, 'answer')
  await begin($)
  await end($, 'answer')
  expect(app.title).toBe('🟢 One call')
  expect(app.reads).toBe(reads)
})

test('a rename in between keeps the new name and gets the dot', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Old name', source: 'tool', renames: [] }
  engine(on, app)
  await start($)

  await begin($)
  // Renamed by something the mod doesn't see, another session say.
  app.title = 'New name'
  await end($, 'answer')
  expect(app.title).toBe('🟢 New name')
})

test('Claude renaming this session keeps the new name and its dot', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Draft', source: 'tool', renames: [] }
  engine(on, app)
  await start($)

  await begin($)
  await tool($, { tool: RENAME, session_id: 'self', title: 'Release notes' })
  expect(app.title).toBe('⚪ Release notes')
  await end($, 'answer')
  expect(app.title).toBe('🟢 Release notes')
})

test("a write that can't reach the app yet is tried again a second later", async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Cold start', source: 'tool', renames: [] }
  const clock = engine(on, app)
  await start($)

  app.isConnecting = true
  await begin($)
  expect(app.title).toBe('Cold start')
  app.isConnecting = false
  await clock.advance(1_000)
  expect(app.title).toBe('⚪ Cold start')
})

test('blue turns green within a second of opening the session', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Quick look', source: 'tool', renames: [], isOffScreen: true }
  const clock = engine(on, app)
  await start($)

  await begin($)
  await end($, 'answer')
  expect(app.title).toBe('🔵 Quick look')
  app.isOffScreen = false
  await clock.advance(1_000)
  expect(app.title).toBe('🟢 Quick look')
})

test('without an app to reach, a dot change soon costs a single try', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Terminal', source: 'auto', renames: [], isMissing: true }
  const clock = engine(on, app)
  await start($)
  await clock.advance(31_000)
  for (let turn = 0; turn < 2; turn += 1) {
    await begin($)
    await end($, 'answer')
    await clock.advance(15_000)
  }

  const before = app.calls ?? 0
  await begin($)
  await clock.advance(15_000)
  expect((app.calls ?? 0) - before).toBe(1)
})

test("a rename answer that doesn't name the old title means a fresh read next time", async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Terse', source: 'tool', renames: [], isTerse: true }
  engine(on, app)
  await start($)

  await begin($)
  const reads = app.reads ?? 0
  await end($, 'answer')
  expect(app.reads).toBe(reads + 1)
  expect(app.title).toBe('🟢 Terse')
})

test('a blue dot checks less often the longer it stays blue', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Left alone', source: 'tool', renames: [], isOffScreen: true }
  const clock = engine(on, app)
  await start($)
  await begin($)
  await end($, 'answer')

  const first = app.layoutChecks ?? 0
  await clock.advance(20_000)
  expect((app.layoutChecks ?? 0) - first).toBe(20)
  await clock.advance(10 * 60_000)
  const later = app.layoutChecks ?? 0
  await clock.advance(60_000)
  expect((app.layoutChecks ?? 0) - later).toBe(4)
  expect(app.title).toBe('🔵 Left alone')
})

test("after a turn the app's file is only read again when it has changed", async ($, on) => {
  mock.store(on)
  // A record whose summary of the latest reply never comes.
  const app: App = { title: 'No summary', source: 'tool', renames: [], record: { lastAssistantUuid: 'a2' } }
  const clock = engine(on, app)
  await start($)
  await begin($)
  await end($, 'answer')
  // The app writes the file once as the turn ends, then leaves it.
  app.record = { lastAssistantUuid: 'a3' }

  const reads = app.fileReads ?? 0
  await clock.advance(30_000)
  expect((app.fileReads ?? 0) - reads).toBe(1)
  expect(app.title).toBe('🟢 No summary')
})

test('outside the desktop app it does nothing and breaks nothing', async ($, on) => {
  mock.store(on)
  const app: App = { title: 'Terminal session', source: 'auto', renames: [], isMissing: true }
  engine(on, app)
  await start($)

  await begin($)
  await tool($, { tool: 'AskUserQuestion', questions: [] })
  const result = await end($, 'answer')
  expect(result.text).toBe('')
  expect(app.renames).toEqual([])
})
