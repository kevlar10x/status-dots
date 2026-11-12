import type { EngineInterface as Engine, McpToolResult, Register, Timer } from 'claude-code'

import type { Turn } from '../types'

// status-dots by kevlar10x, MIT: https://github.com/kevlar10x/status-dots
//
// Puts a colored dot in front of this session's title, which the Code tab's
// sidebar shows, so the list reads like a traffic light: red when an error or
// a refusal stopped Claude, yellow when something on screen waits for you (a
// question, a plan or a permission card, or a question in the next-step box),
// blue when it finished while you weren't looking, green once you've seen it
// and it needs nothing from you, white while Claude works. The desktop app
// gives mods no way to recolor its own sidebar dot, so the title carries it. A
// title you typed yourself is yours: the app won't let anything but an
// approved rename change it, so that session gets no dot.
//
// Hooks don't wait for the title: they set the dot they want and pass their
// event straight on, and the title catches up a moment later. The app heads its
// Windows notifications with the title, so the end of a turn, a question and a
// plan are the exceptions: the dot comes off first, and the notification comes
// without one.

type Status = 'working' | 'waiting' | 'fresh' | 'done' | 'failed'

// Yellow is the app's own color for a session that needs input, blue its color
// for one with something you haven't seen. White is the nearest emoji to the
// app's grey working dot.
const DOTS: Record<Status, string> = { working: '⚪', waiting: '🟡', fresh: '🔵', done: '🟢', failed: '🔴' }
const DOT = /^(?:⚪|🟡|🔵|🟢|🔴) /u
const SESSIONS = 'ccd_session_mgmt'
const WINDOW = 'ccd_window'
// A blue session checks whether you've opened it every second at first, since
// that's when you're most likely to, then every 4 seconds for about 5 minutes,
// then every 15 seconds for as long as it stays blue.
const SEEN_STEPS = [
  { checks: 20, everyMs: 1000 },
  { checks: 70, everyMs: 4000 },
  { checks: Infinity, everyMs: 15000 },
]
// A write that couldn't reach the app (its tools still connecting, say) is
// tried again every second, ten times.
const WRITE_RETRY_MS = 1000
const WRITE_TRIES = 10
const UNREACHABLE_RUNS = 2
// How often, and how many times, a starting session retries reaching the app.
const START_RETRY_MS = 1000
const START_TRIES = 30
// How long a starting session waits for a turn before calling a white dot stale.
const STALE_WORKING_MS = 10000
// How often, and how many times, a finished turn looks for the app's verdict.
const VERDICT_CHECK_MS = 2000
const VERDICT_TRIES = 15
// An app call that hasn't answered by then counts as failed, so one stuck call
// can't hold up every dot after it.
const CALL_TIMEOUT_MS = 10000
// The first look at the files of sessions past the app's list goes back this far.
const FIRST_LOOK_MS = 24 * 60 * 60 * 1000
// Another session's file, named by its id.
const RECORD_FILE = /^(local_[\w-]+)\.json$/
// The longest the end of a turn or a question waits for the dot to come off.
const CLEAR_MS = 300
// How long a question's title stays bare, so its notification is out before
// yellow goes on.
const YELLOW_DELAY_MS = 1000
// Tools that stop for you whatever the permission mode.
const ASKS = new Set(['AskUserQuestion', 'ExitPlanMode'])
// The app's tools that put up a card of their own and wait for your answer,
// which Claude Code never hears about. One still out after a moment is
// taken to be waiting on you; the ones the app lets through return sooner.
const CARD_TOOLS = new Set([
  'mcp__ccd_directory__propose_branch',
  'mcp__ccd_directory__request_directory',
  'mcp__ccd_directory__change_directory',
  'mcp__ccd_session__start_session',
  'mcp__ccd_session_mgmt__delete_session',
  'mcp__computer-use__request_access',
  'mcp__computer-use__request_teach_access',
])
const CARD_MS = 2000
// The browsers ask you to allow a site, also out of Claude Code's sight. Their
// calls normally take seconds, so one still out after this is waiting on you.
const BROWSER = /^mcp__(?:[\w-]+__)?(?:Claude_Browser|claude-in-chrome)__/
const BROWSER_MS = 20000
// The app's end-of-turn box; with an `ask` it shows a question and buttons.
const WRAP_UP = 'mcp__ccd_turn__wrap_up'
// The app's rename tool, as Claude calls it.
const RENAME = `mcp__${SESSIONS}__set_session_title`
// The app's session ids, which name its record files.
const SESSION_ID = /^local_[\w-]+$/
// How background work that has ended may still be listed.
const ENDED = new Set(['completed', 'failed', 'killed'])
// A reply of nothing but a dot or two: Claude had nothing to say, often to
// something that woke it on its own, such as another session's report.
const FILLER = /^[.·…]+$/u
// The current turn, held by the host. A reload of the mod's code in the middle
// of a turn (an update, a dev folder's hot reload) starts a new copy with
// nothing in memory, and the turn's end can still reach the old copy while
// its tool calls reach the new one, so both keep the turn here too.
const TURN = { plugin: 'status-dots', key: 'turn' } as const

