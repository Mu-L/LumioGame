/** Runtime WorldChange browser observation helpers for entity-chat acceptance. */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import { BROWSER_NAME, MAIN_ROOM, TEST_PASSWORD } from './verify-evidence.mjs'
import { extractChatEventsFromFrame } from './web/chat-window.js'

export { BROWSER_NAME, MAIN_ROOM, TEST_PASSWORD }

export function encodeChatInput(text) {
  const utf8 = Buffer.from(String(text ?? ''), 'utf8')
  const payload = Buffer.alloc(4 + utf8.length)
  payload.writeUInt32LE(utf8.length, 0)
  utf8.copy(payload, 4)
  return {
    messageType: 'InputCommand',
    mappingId: 'chat.input',
    payload: payload.toString('hex'),
    payloadSha256: createHash('sha256').update(payload).digest('hex'),
  }
}

export function observedEventKey(event) {
  return `${event.senderNetEntityId}:${event.text}:${event.roomSequence}`
}

/** Loopback Room wire client. Only Runtime WorldChange frames produce chat events. */
export async function connectRoomWire(listenUri, connectionId, { timeoutMs = 10000 } = {}) {
  const url = String(listenUri ?? '')
  if (!url) throw new Error('missing room listenUri')
  const ws = new WebSocket(url)
  const received = []
  const chatEvents = []
  const state = { superseded: false, closed: false }
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`room connect timeout (${timeoutMs}ms)`)), timeoutMs)
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('room websocket error'))
    })
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      ws.send(JSON.stringify({ connectionId }))
      resolve()
    })
  })
  ws.addEventListener('message', (ev) => {
    const raw = typeof ev.data === 'string' ? ev.data : String(ev.data)
    received.push(raw)
    let parsed = null
    try { parsed = JSON.parse(raw) } catch { parsed = null }
    if (parsed?.messageType === 'ConnectionSuperseded') state.superseded = true
    chatEvents.push(...extractChatEventsFromFrame(parsed ?? raw))
  })
  ws.addEventListener('close', () => { state.closed = true })
  await opened
  return {
    ws,
    connectionId,
    received,
    chatEvents,
    get superseded() { return state.superseded },
    get closed() { return state.closed },
    close: () => { try { ws.close() } catch { /* ignore */ } },
  }
}

export function indexBindings(bindings, botLogins = [], browser = null) {
  const byAccount = new Map()
  for (const row of botLogins) {
    if (row?.accountId) byAccount.set(row.accountId, { loginName: row.loginName, entityType: 'bot', accountId: row.accountId })
  }
  if (browser?.accountId) {
    byAccount.set(browser.accountId, { loginName: browser.loginName, entityType: 'player', accountId: browser.accountId })
  }
  return (bindings ?? []).map((row) => {
    const extra = byAccount.get(row.accountId) ?? {}
    const entityKind = row.entityKind ?? extra.entityType ?? null
    return {
      ...row,
      loginName: extra.loginName ?? row.loginName ?? null,
      entityKind,
      entityType: entityKind,
    }
  })
}

function firstLine(err) {
  return String(err?.message ?? err ?? '').split('\n')[0]
}