// The dot this session should show; undefined for none.
let wanted: Status | undefined
let isWriting = false
// The paint writing now, or the last one, so a clear can wait for it.
let painting: Promise<void> = Promise.resolve()
// The title as last read or written, so a dot change is one call, not two.
let knownTitle: string | undefined
let writeRetry: Timer | undefined
let writeTries = 0
// Changes in a row whose writes never reached the app, retries and all.
let unreachableRuns = 0
// The title is one you set, which the app keeps.
let isUserTitle = false
let isOff = false
// Calls waiting for you: a question or a plan, or a call held on a card the
// app put up. One from a subagent outlasts the main loop's turns.
const waits = new Set<symbol>()
// The turn's end-of-turn box asks you something.
let isAsking = false
// And that question stops the work until you answer it.
let isBlocking = false
// While the dot is blue: the next check for whether you've opened the session.
let seenCheck: Timer | undefined
let seenChecks = 0
// A turn has started in this process, so the start check has nothing left to do.
let hasTurned = false
// When the last turn in this process ended. A click after this means you've seen it.
let finishedAt: number | undefined
// Counts the main loop's turns, so a check started for one turn knows when another began.
let turnCount = 0
// The dot came off for the end of a turn that hasn't ended yet.
let isCleared = false
// Background work (a subagent, a command, a monitor) was still running as the
// last turn ended. It reports back in a turn of its own, so the session is
// still working until then.
let hasTasks = false
// The dot from before this turn, put back if the turn ends with nothing to
// say. In a process that has just started it's known once the title is read.
let dotBefore: Status | undefined
let isDotBeforeKnown = false
let wasAsking = false
let wasBlocking = false
// Other sessions' records found to need no change, by the file's time.
const settled = new Map<string, number>()
// When the sweep last looked at the files of sessions past the app's list, and
// the ones it found running there, to look at again.
let lookedAt: number | undefined
const running = new Set<string>()
// The dot came off for a question, and this brings yellow in behind it.
let yellowSoon: Timer | undefined
// After a turn: the next look for the app's verdict on it.
let verdictCheck: Timer | undefined
let sessionId: string | undefined
let recordPath: string | undefined
let recordSearches = 0
// The record as last read, and when the file was last read for a verdict, by
// its modification time.
let loaded: { mtimeMs: number; record: AppRecord } | undefined
let recordReadAt: number | undefined

// What the app keeps about this session in its data folder: whether the last
// turn's next-step box asked you something, and whether an error ended it. The
// file is the app's and private, so anything unexpected in it only means no
// verdict, and the mod's own checks stand.
type AppRecord = {
  lastAssistantUuid?: string
  postTurnSummary?: unknown
  postTurnSummaryFor?: string
  turnWrapUp?: { needsUser?: string }
  error?: unknown
  errorCategory?: unknown
  // 'user' when you named the session yourself.
  titleSource?: unknown
  // When you last clicked the session, and when its last turn began or ended.
  lastFocusedAt?: unknown
  lastTurnEdgeAt?: unknown
  // Read only from other sessions' files.
  title?: unknown
  isArchived?: unknown
}
type Verdict = 'waiting' | 'failed' | 'finished'

function textOf(result: McpToolResult) {
  const block = result.content.find(one => one.type === 'text') as { text?: string } | undefined
  return block?.text ?? ''
}

// An app call that didn't answer in time.
class TimedOut extends Error {
  tool: string
  constructor(tool: string) {
    super(`${tool} timed out`)
    this.tool = tool
  }
}

async function call($: Engine, server: string, tool: string, args: Record<string, unknown>) {
  let timer: Timer | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = $.clock.after(CALL_TIMEOUT_MS, () => reject(new TimedOut(tool)))
  })
  try {
    return await Promise.race([$.mcp.call(server, tool, args), timeout])
  } finally {
    timer?.cancel()
  }
}

async function titleOf($: Engine) {
  const result = await call($, SESSIONS, 'get_session', { session_id: 'self' })
  if (result.isError) return undefined
  const session = JSON.parse(textOf(result)) as { title?: string; sessionId?: string }
  if (SESSION_ID.test(session.sessionId ?? '')) sessionId ??= session.sessionId
  knownTitle = session.title?.trim() ?? ''
  if (!isDotBeforeKnown) {
    dotBefore = statusOf(knownTitle)
    isDotBeforeKnown = true
  }
  return knownTitle
}

function statusOf(title: string): Status | undefined {
  return (Object.keys(DOTS) as Status[]).find(status => title.startsWith(`${DOTS[status]} `))
}

function dotted(title: string, status: Status | undefined) {
  const bare = title.replace(DOT, '')
  return status === undefined ? bare : `${DOTS[status]} ${bare}`
}

// The app answers a rename with `Renamed this session to "new" (was "old").`
function replacedTitle(answer: string) {
  const match = /\(was (".*")\)\.?\s*$/su.exec(answer)
  if (match === null) return undefined
  try {
    return JSON.parse(match[1] ?? '') as string
  } catch {
    return undefined
  }
}

// The app keeps one file per session under %LOCALAPPDATA%\Claude-Data. Looked up
// once, then reused; a few tries, since the session's id comes from the app.
// Only a search of the app's folder counts as a try.
async function findRecord($: Engine) {
  if (recordPath !== undefined || sessionId === undefined || recordSearches >= 3) return recordPath
  const local = await $.env.get('LOCALAPPDATA')
  if (!local) return undefined
  const base = `${local}/Claude-Data`
  if (!(await $.fs.exists(base))) return undefined
  recordSearches += 1
  for (const account of await $.fs.list(base)) {
    if (account.kind !== 'dir' || !account.name.startsWith('claude_')) continue
    const root = `${base}/${account.name}/claude-code-sessions`
    if (!(await $.fs.exists(root))) continue
    for (const outer of await $.fs.list(root)) {
      if (outer.kind !== 'dir') continue
      for (const inner of await $.fs.list(`${root}/${outer.name}`)) {
        const path = `${root}/${outer.name}/${inner.name}/${sessionId}.json`
        if (inner.kind === 'dir' && (await $.fs.exists(path))) return (recordPath = path)
      }
    }
  }
  return undefined
}

// The record as last read from the file, which is read again only once it has
// changed (a stat is far cheaper than reading and parsing it). Only the fields
// the mod uses are kept: the whole record is a few hundred KB in memory.
async function loadRecord($: Engine) {
  const path = await findRecord($)
  if (path === undefined) return undefined
  const { mtimeMs } = await $.fs.stat(path)
  if (loaded?.mtimeMs !== mtimeMs) {
    const full = JSON.parse(await $.fs.read(path)) as AppRecord
    const record: AppRecord = {
      lastAssistantUuid: full.lastAssistantUuid,
      postTurnSummary: full.postTurnSummary === undefined ? undefined : true,
      postTurnSummaryFor: full.postTurnSummaryFor,
      turnWrapUp: full.turnWrapUp,
      error: full.error,
      errorCategory: full.errorCategory,
      titleSource: full.titleSource,
      lastFocusedAt: full.lastFocusedAt,
      lastTurnEdgeAt: full.lastTurnEdgeAt,
    }
    loaded = { mtimeMs, record }
  }
  return loaded
}

// Reads the record, or with `onlyIfChanged`, only when the file has changed
// since the last verdict was taken from it.
async function readRecord($: Engine, onlyIfChanged = false) {
  try {
    const latest = await loadRecord($)
    if (latest === undefined) return undefined
    if (onlyIfChanged && latest.mtimeMs === recordReadAt) return undefined
    recordReadAt = latest.mtimeMs
    return latest.record
  } catch {
    return undefined
  }
}

// Whether you named this session yourself, by the app's record. The app holds
// any other rename of such a title for your approval, and a mod's rename can't
// carry that approval, so each try would only leave another card up.
async function isNamedByYou($: Engine) {
  try {
    return (await loadRecord($))?.record.titleSource === 'user'
  } catch {
    return false
  }
}

// The same for another session, from its record next to this one's.
async function isOtherNamedByYou($: Engine, id: string) {
  // The id becomes part of a file path, so one that isn't the app's usual
  // shape is left alone rather than looked up.
  if (!SESSION_ID.test(id)) return true
  try {
    const path = await findRecord($)
    if (path === undefined) return false
    const other = JSON.parse(await $.fs.read(`${path.slice(0, path.lastIndexOf('/'))}/${id}.json`)) as AppRecord
    return other.titleSource === 'user'
  } catch {
    return false
  }
}

// How the last turn ended, from what the app recorded, once its record has
// caught up with the latest reply (it sums every turn up, and the summary
// arriving is the sign). Only what's really on screen counts: a question in the
// next-step box is your turn and an error is red. The summary's own reading of
// the reply, that Claude seems blocked on you, say, is a guess the mod ignores,
// since nothing in the session waits for you then.
function verdictOf(record: AppRecord): Verdict | undefined {
  if (record.postTurnSummary === undefined || record.lastAssistantUuid === undefined) return undefined
  if (record.postTurnSummaryFor !== record.lastAssistantUuid) return undefined
  if (record.error !== undefined || record.errorCategory !== undefined) return 'failed'
  if (record.turnWrapUp?.needsUser) return 'waiting'
  return 'finished'
}

// Whether a 'finished' verdict leaves the dot as it is: green or blue already,
// yellow for a question in the next-step box, or white while background work
// runs. The app records that question only when it stops the work, so
// 'finished' can't say it's gone.
function keepsFinishedDot() {
  return wanted === 'done' || wanted === 'fresh' || (wanted === 'waiting' && isAsking) || (wanted === 'working' && hasTasks)
}

function applyVerdict($: Engine, verdict: Verdict) {
  if (verdict === 'finished') {
    if (!keepsFinishedDot()) void showFinished($)
    return
  }
  if (wanted === verdict) return
  stopWatching()
  show($, verdict)
}

// The app sums up a turn a few seconds after it ends. Until then the dot comes
// from the mod's own checks; once the summary is in, the app's verdict wins.
function followVerdict($: Engine, triesLeft = VERDICT_TRIES) {
  const turn = turnCount
  verdictCheck?.cancel()
  verdictCheck = $.clock.after(VERDICT_CHECK_MS, async () => {
    verdictCheck = undefined
    if (turn !== turnCount) return
    const record = await readRecord($, true)
    const verdict = record === undefined ? undefined : verdictOf(record)
    if (turn !== turnCount) return
    if (verdict !== undefined) return applyVerdict($, verdict)
    if (triesLeft > 1) followVerdict($, triesLeft - 1)
  })
}