/** Run the real Playwright browser and capture received WebSocket WorldChange frames. */
export async function runPlaywrightBrowser({
  pageUrl,
  password,
  resultPath,
  consolePath,
  waitForEvents = 0,
  waitMs = 30000,
} = {}) {
  const importErrors = []
  let chromium = null
  const here = dirname(fileURLToPath(import.meta.url))
  const requirePw = createRequire(import.meta.url)
  const fileSpecs = [
    resolve(here, '../hello/node_modules/playwright/index.js'),
    resolve(here, '../../../../LumioGame/integration/hello/node_modules/playwright/index.js'),
    process.env.LUMIO_GAME_ROOT
      ? resolve(process.env.LUMIO_GAME_ROOT, 'integration/hello/node_modules/playwright/index.js')
      : null,
  ].filter((p) => p && existsSync(p))
  try {
    ;({ chromium } = await import('playwright'))
  } catch (err) {
    importErrors.push(`playwright: ${firstLine(err)}`)
  }
  if (!chromium) {
    for (const spec of fileSpecs) {
      try {
        const mod = requirePw(spec)
        chromium = mod?.chromium ?? mod?.default?.chromium ?? null
        if (chromium) break
        const esm = await import(pathToFileURL(spec.replace(/index\.js$/i, 'index.mjs')).href)
        chromium = esm?.chromium ?? esm?.default?.chromium ?? null
        if (chromium) break
        importErrors.push(`${spec}: no chromium export`)
      } catch (err) {
        importErrors.push(`${spec}: ${firstLine(err)}`)
      }
    }
  }
  if (!chromium) {
    return { ran: false, injected: false, receivedFromNetwork: false, receivedChatEvent: false, windowLines: [], networkFrames: [], error: `playwright unavailable: ${importErrors.join(' | ') || 'module not found'}` }
  }

  const launchErrors = []
  let browser = null
  let channel = null
  for (const ch of ['chrome', 'msedge']) {
    try {
      browser = await chromium.launch({ channel: ch, headless: true })
      channel = ch
      break
    } catch (err) {
      launchErrors.push(`${ch}: ${firstLine(err)}`)
    }
  }
  if (!browser) {
    try {
      browser = await chromium.launch({ headless: true })
      channel = 'chromium'
    } catch (err) {
      launchErrors.push(`bundled: ${firstLine(err)}`)
      return { ran: false, injected: false, receivedFromNetwork: false, receivedChatEvent: false, windowLines: [], networkFrames: [], error: `Chromium missing: ${launchErrors.join(' | ')}` }
    }
  }

  const appendEv = (obj) => {
    if (!consolePath) return
    try { appendFileSync(consolePath, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n') } catch { /* ignore */ }
  }
  let result = null
  const networkFrames = []
  const context = await browser.newContext()
  const page = await context.newPage()
  page.on('console', (m) => appendEv({ kind: 'console', type: m.type(), text: m.text() }))
  page.on('pageerror', (e) => appendEv({ kind: 'pageerror', text: String(e) }))
  page.on('websocket', (socket) => {
    socket.on('framereceived', (payload) => {
      if (typeof payload !== 'string') return
      try {
        const parsed = JSON.parse(payload)
        if (parsed?.messageType === 'WorldChange' && Array.isArray(parsed.rpcs)) networkFrames.push(parsed)
      } catch {
        // Non-JSON websocket frames are not Runtime WorldChange evidence.
      }
    })
  })
  try {
    await page.goto(pageUrl, { timeout: 20000, waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => typeof window.__lumioStartLogin === 'function', null, { timeout: 10000 })
    await page.evaluate(async (pw) => { await window.__lumioStartLogin(pw) }, password)
    await page.waitForFunction(() => window.__lumioResult && window.__lumioResult.status !== 'pending', null, { timeout: 20000 })
    if (Number(waitForEvents) > 0) {
      await page.waitForFunction((n) => (window.__lumioChat?.window?.lines?.length ?? 0) >= n, Number(waitForEvents), { timeout: waitMs })
    }
    result = await page.evaluate(() => ({
      ...(window.__lumioResult ?? {}),
      windowLines: window.__lumioChat?.window?.lines ?? [],
      receivedChatEvent: (window.__lumioChat?.window?.lines?.length ?? 0) > 0 || window.__lumioResult?.receivedChatEvent === true,
      connectionSuperseded: window.__lumioResult?.connectionSuperseded === true,
    }))
  } catch (err) {
    appendEv({ kind: 'harness-error', text: firstLine(err) })
    result = await page.evaluate(() => ({
      ...(window.__lumioResult ?? {}),
      windowLines: window.__lumioChat?.window?.lines ?? [],
      receivedChatEvent: (window.__lumioChat?.window?.lines?.length ?? 0) > 0,
    })).catch(() => null)
    const windowLines = Array.isArray(result?.windowLines) ? result.windowLines : []
    return { ran: true, injected: false, receivedFromNetwork: networkFrames.length > 0, receivedChatEvent: windowLines.length > 0 || result?.receivedChatEvent === true, windowLines, receivedEvents: windowLines, networkFrames, browser: 'chromium', channel, error: firstLine(err), result }
  } finally {
    try { await context.close() } catch { /* ignore */ }
    try { await browser.close() } catch { /* ignore */ }
  }
  if (resultPath) writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n')
  const windowLines = Array.isArray(result?.windowLines) ? result.windowLines : []
  return { ran: true, injected: false, receivedFromNetwork: networkFrames.length > 0, receivedChatEvent: windowLines.length > 0 || result?.receivedChatEvent === true, windowLines, receivedEvents: windowLines, networkFrames, connectionSuperseded: result?.connectionSuperseded === true, browser: 'chromium', channel, result }
}

const test = process.env.NODE_TEST_CONTEXT ? nodeTest : () => {}

test('encodeChatInput matches frozen LumioBinV1 gg hash', () => {
  const cmd = encodeChatInput('gg')
  assert.equal(cmd.messageType, 'InputCommand')
  assert.equal(cmd.mappingId, 'chat.input')
  assert.equal(cmd.payload, '020000006767')
  assert.equal(cmd.payloadSha256, '5dbd584f1718b8bcd0dab4abeea83169f4a990defab81a8316ed845798d92dab')
})

test('encodeChatInput hello-Bot01 is lowercase hex payload + sha256', () => {
  const cmd = encodeChatInput('hello-Bot01')
  assert.equal(cmd.payload, '0b00000068656c6c6f2d426f743031')
  assert.match(cmd.payloadSha256, /^[0-9a-f]{64}$/)
  assert.equal(cmd.payloadSha256, createHash('sha256').update(Buffer.from(cmd.payload, 'hex')).digest('hex'))
})

test('observedEventKey is sender:text:roomSequence from a received ClientRpc', () => {
  const sender = '10000000000000010000000000000065'
  assert.equal(observedEventKey({ senderNetEntityId: sender, text: 'hello-Bot01', roomSequence: 1 }), `${sender}:hello-Bot01:1`)
})

test('connectRoomWire presents ordered WorldChange ChatComponent RPCs', async () => {
  const previousWebSocket = globalThis.WebSocket
  const instances = []
  class FakeWebSocket {
    constructor(url) { this.url = url; this.sent = []; this.listeners = new Map(); instances.push(this) }
    addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
    send(value) { this.sent.push(value) }
    emit(type, event = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event) }
  }
  const sender = '00000000000000010000000000000065'
  const secondSender = '00000000000000010000000000000066'
  const frame = { messageType: 'WorldChange', tick: 7, creates: [], fields: [], destroys: [], rpcs: [
    { target: sender, componentId: 'ChatComponent', method: 'OnChatMessage', args: [Buffer.from('first').toString('hex')], messageId: 1, roomSequence: 1, sender, appliedTick: 7, scope: 'room' },
    { target: secondSender, componentId: 'ChatComponent', method: 'OnChatMessage', args: [Buffer.from('second').toString('hex')], messageId: 2, roomSequence: 2, sender: secondSender, appliedTick: 7, scope: 'room' },
  ] }
  globalThis.WebSocket = FakeWebSocket
  try {
    const pending = connectRoomWire('ws://room.test', 'c-browser')
    const ws = instances[0]
    ws.emit('open')
    const client = await pending
    ws.emit('message', { data: JSON.stringify(frame) })
    assert.deepEqual(client.chatEvents, [
      { messageId: 1, roomSequence: 1, senderNetEntityId: sender, text: 'first', appliedTick: 7 },
      { messageId: 2, roomSequence: 2, senderNetEntityId: secondSender, text: 'second', appliedTick: 7 },
    ])
    assert.deepEqual(ws.sent, [JSON.stringify({ connectionId: 'c-browser' })])
  } finally {
    globalThis.WebSocket = previousWebSocket
  }
})

test('indexBindings joins loginName from accountId and keeps Runtime ids', () => {
  const indexed = indexBindings(
    [{ netEntityId: '10000000000000010000000000000001', accountId: 'acct_a', roomId: MAIN_ROOM, entityKind: 'bot', connectionId: 'c1', sessionId: 'sess-Bot01', generation: 1 }],
    [{ loginName: 'Bot01', accountId: 'acct_a' }],
    { loginName: BROWSER_NAME, accountId: 'acct_b' },
  )
  assert.equal(indexed[0].loginName, 'Bot01')
  assert.equal(indexed[0].netEntityId, '10000000000000010000000000000001')
})