function stopFollowing() {
  verdictCheck?.cancel()
  verdictCheck = undefined
}

function holdTurn($: Engine, turn: Turn) {
  void $.state.set(TURN, turn).catch(() => undefined)
}

async function heldTurn($: Engine) {
  try {
    return (await $.state.get(TURN)).value
  } catch {
    return undefined
  }
}

// Whether the dots are off, in this session or another one since it last
// looked. Another session's /dots off has already taken this dot away, so
// this one drops its dot and its checks rather than bring it back.
async function isTurnedOff($: Engine) {
  if (!isOff) {
    try {
      isOff = (await $.store.get('isOff')) === true
    } catch {
      return false
    }
  }
  if (!isOff) return false
  wanted = undefined
  stopWatching()
  stopFollowing()
  return true
}

// Writes the wanted dot into the title, one write at a time. A change asked for
// while a write is out is picked up when that write returns, so the promise is
// the one of the write that's out. Never throws.
function paint($: Engine) {
  if (!isWriting) painting = paintTitle($)
  return painting
}

async function paintTitle($: Engine) {
  if (isWriting || isUserTitle) return
  isWriting = true
  let isReachable = true
  try {
    let status: Status | undefined
    let written: string | undefined
    // A rename that came in while a write was out: the name the dot goes onto.
    let renamed: string | undefined
    let isRenamed = false
    let redos = 0
    do {
      status = wanted
      isRenamed = false
      if (status !== undefined && (await isTurnedOff($))) status = wanted
      const title = knownTitle ?? (await titleOf($))
      if (title === undefined) return
      // No title yet. The app names a new session from its first prompt, and a
      // title written before that would stop it from doing so.
      if (title.replace(DOT, '') === '') {
        knownTitle = undefined
        return
      }
      const next = dotted(renamed ?? title, status)
      renamed = undefined
      if (next === title) continue
      if (await isNamedByYou($)) {
        knownTitle = undefined
        isUserTitle = true
        await explainOnce($)
        return
      }
      const result = await call($, SESSIONS, 'set_session_title', { session_id: 'self', title: next })
      if (result.isError) {
        knownTitle = undefined
        if (/set by the user/.test(textOf(result))) {
          isUserTitle = true
          await explainOnce($)
        }
        return
      }
      knownTitle = next
      // The app says which title it replaced. If that isn't the one this write
      // was based on (nor this paint's own last write), the session was renamed
      // in between, so the dot goes onto that name instead of bringing the old
      // one back. Once per paint, so a busy rename can't keep it looping.
      const replaced = replacedTitle(textOf(result))
      if (replaced === undefined) {
        // The answer doesn't say (the app may word it differently one day), so
        // read the title again before the next write rather than trust the cache.
        knownTitle = undefined
      } else if (replaced !== title && replaced !== written && redos < 1) {
        renamed = replaced
        isRenamed = true
        redos += 1
      }
      written = next
      // Looked at again once the write is in: dots turned off while it was out
      // take this one straight back off.
      if (status !== undefined) await isTurnedOff($)
    } while (isRenamed || status !== wanted)
  } catch (error) {
    knownTitle = undefined
    // A rename that doesn't answer is most likely held on an approval card, for
    // a title you set where the record couldn't say so. Trying again would
    // only stack more cards, so this session writes no more dots.
    if (error instanceof TimedOut && error.tool === 'set_session_title') isUserTitle = true
    // Otherwise the app's tools aren't reachable: not connected yet in a
    // process that has just started, or not there at all outside the desktop app.
    else isReachable = false
  } finally {
    isWriting = false
  }
  if (isReachable) unreachableRuns = 0
  else retryPaint($)
}

// Retries while the app's tools may still be connecting. After a few changes
// that never got through (a terminal session has no app to reach), each change
// is tried once and no more.
function retryPaint($: Engine) {
  if (writeTries >= WRITE_TRIES || unreachableRuns >= UNREACHABLE_RUNS) {
    if (writeTries >= WRITE_TRIES) unreachableRuns += 1
    return
  }
  writeTries += 1
  writeRetry?.cancel()
  writeRetry = $.clock.after(WRITE_RETRY_MS, () => {
    writeRetry = undefined
    void paint($)
  })
}

// Said once, ever, so a session without a dot isn't a mystery.
async function explainOnce($: Engine) {
  if ((await $.store.get('hasExplained')) === true) return
  await $.store.set('hasExplained', true)
  $.ui.toast("status-dots: you named this session yourself, so it gets no dot. Have Claude rename it once (you approve) and it will.")
}

// Sets the dot this session should show and starts writing it. While a call
// waits for you, working or finished reads as your turn.
function show($: Engine, status: Status | undefined) {
  stopYellowSoon()
  const isYours = waits.size > 0 && (status === 'working' || status === 'done' || status === 'fresh')
  wanted = isOff ? undefined : isYours ? 'waiting' : status
  writeTries = 0
  void paint($)
}

function stopYellowSoon() {
  yellowSoon?.cancel()
  yellowSoon = undefined
}

// The app heads a notification with the title it holds as the notification
// goes out, so the dot comes off just before that.
async function clearDot($: Engine) {
  wanted = undefined
  writeTries = 0
  await Promise.race([paint($), $.clock.sleep(CLEAR_MS)])
}

// The turn is ending: the finished dot follows when it has.
async function clearForEnd($: Engine) {
  isCleared = true
  await clearDot($)
}

// A question or a plan is about to stop for you: yellow follows once it's on
// screen.
async function clearForQuestion($: Engine) {
  stopYellowSoon()
  await clearDot($)
  yellowSoon = $.clock.after(YELLOW_DELAY_MS, () => show($, 'waiting'))
}

type Listed = { sessionId?: string; title?: string; isRunning?: boolean }

// The app's list of other sessions, newest first, and whether it holds them all.
// Claude Code passes on no tool answer past a set size: a long list comes back
// as a note saying so, and a shorter one is tried after it.
async function listOthers($: Engine, limits: number[], args: Record<string, unknown> = {}) {
  for (const limit of limits) {
    const listed = await call($, SESSIONS, 'list_sessions', { ...args, limit })
    if (listed.isError) return undefined
    try {
      const sessions: unknown = JSON.parse(textOf(listed))
      if (Array.isArray(sessions)) return { sessions: sessions as Listed[], isAll: sessions.length < limit }
    } catch {
      // Too long to pass on.
    }
  }
  return undefined
}

// The other sessions' files in the app's data folder, next to this one's, with
// their times, apart from the ones named.
async function otherFiles($: Engine, skip: Set<string>) {
  const path = await findRecord($)
  if (path === undefined) return []
  const folder = path.slice(0, path.lastIndexOf('/'))
  const files: { id: string; file: string; mtimeMs: number }[] = []
  for (const entry of await $.fs.list(folder)) {
    const id = RECORD_FILE.exec(entry.name)?.[1]
    if (entry.kind !== 'file' || id === undefined || id === sessionId || skip.has(id)) continue
    files.push({ id, file: `${folder}/${entry.name}`, mtimeMs: entry.mtimeMs })
  }
  return files
}

async function clearOne($: Engine, id: string, title: string) {
  const result = await call($, SESSIONS, 'set_session_title', { session_id: id, title: title.replace(DOT, '') })
  return !result.isError
}

// Takes the dot off every other session, archived ones too, so turning the dots
// off (before an uninstall, say) leaves none behind. Sessions too far down the
// app's list for it to pass on are found from their files.
async function clearOthers($: Engine) {
  const listed = await listOthers($, [200, 100, 50, 20], { include_archived: true })
  if (listed === undefined) return 0
  let cleared = 0
  try {
    for (const session of listed.sessions) {
      const id = session.sessionId ?? ''
      const title = session.title?.trim() ?? ''
      // A title you named yourself is yours, a dot in front included: renaming
      // it would put up an approval card for each one.
      if (!DOT.test(title) || (await isOtherNamedByYou($, id))) continue
      if (await clearOne($, id, title)) cleared += 1
    }
    if (listed.isAll) return cleared
    for (const { id, file } of await otherFiles($, new Set(listed.sessions.map(session => session.sessionId ?? '')))) {
      let record: AppRecord
      try {
        record = JSON.parse(await $.fs.read(file)) as AppRecord
      } catch {
        continue
      }
      const title = typeof record.title === 'string' ? record.title.trim() : ''
      if (DOT.test(title) && record.titleSource !== 'user' && (await clearOne($, id, title))) cleared += 1
    }
  } catch (error) {
    // Held on an approval card: the rest would each put up another.
    if (!(error instanceof TimedOut)) throw error
  }
  return cleared
}

// Whether you have this session in front of you now: showing in a window and,
// when the window is split, in the pane with the focus. A failed check says no,
// so a hiccup of the app can't pass for you opening the session.
async function isOnScreen($: Engine) {
  try {
    const result = await call($, WINDOW, 'get_window_layout', {})
    if (result.isError) return false
    const layout = JSON.parse(textOf(result)) as {
      main_window?: { panes?: { session_id?: string; focused?: boolean }[] }
      this_session?: { session_id?: string; on_screen?: boolean }
    }
    const shown = layout.this_session
    if (shown?.on_screen !== true) return false
    return layout.main_window?.panes?.find(pane => pane.session_id === shown.session_id)?.focused !== false
  } catch {
    return false
  }
}

// The app stamps a session each time you click it, so a click after the turn
// ended counts even if you left again before the next check came round. A new
// process doesn't know when that was, so it goes by the app's own time for it.
function wasClicked({ lastFocusedAt, lastTurnEdgeAt }: AppRecord) {
  const since = finishedAt ?? lastTurnEdgeAt
  return typeof lastFocusedAt === 'number' && typeof since === 'number' && lastFocusedAt > since
}

// Whether you've opened this session since it finished.
async function hasSeen($: Engine) {
  try {
    const latest = await loadRecord($)
    if (latest !== undefined && wasClicked(latest.record)) return true
  } catch {
    // The record can't say. The window still can.
  }
  return isOnScreen($)
}

// Whether you've come back to this session since its next-step box asked you
// something that didn't stop the work. Being on screen as it asked doesn't count.
async function hasSeenQuestion($: Engine) {
  if (isBlocking) return false
  try {
    const latest = await loadRecord($)
    return latest !== undefined && !latest.record.turnWrapUp?.needsUser && wasClicked(latest.record)
  } catch {
    return false
  }
}

// Whether the dot waits for you to open the session: blue, or yellow for a
// question in the next-step box.
function isWatched() {
  return wanted === 'fresh' || (wanted === 'waiting' && isAsking)
}

// Seen: blue turns green, and so does a question's yellow, the question still
// there for you to answer.
function showSeen($: Engine) {
  if (wanted === 'waiting') {
    isAsking = false
    holdTurn($, hasTasks ? { isWorking: false, isAsking, hasTasks } : { isWorking: false, isAsking })
  }
  show($, hasTasks ? 'working' : 'done')
}

// A finished session stays blue until you've opened it, then turns green.
async function showFinished($: Engine) {
  if (isUserTitle) return
  const turn = turnCount
  const isSeen = await hasSeen($)
  // A new turn may have started while the check was out.
  if (turn !== turnCount) return
  show($, isSeen ? 'done' : 'fresh')
  if (!isSeen) watchUntilSeen($, true)
}

function seenDelay() {
  let left = seenChecks
  for (const step of SEEN_STEPS) {
    if (left < step.checks) return step.everyMs
    left -= step.checks
  }
  return SEEN_STEPS[SEEN_STEPS.length - 1]?.everyMs ?? 15000
}

// Checks while the dot is blue, or yellow for a question in the next-step box,
// less often the longer it stays, and stops once it isn't.
function watchUntilSeen($: Engine, isNew = false) {
  if (isNew) seenChecks = 0
  seenCheck?.cancel()
  seenCheck = $.clock.after(seenDelay(), async () => {
    seenCheck = undefined
    seenChecks += 1
    if (!isWatched()) return
    const isBlue = wanted === 'fresh'
    const isSeen = isBlue ? await hasSeen($) : await hasSeenQuestion($)
    // A turn may have started while the check was out.
    if (!isWatched() || isBlue !== (wanted === 'fresh')) return
    if (isSeen) showSeen($)
    // Where no app has answered (a terminal session), nothing will ever say you've seen it.
    else if (sessionId !== undefined) watchUntilSeen($)
  })
}

function stopWatching() {
  seenCheck?.cancel()
  seenCheck = undefined
}

// What a session finds when it starts. With the dots off, a dot left from
// before goes. With them on, the dot is brought in line with the app's verdict
// on the last turn, which also catches a turn whose end the mod missed (its
// process stopped, or the app couldn't be reached then). A yellow dot left by a
// closed app stays, since the session still needs you, and a blue one turns
// green once you've opened the session. In a process that has just started the
// app's tools may not be connected yet, so the check tries again every second
// for a while, until a turn starts and takes over.
async function checkAtStart($: Engine, triesLeft: number) {
  if (hasTurned) return
  // A reload in the middle of a turn fires this again: the turn goes on, and
  // its white dot isn't one left from a run that stopped.
  const held = await heldTurn($)
  if (held?.isAsking) isAsking = true
  // So does one between turns while background work runs.
  if (held?.isWorking || held?.hasTasks) {
    hasTurned = true
    hasTasks = held.hasTasks === true
    wanted = 'working'
    return
  }
  let title: string
  try {
    title = (await titleOf($)) ?? ''
  } catch {
    if (triesLeft > 0) $.clock.after(START_RETRY_MS, () => void checkAtStart($, triesLeft - 1).catch(() => undefined))
    return
  }
  void settleOthers($).catch(() => undefined)
  if (hasTurned) return
  if (isOff) {
    if (DOT.test(title)) show($, undefined)
    return
  }
  wanted = statusOf(title)
  const record = await readRecord($)
  const verdict = record === undefined ? undefined : verdictOf(record)
  if (hasTurned) return
  // A yellow dot with a next-step box behind it came from that box's question.
  if (wanted === 'waiting' && record?.turnWrapUp !== undefined) isAsking = true
  if (verdict === 'finished' && !keepsFinishedDot()) return showFinished($)
  if (verdict !== undefined) applyVerdict($, verdict)
  // A white dot with no turn behind it is left from a run that stopped mid-turn:
  // the process ended, or the app closed without picking the turn up again. A
  // turn that resumes takes over within moments; if none does, the dot goes.
  if (wanted === 'working') {
    $.clock.after(STALE_WORKING_MS, () => {
      if (!hasTurned && wanted === 'working') show($, undefined)
    })
    return
  }
  if (!isWatched()) return
  const isBlue = wanted === 'fresh'
  if (isBlue ? await hasSeen($) : await hasSeenQuestion($)) {
    if (!hasTurned && isWatched() && isBlue === (wanted === 'fresh')) showSeen($)
  } else watchUntilSeen($, true)
}

// Whether another session's dot can turn green, from its file: you've clicked
// it since its last turn, you didn't name it yourself (that rename would put up
// an approval card), and a yellow dot came from a question in the next-step box
// that didn't stop the work.
function isSettleable(record: AppRecord, status: Status | undefined) {
  const { lastFocusedAt, lastTurnEdgeAt, turnWrapUp } = record
  const isSeen = typeof lastFocusedAt === 'number' && typeof lastTurnEdgeAt === 'number' && lastFocusedAt > lastTurnEdgeAt
  const isQuestion = typeof turnWrapUp === 'object' && turnWrapUp !== null && !turnWrapUp.needsUser
  return isSeen && record.titleSource !== 'user' && (status === 'fresh' || (status === 'waiting' && isQuestion))
}

async function settle($: Engine, id: string, title: string) {
  await call($, SESSIONS, 'set_session_title', { session_id: id, title: dotted(title, 'done') })
}

// A session with no process running can't follow your clicks, so one that runs
// does it for the others: a blue dot, or yellow for a question in the
// next-step box that didn't stop the work, turns green once you've opened
// that session since its last turn.
async function settleOthers($: Engine) {
  if (isOff) return
  const path = await findRecord($)
  if (path === undefined) return
  const startedAt = await $.clock.now()
  const listed = await listOthers($, [50, 20])
  if (listed === undefined || isOff) return
  const folder = path.slice(0, path.lastIndexOf('/'))
  try {
    for (const session of listed.sessions) {
      const id = session.sessionId ?? ''
      const title = session.title?.trim() ?? ''
      const status = statusOf(title)
      // A session whose process runs looks after its own dot. The id becomes
      // part of a file path, so one of another shape is left alone.
      if (session.isRunning !== false || (status !== 'fresh' && status !== 'waiting') || !SESSION_ID.test(id)) continue
      const file = `${folder}/${id}.json`
      try {
        const { mtimeMs } = await $.fs.stat(file)
        if (settled.get(id) === mtimeMs) continue
        const record = JSON.parse(await $.fs.read(file)) as AppRecord
        if (isSettleable(record, status)) await settle($, id, title)
        else settled.set(id, mtimeMs)
      } catch (error) {
        if (error instanceof TimedOut) throw error
      }
    }
    if (!listed.isAll) await settleOlder($, new Set(listed.sessions.map(session => session.sessionId ?? '')), startedAt)
    lookedAt = startedAt
  } catch (error) {
    // Held on an approval card: the rest would each put up another.
    if (!(error instanceof TimedOut)) throw error
  }
}

// Sessions too far down the list for the app to pass on. Their files are read
// once they've changed since the last look (a click writes one), going back a
// day the first time, and the app says whether each one is running.
async function settleOlder($: Engine, listed: Set<string>, startedAt: number) {
  const since = lookedAt ?? startedAt - FIRST_LOOK_MS
  for (const { id, file, mtimeMs } of await otherFiles($, listed)) {
    if (settled.get(id) === mtimeMs || (mtimeMs <= since && !running.has(id))) continue
    try {
      const record = JSON.parse(await $.fs.read(file)) as AppRecord
      const title = typeof record.title === 'string' ? record.title.trim() : ''
      const status = statusOf(title)
      if (record.isArchived === true || !isSettleable(record, status)) {
        settled.set(id, mtimeMs)
        running.delete(id)
        continue
      }
      const answer = await call($, SESSIONS, 'get_session', { session_id: id })
      if (answer.isError) continue
      const session = JSON.parse(textOf(answer)) as Listed
      if (session.isRunning !== false) {
        running.add(id)
        continue
      }
      running.delete(id)
      // The title as the app has it now, which the file may not have caught up with.
      const now = session.title?.trim() ?? ''
      if (statusOf(now) === status) await settle($, id, now)
    } catch (error) {
      if (error instanceof TimedOut) throw error
    }
  }
}

// A rename of this session that changes nothing but its dot: this mod, or
// another copy of it, writing a dot.
function isDotWrite(e: { tool: string }) {
  if (e.tool !== RENAME || knownTitle === undefined) return false
  const { session_id: target, title } = e as { session_id?: unknown; title?: unknown }
  return (target === 'self' || target === sessionId) && typeof title === 'string' && title.replace(DOT, '') === knownTitle.replace(DOT, '')
}

// Back to working once nothing waits on you. Tool calls only return inside a
// turn, so this needs no turn of its own to have been seen.
function resume($: Engine) {
  if (waits.size === 0 && (wanted === 'waiting' || yellowSoon !== undefined)) show($, 'working')
}

// How long a call to the app's tools may run before it counts as waiting on a
// card for you; undefined for the tools that never put one up.
function cardDelay(tool: string) {
  if (CARD_TOOLS.has(tool)) return CARD_MS
  return BROWSER.test(tool) ? BROWSER_MS : undefined
}

// Another session may have turned the dots off since this one last looked.
async function refreshOff($: Engine) {
  const isOffNow = (await $.store.get('isOff')) === true
  if (isOffNow === isOff) return
  isOff = isOffNow
  show($, wanted)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'dots', description: 'Turn the sidebar status dots on or off' })
    const result = await next(e)
    isOff = (await $.store.get('isOff')) === true
    void checkAtStart($, START_TRIES).catch(() => undefined)

    return result
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      wasAsking = isAsking
      wasBlocking = isBlocking
      isDotBeforeKnown = waits.size > 0 || wanted !== undefined || knownTitle !== undefined
      // Yellow for a wait still out isn't put back: the turn finishes as usual.
      dotBefore = waits.size > 0 ? 'working' : wanted ?? (knownTitle === undefined ? undefined : statusOf(knownTitle))
      isAsking = false
      isBlocking = false
      isCleared = false
      hasTasks = false
      holdTurn($, { isWorking: true, isAsking: false })
      stopWatching()
      stopFollowing()
      hasTurned = true
      turnCount += 1
      show($, 'working')
      void refreshOff($).catch(() => undefined)
    }

    return next(e)
  })

  // Runs before the app hears that the turn has ended, so this one hook waits
  // for the title. Claude Code lists here the background work still running.
  on('classic.Stop', async ($, e, next) => {
    if (e.agent_id === undefined) {
      hasTasks = (e.background_tasks ?? []).some(task => !ENDED.has(task.status))
      await clearForEnd($)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.StopFailure', async ($, e, next) => {
    if (e.agent_id === undefined) await clearForEnd($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    isCleared = false
    // A copy of the mod reloaded mid-turn may have seen the question instead.
    if ((await heldTurn($))?.isAsking) isAsking = true
    // A reply of only a dot puts back the dot from before the turn, unless the
    // turn asks you something or left work running.
    if (e.reason === 'answer' && !isAsking && !hasTasks && isDotBeforeKnown && dotBefore !== 'working' && FILLER.test(e.answer.trim())) {
      isAsking = wasAsking
      isBlocking = wasBlocking
      holdTurn($, { isWorking: false, isAsking })
      // Blue stays until you've opened the session since its last real finish.
      if (dotBefore === 'fresh') void showFinished($)
      else {
        show($, dotBefore)
        if (isWatched()) watchUntilSeen($, true)
      }
      void settleOthers($).catch(() => undefined)
      return result
    }
    finishedAt = await $.clock.now()
    holdTurn($, hasTasks ? { isWorking: false, isAsking, hasTasks } : { isWorking: false, isAsking })
    // An answer whose next-step box asks you something leaves it your turn. A
    // question only in the reply's text doesn't: nothing on screen waits for you.
    // Background work still running keeps it white until its report's turn ends.
    if (e.reason === 'answer' && !isAsking) {
      if (hasTasks) show($, 'working')
      else void showFinished($)
    }
    // Stopped by you: no dot, since you were there to see it.
    else show($, e.reason === 'answer' ? 'waiting' : e.reason === 'aborted' ? undefined : 'failed')
    // A question in the next-step box stays yellow until you come back to it.
    if (e.reason === 'answer' && isAsking) watchUntilSeen($, true)
    if (e.reason === 'answer') followVerdict($)
    void settleOthers($).catch(() => undefined)

    return result
  })

  // A permission prompt or a question is waiting for you. Claude Code reports
  // it a few seconds after it goes up, once the app's notification is out. A
  // hook on the permission check itself runs alongside the prompt, too late to
  // take the dot off first, and the Claude directory accepts one there only
  // when it does nothing but pass the event on.
  on('classic.Notification', ($, e, next) => {
    if (e.notification_type === 'permission_prompt' || e.notification_type === 'elicitation_dialog') {
      show($, 'waiting')
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // A question or a plan to approve waits for you until its call returns, and
  // so does a call to the app's tools held on a card past its moment. Any call
  // returning moves an answered permission card back to working. When Claude
  // renames this session, the mod reads the new name before its next dot.
  on('tool.call', async ($, e, next) => {
    // Only Claude's own calls say what the turn is doing. Another mod's call,
    // or a dot being written to this session's title, passes by untouched.
    if (next.origin.plugin !== 'engine' || isDotWrite(e)) return next(e)
    // Another mod's Stop hook can keep a turn going after its dot came off.
    if (isCleared && e.agentId === undefined) {
      isCleared = false
      show($, 'working')
    }
    if (e.tool === WRAP_UP && e.agentId === undefined) {
      const ask = (e as { ask?: unknown }).ask
      if (typeof ask === 'string' && ask.trim() !== '') {
        isAsking = true
        isBlocking = (e as { blocked?: unknown }).blocked === true
        holdTurn($, { isWorking: true, isAsking: true })
      }
    }
    const isQuestion = ASKS.has(e.tool)
    const wait = Symbol(e.tool)
    if (isQuestion) waits.add(wait)
    const delay = cardDelay(e.tool)
    const cardSoon = delay === undefined ? undefined : $.clock.after(delay, () => {
      waits.add(wait)
      show($, 'waiting')
    })
    try {
      if (isQuestion) await clearForQuestion($)
      return await next(e)
    } finally {
      cardSoon?.cancel()
      waits.delete(wait)
      if (e.tool === RENAME) {
        const target = (e as { session_id?: unknown }).session_id
        if (target === 'self' || target === sessionId) {
          knownTitle = undefined
          isUserTitle = false
          show($, wanted)
        }
      }
      resume($)
    }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'dots' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    isOff = arg === 'off' ? true : arg === 'on' ? false : !isOff
    await $.store.set('isOff', isOff)
    if (isOff) {
      stopWatching()
      stopFollowing()
      show($, undefined)
      let cleared = 0
      try {
        cleared = await clearOthers($)
      } catch {
        // The list couldn't be read; each session still drops its dot when it next starts or works.
      }
      const others = cleared === 1 ? '1 other session' : `${cleared} other sessions`
      return { text: cleared === 0 ? 'Status dots are off.' : `Status dots are off. Also took the dot off ${others}.` }
    }
    return { text: 'Status dots are on. In the Claude desktop app, this session gets its dot the next time Claude finishes here.' }
  })
}
