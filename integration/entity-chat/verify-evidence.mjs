#!/usr/bin/env node
/**
 * verify-evidence — R-00390 / R4-06 oracle.
 *
 * Evidence is logs only (ADR-057 §3). Inputs: server log dir + client log dir.
 * Does not read harness evidence.json / timer-trace.json.
 *
 * Usage:
 *   node verify-evidence.mjs --dir <logs>
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'

export const MAIN_ROOM = 'room-main'
export const BROWSER_NAME = 'Browser01'
export const TEST_PASSWORD = '123456'
export const ORACLE_TICK_SOURCE = 'native-kernel/tickFrame'
export const CLIENT_CADENCE_TICKS = [5, 10, 15]
export const SKIP_HARNESS_FILES = new Set(['evidence.json', 'timer-trace.json'])

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

export function oracleFilePath() {
  return fileURLToPath(import.meta.url)
}

function withOracleTempDir(label, callback) {
  const safeLabel = String(label).replace(/[^a-z0-9_-]/gi, '-')
  const dir = mkdtempSync(join(dirname(oracleFilePath()), `.tmp-oracle-${safeLabel}-`))
  try {
    return callback(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function oracleSha256(p = oracleFilePath()) {
  const text = readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function parseNdjson(text) {
  const events = []
  const lines = String(text ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!trimmed) continue
    try {
      const ev = JSON.parse(trimmed)
      if (!isObject(ev)) {
        events.push({ line: i + 1, ev: null, error: 'record_not_object' })
        continue
      }
      events.push({ line: i + 1, ev })
    } catch {
      events.push({ line: i + 1, ev: null, error: 'malformed_json' })
    }
  }
  return events
}

export function isLauncherLoopIndex(id) {
  const n = Number(id)
  return Number.isInteger(n) && n >= 1 && n <= 101 && String(n) === String(id)
}

function u64ToHex16(value) {
  let n
  if (typeof value === 'bigint') n = value
  else if (typeof value === 'number' && Number.isFinite(value)) n = BigInt(Math.trunc(value))
  else if (typeof value === 'string' && /^(0x)?[0-9a-f]+$/i.test(value)) n = BigInt(value)
  else return null
  if (n < 0n || n > 0xffffffffffffffffn) return null
  return n.toString(16).padStart(16, '0')
}

/** C-1 canonical NetEntityId: exactly 32 lowercase hex characters. */
export function parseSenderNetEntityId(rec) {
  if (rec == null) return null
  if (typeof rec === 'string') {
    if (/^[0-9a-f]{32}$/.test(rec) && !/^0+$/.test(rec)) return rec
    return null
  }
  if (!isObject(rec)) return null
  if (typeof rec.senderNetEntityId === 'string') {
    const parsed = parseSenderNetEntityId(rec.senderNetEntityId)
    if (parsed) return parsed
  }
  if (typeof rec.netEntityId === 'string') {
    const parsed = parseSenderNetEntityId(rec.netEntityId)
    if (parsed) return parsed
  }
  return null
}

export function isHostNetEntityId(id) {
  if (id == null) return false
  if (typeof id === 'object') return parseSenderNetEntityId(id) != null
  const s = String(id)
  if (s.length === 0 || s === '0' || isLauncherLoopIndex(s)) return false
  if (/^sess[-_]/i.test(s)) return false
  return parseSenderNetEntityId(s) != null
}

export function eventOrderKey(tuple) {
  if (typeof tuple === 'string') return tuple
  if (!isObject(tuple)) return String(tuple)
  const sender = parseSenderNetEntityId(tuple) ?? ''
  return [tuple.messageId, tuple.roomSequence, sender, tuple.appliedTick].join('|')
}

function walkLogFiles(root, out = []) {
  if (!root || !existsSync(root)) return out
  const st = statSync(root)
  if (st.isFile()) {
    const base = root.replace(/\\/g, '/').split('/').pop()
    if (!SKIP_HARNESS_FILES.has(base)) out.push(root)
    return out
  }
  const names = readdirSync(root).sort()
  for (const name of names) {
    if (SKIP_HARNESS_FILES.has(name)) continue
    const p = join(root, name)
    const child = statSync(p)
    if (child.isDirectory()) walkLogFiles(p, out)
    else if (/\.(ndjson|jsonl|log)$/i.test(name) || name === 'server' || name === 'client') out.push(p)
  }
  return out
}

function loadRecords(path) {
  const files = walkLogFiles(path)
  const events = []
  for (const file of files) {
    events.push(...parseNdjson(readFileSync(file, 'utf8')))
  }
  return events
}

function resolveRoleDir(roundDir, role) {
  const asDir = join(roundDir, role)
  if (existsSync(asDir)) return asDir
  for (const name of [`${role}.ndjson`, `${role}.jsonl`, `${role}.log`]) {
    const asFile = join(roundDir, name)
    if (existsSync(asFile)) return asFile
  }
  return asDir
}

function kindOf(ev) {
  return String(ev?.kind ?? ev?.event ?? '')
}

function entityTypeOf(ev) {
  const t = ev?.entityType
  return t === 'world' || t === 'player' || t === 'bot' ? t : null
}

function entityRecordFailures(serverEvents) {
  const failures = []
  const checkRecord = (record, label) => {
    if (typeof record?.netEntityId !== 'string' || parseSenderNetEntityId(record.netEntityId) == null) {
      failures.push({ check: 'census:id', message: `${label} netEntityId must be a lowercase canonical 32-hex string` })
    }
    if (entityTypeOf(record) == null) {
      failures.push({ check: 'census:entity-type', message: `${label} entityType must be exactly world, player, or bot` })
    }
  }
  for (const ev of serverRecordsWithRuntimeFrames(serverEvents)) {
    if (!isObject(ev)) continue
    const kind = kindOf(ev)
    if (kind === 'entity_admitted' || (kind === 'admit' && (ev.netEntityId != null || ev.entityType != null))) {
      checkRecord(ev, `server ${kind}`)
    }
    if (ev.messageType !== 'WorldChange' || !Array.isArray(ev.creates)) continue
    for (const create of ev.creates) checkRecord(create, 'WorldChange create')
  }
  return failures
}

function isRuntimeDrain(ev) {
  const kind = kindOf(ev)
  return kind === 'drain' || kind === 'runtime.drain' || kind === 'drain.outbox'
    || ev?.messageType === 'DrainOutbox'
}

/** Returns only owner-thread Runtime results carried by drain.queries. */
export function runtimeDrainQueries(events) {
  const queries = []
  for (const record of events ?? []) {
    const ev = record?.ev
    if (!isRuntimeDrain(ev) || !Array.isArray(ev.queries)) continue
    for (const query of ev.queries) {
      if (isObject(query)) queries.push(query)
    }
  }
  return queries
}

function runtimeDrainFrames(events) {
  const frames = []
  for (const record of events ?? []) {
    const ev = record?.ev
    if (!isRuntimeDrain(ev) || !Array.isArray(ev.frames)) continue
    for (const frame of ev.frames) {
      if (isObject(frame)) frames.push(frame)
    }
  }
  return frames
}

function serverRecordsWithRuntimeFrames(serverEvents) {
  return [...(serverEvents ?? []).map((record) => record?.ev), ...runtimeDrainFrames(serverEvents)]
}

export function censusFromServerLogs(serverEvents) {
  const byId = new Map()
  for (const ev of serverRecordsWithRuntimeFrames(serverEvents)) {
    if (!isObject(ev)) continue
    const kind = kindOf(ev)
    if (kind === 'entity_admitted' || kind === 'admit') {
      const id = parseSenderNetEntityId(ev) ?? parseSenderNetEntityId(ev.netEntityId)
      const type = entityTypeOf(ev)
      if (id != null && (type === 'player' || type === 'bot')) byId.set(id, type)
    }
    if (ev.messageType !== 'WorldChange' || !Array.isArray(ev.creates)) continue
    for (const create of ev.creates) {
      const id = parseSenderNetEntityId(create) ?? parseSenderNetEntityId(create?.netEntityId)
      const type = entityTypeOf(create)
      if (id != null && (type === 'player' || type === 'bot')) byId.set(id, type)
    }
  }
  let botCount = 0
  let playerCount = 0
  for (const t of byId.values()) {
    if (t === 'bot') botCount++
    else playerCount++
  }
  return { botCount, playerCount, total: byId.size, netEntityIds: [...byId.keys()] }
}

function decodeHexText(value) {
  if (typeof value !== 'string' || value.length % 2 !== 0 || !/^[0-9a-f]+$/.test(value)) return null
  const bytes = Buffer.from(value, 'hex')
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return null }
}

function isCanonicalC1Counter(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function chatEventFromRpc(rpc) {
  if (!isObject(rpc) || rpc.componentId !== 'ChatComponent' || rpc.method !== 'OnChatMessage') return null
  const target = typeof rpc.target === 'string' ? parseSenderNetEntityId(rpc.target) : null
  const sender = typeof rpc.sender === 'string' ? parseSenderNetEntityId(rpc.sender) : null
  if (target == null || sender == null || rpc.scope !== 'room'
    || !isCanonicalC1Counter(rpc.messageId)
    || !isCanonicalC1Counter(rpc.roomSequence)
    || !isCanonicalC1Counter(rpc.appliedTick)) return null
  const encoded = Array.isArray(rpc.args) ? rpc.args[0] : null
  const text = decodeHexText(encoded)
  if (text == null) return null
  return { targetNetEntityId: target, scope: rpc.scope, messageId: rpc.messageId, roomSequence: rpc.roomSequence, senderNetEntityId: sender, appliedTick: rpc.appliedTick, text }
}

function runtimeRpcSequence(events) {
  const chatEvents = []
  let present = false
  let invalid = 0
  for (const ev of runtimeDrainFrames(events)) {
    if (ev.messageType === 'WorldChange' && Array.isArray(ev.rpcs)) {
      present = true
      for (const rpc of ev.rpcs) {
        const parsed = chatEventFromRpc(rpc)
        if (parsed) chatEvents.push(parsed)
        else if (isObject(rpc) && rpc.componentId === 'ChatComponent' && rpc.method === 'OnChatMessage') invalid++
      }
    }
  }
  return { present, events: chatEvents, invalid }
}

function chatEventsFromRuntimeDrains(serverEvents, clientEvents) {
  const server = runtimeRpcSequence(serverEvents)
  if (server.present) return server
  return runtimeRpcSequence(clientEvents)
}

function windowLinesFromClient(clientEvents) {
  const lines = []
  for (const { ev } of clientEvents) {
    if (kindOf(ev) !== 'chat.window') continue
    if (ev.phase === 'restored') continue
    lines.push(ev)
  }
  return lines
}

function playwrightNetworkRpcSequence(clientEvents) {
  const events = []
  let present = false
  let invalid = 0
  for (const record of clientEvents ?? []) {
    const ev = record?.ev
    if (kindOf(ev) !== 'playwright.network'
      || ev.source !== 'playwright'
      || ev.transport !== 'websocket'
      || ev.direction !== 'received'
      || ev.messageType !== 'WorldChange') continue
    present = true
    if (ev.ran !== true || ev.receivedFromNetwork !== true) {
      invalid++
      continue
    }
    if (!['chromium', 'chrome', 'msedge'].includes(String(ev.browser ?? '').toLowerCase())) {
      invalid++
      continue
    }
    if (!Array.isArray(ev.rpcs)) {
      invalid++
      continue
    }
    for (const rpc of ev.rpcs) {
      const parsed = chatEventFromRpc(rpc)
      if (parsed) events.push(parsed)
      else if (isObject(rpc) && rpc.componentId === 'ChatComponent' && rpc.method === 'OnChatMessage') invalid++
    }
  }
  return { present, events, invalid }
}

function hasKind(events, kind) {
  return events.some(({ ev }) => kindOf(ev) === kind)
}

function findKind(events, kind) {
  return events.find(({ ev }) => kindOf(ev) === kind)?.ev ?? null
}

function blobOf(events) {
  return events.map(({ ev }) => JSON.stringify(ev)).join('\n').toLowerCase()
}

function malformedRecordFailures(events, source) {
  return (events ?? [])
    .filter((record) => record?.error)
    .map((record) => ({
      check: 'logs:malformed',
      message: `${source} line ${record.line}: ${record.error}`,
    }))
}

function malformedDrainFailures(events, source) {
  const failures = []
  for (const record of events ?? []) {
    const ev = record?.ev
    if (!isRuntimeDrain(ev)) continue
    for (const field of ['frames', 'queries']) {
      if (ev[field] === undefined) continue
      if (!Array.isArray(ev[field])) {
        failures.push({
          check: 'logs:malformed',
          message: `${source} line ${record.line}: drain.${field} must be an array`,
        })
        continue
      }
      for (let i = 0; i < ev[field].length; i++) {
        if (!isObject(ev[field][i])) {
          failures.push({
            check: 'logs:malformed',
            message: `${source} line ${record.line}: drain.${field}[${i}] must be an object`,
          })
        }
      }
    }
  }
  return failures
}

export function verifyRunFromLogs(serverDir, clientDir) {
  const failures = []
  if (!serverDir || !existsSync(serverDir) || !clientDir || !existsSync(clientDir)) {
    return {
      ok: false,
      failures: [{ check: 'logs:missing', message: 'server log dir and client log dir are required' }],
      census: { botCount: 0, playerCount: 0, total: 0, netEntityIds: [] },
      eventOrder: [],
      appliedTicks: [],
    }
  }

  const serverEvents = loadRecords(serverDir)
  const clientEvents = loadRecords(clientDir)
  failures.push(...malformedRecordFailures(serverEvents, 'server'))
  failures.push(...malformedRecordFailures(clientEvents, 'client'))
  failures.push(...malformedDrainFailures(serverEvents, 'server'))
  failures.push(...malformedDrainFailures(clientEvents, 'client'))
  const host = findKind(serverEvents, 'host') ?? findKind(clientEvents, 'host')
  const hostName = host?.process ?? host?.host
  if (hostName === 'lumio-mvp-host' || /lumio-mvp-host/i.test(String(hostName ?? ''))) {
    failures.push({ check: 'host:mvp-impersonation', message: 'lumio-mvp-host is never a SUCCESS path' })
  }
  if (hostName !== 'lumio-entity-chat-replay' && !/lumio-entity-chat-replay/i.test(String(hostName ?? ''))) {
    failures.push({ check: 'host:rust', message: 'host process must name lumio-entity-chat-replay' })
  }

  const census = censusFromServerLogs(serverEvents)
  failures.push(...entityRecordFailures(serverEvents))
  if (census.botCount !== 100) {
    failures.push({ check: 'census:bots', message: `BotEntity 计数 ${census.botCount},应为 100` })
  }
  if (census.playerCount !== 1) {
    failures.push({ check: 'census:player', message: `PlayerEntity 计数 ${census.playerCount},应为 1` })
  }
  if (census.total !== 101) {
    failures.push({ check: 'census:total', message: `实体总数 ${census.total},应为 101` })
  }
  if (!census.netEntityIds.every((id) => isHostNetEntityId(id))) {
    failures.push({ check: 'census:id', message: 'census netEntityId must be 32-hex (two u64), not loop index' })
  }

  const account = findKind(serverEvents, 'account')
  if (account?.wrongPasswordCode && account.wrongPasswordCode !== 'wrong_password') {
    failures.push({ check: 's1:wrong-password', message: `wrong password code=${account.wrongPasswordCode}` })
  }
  if (!account || account.wrongPasswordCode !== 'wrong_password') {
    failures.push({ check: 's1:wrong-password', message: 'account log must observe wrong_password' })
  }

  const runtimeRpc = chatEventsFromRuntimeDrains(serverEvents, clientEvents)
  const runtimeObserved = runtimeRpc.events
  const observed = runtimeObserved
  if (!runtimeRpc.present || runtimeObserved.length === 0) {
    failures.push({ check: 's3:runtime-rpc', message: 'Runtime drain must contain WorldChange.rpcs OnChatMessage evidence' })
  }
  if (runtimeRpc.invalid > 0) {
    failures.push({ check: 's3:runtime-rpc-format', message: 'Runtime OnChatMessage args[0] must be lowercase hex' })
  }

  for (let i = 1; i < runtimeObserved.length; i++) {
    if (runtimeObserved[i].roomSequence <= runtimeObserved[i - 1].roomSequence) {
      failures.push({
        check: 's6:rpc-roomSequence',
        message: 'Runtime drain WorldChange.rpcs must have strictly increasing roomSequence',
      })
      break
    }
  }

  const windowLines = windowLinesFromClient(clientEvents)
  const browserNetwork = playwrightNetworkRpcSequence(clientEvents)
  if (!browserNetwork.present || browserNetwork.events.length === 0) {
    failures.push({ check: 's6:playwright-network', message: 'client logs must contain Playwright websocket WorldChange evidence' })
  }
  if (browserNetwork.invalid > 0) {
    failures.push({ check: 's6:playwright-network-format', message: 'Playwright websocket evidence contains invalid Runtime OnChatMessage records' })
  }
  if (browserNetwork.events.length > 0) {
    const networkOrder = browserNetwork.events.map((ev) => ({ key: eventOrderKey(ev), text: ev.text }))
    const runtimeOrder = runtimeObserved.map((ev) => ({ key: eventOrderKey(ev), text: ev.text }))
    if (JSON.stringify(networkOrder) !== JSON.stringify(runtimeOrder)) {
      failures.push({ check: 's6:playwright-network-order', message: 'Playwright websocket WorldChange records must match Runtime records exactly' })
    }
  }
  if (runtimeObserved.length > 0) {
    const runtimeOrder = runtimeObserved.map((ev) => ({ key: eventOrderKey(ev), text: ev.text }))
    const windowOrder = windowLines.map((ev) => ({ key: eventOrderKey(ev), text: ev.text }))
    if (runtimeObserved.length !== windowLines.length || JSON.stringify(runtimeOrder) !== JSON.stringify(windowOrder)) {
      failures.push({
        check: 's6:rpc-event-order',
        message: 'Runtime drain WorldChange.rpcs must exactly match client window event identity, decoded text, and order',
      })
    }
  }

  const runtimeQueries = runtimeDrainQueries(serverEvents).concat(runtimeDrainQueries(clientEvents))
  const queryOutcomes = new Set(runtimeQueries
    .map((query) => typeof query.outcome === 'string' ? query.outcome.toLowerCase() : '')
    .filter(Boolean))
  for (const needed of ['unauthorized', 'invisible', 'stale']) {
    const present = needed === 'stale'
      ? queryOutcomes.has('stale') || queryOutcomes.has('stale_generation')
      : queryOutcomes.has(needed)
    if (!present) {
      failures.push({ check: 's5:missing', message: `logs missing query outcome ${needed}` })
    }
  }
  if (runtimeQueries.length === 0) {
    failures.push({ check: 's5:drain-queries', message: 'Runtime query outcomes must come from drain.queries' })
  }

  const tick = findKind(clientEvents, 'tick') ?? findKind(serverEvents, 'tick')
  const tickSource = tick?.tickSource ?? tick?.tickPath ?? ''
  if (tickSource !== ORACLE_TICK_SOURCE) {
    failures.push({ check: 's6:tick-source', message: `tickSource must be ${ORACLE_TICK_SOURCE}` })
  }
  const cadenceTicks = tick?.utteranceTicks
  if (!Array.isArray(cadenceTicks) || !CLIENT_CADENCE_TICKS.every((t) => cadenceTicks.includes(t))) {
    failures.push({ check: 's6:cadence', message: 'Client Timer Manager trace must include ticks 5,10,15' })
  }
  if (tick && tick.messageType !== 'InputCommand') {
    failures.push({ check: 's6:messageType', message: `messageType=${tick.messageType}, expected InputCommand` })
  }
  if (tick && tick.mappingId !== 'chat.input') {
    failures.push({ check: 's6:mappingId', message: `mappingId=${tick.mappingId}, expected chat.input` })
  }

  if (windowLines.length !== 101) {
    failures.push({ check: 's6:window', message: `client window lines ${windowLines.length}, expected 101` })
  } else {
    for (let i = 1; i < windowLines.length; i++) {
      if (Number(windowLines[i].roomSequence) <= Number(windowLines[i - 1].roomSequence)) {
        failures.push({ check: 's6:roomSequence', message: 'window.lines order must match strictly increasing roomSequence' })
        break
      }
    }
  }

  const snapshot = findKind(serverEvents, 'snapshot')
  const restore = findKind(serverEvents, 'restore') ?? findKind(clientEvents, 'restore')
  if (!snapshot) {
    failures.push({ check: 's7:snapshot-material', message: 'server logs must contain snapshot' })
  }
  if (Number(snapshot?.historyCount ?? snapshot?.historyCountMax ?? 1) !== 0) {
    failures.push({ check: 's7:history', message: `snapshot historyCount=${snapshot?.historyCount}` })
  }
  const restoredWindow = Number(restore?.windowAfter ?? restore?.restoredWindow ?? -1)
  if (restoredWindow !== 0) {
    failures.push({ check: 's7:window-restore', message: 'Restore 后聊天窗必须为空' })
  }
  const pidA = Number(snapshot?.processA ?? snapshot?.pid ?? 0)
  const pidB = Number(restore?.processB ?? restore?.pid ?? 0)
  if (!Number.isInteger(pidA) || !Number.isInteger(pidB) || pidA <= 0 || pidB <= 0 || pidA === pidB) {
    failures.push({ check: 's7:cross-process', message: 'S7 requires host process A persist then process B restore' })
  }
  if (!/^[0-9a-f]{64}$/.test(String(snapshot?.snapshotSha256 ?? restore?.snapshotSha256 ?? ''))) {
    failures.push({ check: 's7:snapshot-file', message: 'S7 snapshot file sha256 missing' })
  }

  const rebind = findKind(serverEvents, 'rebind') ?? findKind(clientEvents, 'rebind')
  const prev = parseSenderNetEntityId(rebind?.previousNetEntityId ?? rebind?.entityA)
  const next = parseSenderNetEntityId(rebind?.netEntityId ?? rebind)
  if (!prev || !next || prev !== next) {
    failures.push({ check: 's8:rebind', message: 'scenario 8 must rebind the same 32-hex NetEntityId' })
  }
  if (!hasKind(serverEvents, 'superseded') && !hasKind(clientEvents, 'superseded')) {
    failures.push({ check: 's8:superseded', message: 'ConnectionSuperseded must be logged on the old connection' })
  }

  const expiry = findKind(serverEvents, 'expire') ?? findKind(clientEvents, 'expire')
  const entityA = parseSenderNetEntityId(expiry?.entityA)
  const entityB = parseSenderNetEntityId(expiry?.entityB)
  if (expiry?.tombstoned !== true) {
    failures.push({ check: 's9:tombstone', message: 'scenario 9 过期后 A 必须 tombstone,B 用新 NetEntityId' })
  }
  if (entityA && entityB && entityA === entityB) {
    failures.push({ check: 's9:new-id', message: 'scenario 9 entity B must use a different host NetEntityId' })
  }

  const deferred = findKind(serverEvents, 'deferred') ?? findKind(clientEvents, 'deferred')
  const deferredReason = String(deferred?.reason ?? deferred?.message ?? '')
  if (!/ADR-058/i.test(deferredReason) || Number(deferred?.scenario ?? 10) !== 10) {
    failures.push({ check: 's10:deferred', message: 'S10 must be deferred (ADR-058 §11), not pass-by-relaxation' })
  }

  if (observed.length !== 101) {
    failures.push({
      check: 's11:synthesized',
      message: 'eventOrder/appliedTicks must contain exactly 101 events from the authoritative observed source',
    })
  }

  const eventOrder = observed.map((ev) => eventOrderKey(ev))
  const appliedTicks = observed.map((ev) => ev.appliedTick)

  return {
    ok: failures.length === 0,
    failures,
    census,
    eventOrder,
    appliedTicks,
    windowLines,
  }
}

export function compareRuns(a, b) {
  const failures = []
  if (!a?.ok) failures.push({ check: 'round-1', message: JSON.stringify(a?.failures ?? []) })
  if (!b?.ok) failures.push({ check: 'round-2', message: JSON.stringify(b?.failures ?? []) })
  if ((a?.census?.botCount !== b?.census?.botCount)
    || (a?.census?.playerCount !== b?.census?.playerCount)
    || (a?.census?.total !== b?.census?.total)) {
    failures.push({ check: 'census-compare', message: 'entity counts differ across runs' })
  }
  const leftOrder = Array.isArray(a?.eventOrder) ? a.eventOrder : []
  const rightOrder = Array.isArray(b?.eventOrder) ? b.eventOrder : []
  if (JSON.stringify(leftOrder) !== JSON.stringify(rightOrder)) {
    failures.push({ check: 'event-order-compare', message: 'event order differs across runs' })
  }
  const leftTicks = Array.isArray(a?.appliedTicks) ? a.appliedTicks : []
  const rightTicks = Array.isArray(b?.appliedTicks) ? b.appliedTicks : []
  if (JSON.stringify(leftTicks) !== JSON.stringify(rightTicks)) {
    failures.push({ check: 'applied-tick-compare', message: 'applied Tick values differ across runs' })
  }
  return { ok: failures.length === 0, failures, round1: a, round2: b }
}

export function verifyEvidenceDir(dir) {
  if (!dir || !existsSync(dir)) {
    return { ok: false, failures: [{ check: 'pack:missing', message: `日志目录不存在: ${dir}` }] }
  }
  const r1 = join(dir, 'round-1')
  const r2 = join(dir, 'round-2')
  if (!existsSync(r1) || !existsSync(r2)) {
    return { ok: false, failures: [{ check: 'pack:rounds', message: '缺少 round-1 / round-2 服务器与客户端日志目录' }] }
  }
  const left = verifyRunFromLogs(resolveRoleDir(r1, 'server'), resolveRoleDir(r1, 'client'))
  const right = verifyRunFromLogs(resolveRoleDir(r2, 'server'), resolveRoleDir(r2, 'client'))
  return compareRuns(left, right)
}

export function senderHex(instanceId, counter) {
  return (u64ToHex16(instanceId) + u64ToHex16(counter)).toLowerCase()
}

function ndjson(rows) {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
}

export function writeOracleMinFixture(dir, { crlf = false, harnessJunk = true, browserNetwork = true } = {}) {
  mkdirSync(join(dir, 'round-1', 'server'), { recursive: true })
  mkdirSync(join(dir, 'round-1', 'client'), { recursive: true })
  mkdirSync(join(dir, 'round-2', 'server'), { recursive: true })
  mkdirSync(join(dir, 'round-2', 'client'), { recursive: true })
  const instanceId = 0x1000000000000001n
  const admits = []
  const events = []
  const rpcs = []
  const windows = []
  for (let i = 1; i <= 101; i++) {
    const hex = senderHex(instanceId, i)
    const entityType = i === 101 ? 'player' : 'bot'
    admits.push({
      kind: 'entity_admitted',
      ts: '2026-09-03T00:00:00Z',
      tick: 1,
      netEntityId: hex,
      entityType,
      roomId: MAIN_ROOM,
    })
    events.push({
      kind: 'chat.event',
      ts: '2026-09-03T00:00:01Z',
      tick: 1,
      messageId: i,
      roomSequence: i,
      senderNetEntityId: hex,
      senderNetEntityIdInstanceId: instanceId.toString(),
      senderNetEntityIdCounter: i,
      text: `hello-${i}`,
      appliedTick: 1,
    })
    rpcs.push({
      target: hex,
      componentId: 'ChatComponent',
      method: 'OnChatMessage',
      sender: hex,
      messageId: i,
      roomSequence: i,
      appliedTick: 1,
      scope: 'room',
      args: [Buffer.from(`hello-${i}`, 'utf8').toString('hex')],
    })
    windows.push({
      kind: 'chat.window',
      phase: 'live',
      roomSequence: i,
      messageId: i,
      senderNetEntityId: hex,
      text: `hello-${i}`,
      appliedTick: 1,
    })
  }
  const extraServer = [
    { kind: 'host', process: 'lumio-entity-chat-replay', pid: 4242 },
    { kind: 'account', wrongPasswordCode: 'wrong_password' },
    {
      kind: 'drain',
      frames: [{ messageType: 'WorldChange', rpcs }],
      queries: [
        { type: 'AttributeQueryResult', requestId: 'query-unauthorized', outcome: 'unauthorized' },
        { type: 'AttributeQueryResult', requestId: 'query-invisible', outcome: 'invisible' },
        { type: 'AttributeQueryResult', requestId: 'query-stale', outcome: 'stale_generation' },
      ],
    },
    {
      kind: 'snapshot',
      historyCount: 0,
      windowBefore: 101,
      processA: 11,
      snapshotSha256: 'b'.repeat(64),
    },
    { kind: 'restore', windowAfter: 0, lastMessageTextEqual: true, processB: 12 },
    { kind: 'superseded', netEntityId: senderHex(instanceId, 100), reason: 'account_already_online' },
    {
      kind: 'rebind',
      netEntityId: senderHex(instanceId, 100),
      previousNetEntityId: senderHex(instanceId, 100),
    },
    {
      kind: 'expire',
      tombstoned: true,
      entityA: senderHex(instanceId, 99),
      entityB: senderHex(instanceId, 102),
      reason: 'retention',
    },
    { kind: 'deferred', scenario: 10, reason: 'ADR-058 §11 multi-room deferred' },
  ]
  const extraClient = [
    {
      kind: 'tick',
      tickSource: ORACLE_TICK_SOURCE,
      utteranceTicks: [...CLIENT_CADENCE_TICKS],
      messageType: 'InputCommand',
      mappingId: 'chat.input',
      payload: '020000006767',
      payloadSha256: '5dbd584f1718b8bcd0dab4abeea83169f4a990defab81a8316ed845798d92dab',
    },
  ]
  if (browserNetwork) {
    extraClient.push({
      kind: 'playwright.network',
      source: 'playwright',
      browser: 'chromium',
      ran: true,
      receivedFromNetwork: true,
      transport: 'websocket',
      direction: 'received',
      messageType: 'WorldChange',
      rpcs,
    })
  }
  const serverText = ndjson([...extraServer, ...admits])
  const clientText = ndjson([...extraClient, ...events, ...windows])
  const toWrite = crlf ? (s) => s.replace(/\n/g, '\r\n') : (s) => s
  for (const round of ['round-1', 'round-2']) {
    writeFileSync(join(dir, round, 'server', 'server.ndjson'), toWrite(serverText))
    writeFileSync(join(dir, round, 'client', 'client.ndjson'), toWrite(clientText))
    if (harnessJunk) {
      writeFileSync(join(dir, round, 'evidence.json'), '{"ok":true,"note":"harness evidence.json must be ignored"}\n')
      writeFileSync(join(dir, round, 'timer-trace.json'), '{"tickSource":"for-loop"}\n')
    }
  }
  return dir
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    out[a.slice(2)] = argv[i + 1]
    i++
  }
  return out
}

function isCliMain() {
  if (!process.argv[1]) return false
  return fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()
}

if (isCliMain() && !process.env.NODE_TEST_CONTEXT) {
  const args = parseArgs(process.argv.slice(2))
  if (args.dir) {
    const report = verifyEvidenceDir(args.dir)
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    process.exit(report.ok ? 0 : 1)
  }
  process.stderr.write('usage: node verify-evidence.mjs --dir <logs>\n')
  process.exit(2)
}

const test = process.env.NODE_TEST_CONTEXT ? nodeTest : () => {}

test('oracleSha256 normalizes CRLF to LF before hashing', () => {
  const lf = 'line-one\nline-two\n'
  const crlf = 'line-one\r\nline-two\r\n'
  withOracleTempDir('sha', (dir) => {
    const lfPath = join(dir, 'lf.txt')
    const crlfPath = join(dir, 'crlf.txt')
    writeFileSync(lfPath, lf)
    writeFileSync(crlfPath, crlf)
    assert.equal(oracleSha256(lfPath), oracleSha256(crlfPath))
    assert.notEqual(
      createHash('sha256').update(readFileSync(crlfPath)).digest('hex'),
      oracleSha256(crlfPath),
    )
  })
})

test('oracle test temp directories are unique and cleaned up', () => {
  let first
  let second
  withOracleTempDir('isolation', (dir) => {
    first = dir
    writeFileSync(join(dir, 'marker.txt'), 'first\n')
  })
  withOracleTempDir('isolation', (dir) => {
    second = dir
    writeFileSync(join(dir, 'marker.txt'), 'second\n')
  })
  assert.notEqual(first, second)
  assert.equal(existsSync(first), false)
  assert.equal(existsSync(second), false)
})

test('parseSenderNetEntityId accepts only the canonical 32-hex string', () => {
  const hex = senderHex(0n, 101n)
  assert.equal(hex, '00000000000000000000000000000065')
  assert.equal(parseSenderNetEntityId(hex), hex)
  assert.equal(parseSenderNetEntityId({ senderNetEntityIdInstanceId: 0, senderNetEntityIdCounter: 101 }), null)
  assert.equal(isHostNetEntityId('101'), false)
  assert.equal(isLauncherLoopIndex('101'), true)
  assert.equal(isHostNetEntityId(hex), true)
})

test('parseSenderNetEntityId: Runtime instanceId 0x1000000000000001 keeps low bit', () => {
  const hex = senderHex(0x1000000000000001n, 0x10n)
  assert.equal(hex, '10000000000000010000000000000010')
  assert.notEqual(hex, '10000000000000000000000000000010')
  assert.equal(
    parseSenderNetEntityId({
      senderNetEntityIdInstanceId: 0x1000000000000001n,
      senderNetEntityIdCounter: 0x10n,
    }),
    null,
  )
})

test('parseSenderNetEntityId rejects uppercase canonical IDs instead of normalizing them', () => {
  const uppercase = 'ABCDEFABCDEFABCDEFABCDEFABCDEFAB'
  assert.equal(parseSenderNetEntityId(uppercase), null)
  assert.equal(isHostNetEntityId(uppercase), false)
})

test('空日志目录必须 FAIL', () => {
  const report = verifyEvidenceDir(join(dirname(oracleFilePath()), 'logs', 'missing-pack'))
  assert.equal(report.ok, false)
})

test('harness evidence.json / timer-trace.json 不是输入', () => {
  withOracleTempDir('evidence-only', (dir) => {
    mkdirSync(join(dir, 'round-1'), { recursive: true })
    mkdirSync(join(dir, 'round-2'), { recursive: true })
    writeFileSync(join(dir, 'round-1', 'evidence.json'), '{"ok":true,"census":{"total":101}}\n')
    writeFileSync(join(dir, 'round-2', 'evidence.json'), '{"ok":true,"census":{"total":101}}\n')
    const report = verifyEvidenceDir(dir)
    assert.equal(report.ok, false)
    assert.ok(report.failures.some((f) => f.check === 'logs:missing' || f.check === 'round-1' || f.check === 'round-2'))
  })
})

test('replay-only logs fail without real Playwright websocket evidence', () => {
  withOracleTempDir('playwright-required', (root) => {
    writeOracleMinFixture(root, { browserNetwork: false })
    const report = verifyEvidenceDir(root)
    assert.equal(report.ok, false)
    assert.ok(report.round1.failures.some((failure) => failure.check === 's6:playwright-network'), JSON.stringify(report.failures))
  })
})

test('Playwright websocket WorldChange evidence must match Runtime RPC identity and order', () => {
  withOracleTempDir('playwright-network-order', (root) => {
    writeOracleMinFixture(root)
    const clientPath = join(root, 'round-1', 'client', 'client.ndjson')
    const rows = parseNdjson(readFileSync(clientPath, 'utf8')).map((record) => record.ev)
    const network = rows.find((ev) => kindOf(ev) === 'playwright.network')
    network.rpcs = [...network.rpcs].reverse()
    writeFileSync(clientPath, ndjson(rows))
    const report = verifyRunFromLogs(join(root, 'round-1', 'server'), clientPath)
    assert.equal(report.ok, false)
    assert.ok(report.failures.some((failure) => failure.check === 's6:playwright-network-order'), JSON.stringify(report.failures))
  })
})

test('Playwright evidence must explicitly attest a real network observation', () => {
  withOracleTempDir('playwright-network-attestation', (root) => {
    writeOracleMinFixture(root)
    const clientPath = join(root, 'round-1', 'client', 'client.ndjson')
    const rows = parseNdjson(readFileSync(clientPath, 'utf8')).map((record) => record.ev)
    const network = rows.find((ev) => kindOf(ev) === 'playwright.network')
    network.receivedFromNetwork = false
    writeFileSync(clientPath, ndjson(rows))
    const report = verifyRunFromLogs(join(root, 'round-1', 'server'), clientPath)
    assert.equal(report.ok, false)
    assert.ok(report.failures.some((failure) => failure.check === 's6:playwright-network-format'), JSON.stringify(report.failures))
  })
})

test('drain.queries are the only accepted Runtime query result source', () => {
  const records = [
    { ev: { kind: 'query', outcome: 'unauthorized' } },
    { ev: { kind: 'drain', frames: [], queries: [{ type: 'AttributeQueryResult', requestId: 'q1', outcome: 'unauthorized' }] } },
  ]
  const queries = runtimeDrainQueries(records)
  assert.deepEqual(queries, [{ type: 'AttributeQueryResult', requestId: 'q1', outcome: 'unauthorized' }])
})

test('fixture --dir 在 LF 与 CRLF 下均为 ok', () => {
  withOracleTempDir('min-lf', (lfDir) => {
    withOracleTempDir('min-crlf', (crlfDir) => {
      writeOracleMinFixture(lfDir, { crlf: false })
      writeOracleMinFixture(crlfDir, { crlf: true })
      const lf = verifyEvidenceDir(lfDir)
      const crlf = verifyEvidenceDir(crlfDir)
      assert.equal(lf.ok, true, JSON.stringify(lf.failures))
      assert.equal(crlf.ok, true, JSON.stringify(crlf.failures))
      assert.equal(JSON.stringify(lf.round1.eventOrder), JSON.stringify(crlf.round1.eventOrder))
    })
  })
})

test('compareRuns 逐位比较 eventOrder 四元组；同多重集不同顺序必须 FAIL', () => {
  withOracleTempDir('min-order', (dir) => {
    writeOracleMinFixture(dir)
    const good = verifyEvidenceDir(dir)
    assert.equal(good.ok, true, JSON.stringify(good.failures))
    const drifted = structuredClone(good.round2)
    const last = drifted.eventOrder[100]
    drifted.eventOrder[100] = drifted.eventOrder[99]
    drifted.eventOrder[99] = last
    const cmp = compareRuns(good.round1, drifted)
    assert.equal(cmp.ok, false)
    assert.ok(cmp.failures.some((f) => f.check === 'event-order-compare'), JSON.stringify(cmp.failures))
  })
})

test('compareRuns appliedTicks 逐值比较；只比长度必须 FAIL', () => {
  withOracleTempDir('min-ticks', (dir) => {
    writeOracleMinFixture(dir)
    const good = verifyEvidenceDir(dir)
    const drifted = structuredClone(good.round2)
    assert.equal(drifted.appliedTicks.length, 101)
    drifted.appliedTicks = drifted.appliedTicks.map((tick, i) => (i === 50 ? tick + 1 : tick))
    const cmp = compareRuns(good.round1, drifted)
    assert.equal(cmp.ok, false)
    assert.ok(cmp.failures.some((f) => f.check === 'applied-tick-compare'), JSON.stringify(cmp.failures))
  })
})

test('committed fixture --dir 为 ok', () => {
  const dir = join(dirname(oracleFilePath()), 'fixtures', 'oracle-min')
  const report = verifyEvidenceDir(dir)
  assert.equal(report.ok, true, JSON.stringify(report.failures))
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const cli = spawnSync(process.execPath, [oracleFilePath(), '--dir', dir], { encoding: 'utf8', env })
  assert.equal(cli.status, 0, (cli.stderr || '') + (cli.stdout || ''))
})

test('101 窗口行来自客户端日志且 roomSequence 严格递增', () => {
  withOracleTempDir('min-window', (dir) => {
    writeOracleMinFixture(dir)
    const report = verifyRunFromLogs(join(dir, 'round-1', 'server'), join(dir, 'round-1', 'client'))
    assert.equal(report.windowLines.length, 101)
    for (let i = 1; i < report.windowLines.length; i++) {
      assert.ok(report.windowLines[i].roomSequence > report.windowLines[i - 1].roomSequence)
    }
  })
})

test('query outcome checks ignore requestId text and require the formal outcome field', () => {
  withOracleTempDir('query-outcome-field', (root) => {
    const serverPath = join(root, 'server', 'server.ndjson')
    const clientPath = join(root, 'client', 'client.ndjson')
    mkdirSync(dirname(serverPath), { recursive: true })
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(serverPath, ndjson([
      { kind: 'host', process: 'lumio-entity-chat-replay' },
      { kind: 'drain', frames: [], queries: [
        { requestId: 'query-unauthorized', outcome: 'ok' },
        { requestId: 'query-invisible', outcome: 'ok' },
        { requestId: 'query-stale', outcome: 'ok' },
      ] },
    ]))
    writeFileSync(clientPath, '')
    const report = verifyRunFromLogs(join(root, 'server'), join(root, 'client'))
    assert.ok(report.failures.filter((failure) => failure.check === 's5:missing').length >= 3)
  })
})

test('verifyRunFromLogs rejects BotEntity and PlayerEntity wire aliases', () => {
  withOracleTempDir('entity-type-alias', (root) => {
    writeOracleMinFixture(root)
    const serverPath = join(root, 'round-1', 'server', 'server.ndjson')
    const rows = parseNdjson(readFileSync(serverPath, 'utf8')).map((record) => record.ev)
    rows.find((ev) => kindOf(ev) === 'entity_admitted').entityType = 'BotEntity'
    writeFileSync(serverPath, ndjson(rows))
    const report = verifyRunFromLogs(serverPath, join(root, 'round-1', 'client'))
    assert.equal(report.ok, false)
    assert.ok(report.failures.some((failure) => failure.check === 'census:bots'), JSON.stringify(report.failures))
  })
})

test('parseNdjson preserves malformed and non-object records for fail-closed verification', () => {
  const records = parseNdjson('{"kind":"ok"}\n[]\nnot-json\n')
  assert.equal(records.length, 3)
  assert.deepEqual(records[0], { line: 1, ev: { kind: 'ok' } })
  assert.equal(records[1].line, 2)
  assert.equal(records[1].ev, null)
  assert.equal(records[1].error, 'record_not_object')
  assert.equal(records[2].line, 3)
  assert.equal(records[2].ev, null)
  assert.equal(records[2].error, 'malformed_json')
})

test('verifyRunFromLogs rejects malformed and non-object log records', () => {
  withOracleTempDir('malformed-record', (root) => {
    writeOracleMinFixture(root)
    writeFileSync(join(root, 'round-1', 'server', 'server.ndjson'), '[]\n{"kind":"host","process":"lumio-entity-chat-replay"}\n')
    const report = verifyRunFromLogs(join(root, 'round-1', 'server'), join(root, 'round-1', 'client'))
    assert.equal(report.ok, false)
    assert.ok(report.failures.some((failure) => failure.check === 'logs:malformed'))
  })
})

test('verifyRunFromLogs rejects non-object Runtime drain records', () => {
  withOracleTempDir('malformed-drain', (root) => {
    writeOracleMinFixture(root)
    const serverPath = join(root, 'round-1', 'server', 'server.ndjson')
    writeFileSync(serverPath, readFileSync(serverPath, 'utf8') + '{"kind":"drain","frames":[],"queries":[null]}\n')
    const report = verifyRunFromLogs(serverPath, join(root, 'round-1', 'client'))
    assert.equal(report.ok, false)
    assert.ok(report.failures.some((failure) => failure.check === 'logs:malformed' && failure.message.includes('drain.queries[0]')))
  })
})

function appendClientRuntimeRpcDrain(root, round, mutate = (rpcs) => rpcs) {
  const clientPath = join(root, round, 'client', 'client.ndjson')
  const received = parseNdjson(readFileSync(clientPath, 'utf8'))
    .map((record) => record.ev)
    .filter((ev) => kindOf(ev) === 'chat.window' && ev.phase === 'live')
  const rpcs = received.map((ev) => ({
    target: ev.senderNetEntityId,
    componentId: 'ChatComponent',
    method: 'OnChatMessage',
    sender: ev.senderNetEntityId,
    messageId: ev.messageId,
    roomSequence: ev.roomSequence,
    appliedTick: ev.appliedTick,
    scope: 'room',
    args: [Buffer.from(ev.text, 'utf8').toString('hex')],
  }))
  const drain = {
    kind: 'drain',
    frames: [{ messageType: 'WorldChange', rpcs: mutate(rpcs) }],
    queries: [],
  }
  writeFileSync(clientPath, readFileSync(clientPath, 'utf8') + JSON.stringify(drain) + '\n')
}

function mutateServerRuntimeRpcDrain(root, round, mutate) {
  const serverPath = join(root, round, 'server', 'server.ndjson')
  const rows = parseNdjson(readFileSync(serverPath, 'utf8')).map((record) => record.ev)
  const drain = rows.find((ev) => kindOf(ev) === 'drain')
  const frame = drain.frames.find((candidate) => candidate.messageType === 'WorldChange')
  frame.rpcs = mutate(frame.rpcs)
  writeFileSync(serverPath, ndjson(rows))
}

function clearServerRuntimeFrames(root, round) {
  const serverPath = join(root, round, 'server', 'server.ndjson')
  const rows = parseNdjson(readFileSync(serverPath, 'utf8')).map((record) => record.ev)
  const drain = rows.find((ev) => kindOf(ev) === 'drain')
  drain.frames = []
  writeFileSync(serverPath, ndjson(rows))
}

test('Runtime drain WorldChange.rpcs are authoritative without double counting direct chat events', () => {
  withOracleTempDir('rpc-authority', (root) => {
    writeOracleMinFixture(root)
    for (const round of ['round-1', 'round-2']) {
      clearServerRuntimeFrames(root, round)
      appendClientRuntimeRpcDrain(root, round)
    }
    const report = verifyEvidenceDir(root)
    assert.equal(report.ok, true, JSON.stringify(report.failures))
    assert.equal(report.round1.eventOrder.length, 101)
    assert.equal(report.round1.appliedTicks.length, 101)
  })
})

test('an observed Runtime WorldChange.rpcs sequence cannot fall back to direct chat events', () => {
  withOracleTempDir('rpc-empty', (root) => {
    writeOracleMinFixture(root)
    mutateServerRuntimeRpcDrain(root, 'round-1', () => [])
    const report = verifyRunFromLogs(join(root, 'round-1', 'server'), join(root, 'round-1', 'client'))
    assert.equal(report.ok, false)
    assert.ok(report.failures.some((failure) => failure.check === 's11:synthesized'), JSON.stringify(report.failures))
  })
})

test('Runtime OnChatMessage evidence rejects missing args even when rpc.text is present', () => {
  withOracleTempDir('rpc-missing-args', (root) => {
    writeOracleMinFixture(root)
    mutateServerRuntimeRpcDrain(root, 'round-1', (rpcs) => {
      const changed = structuredClone(rpcs)
      changed[0].text = 'hello-1'
      delete changed[0].args
      return changed
    })
    const report = verifyRunFromLogs(join(root, 'round-1', 'server'), join(root, 'round-1', 'client'))
    assert.equal(report.ok, false)
    assert.ok(report.failures.some((failure) => failure.check === 's3:runtime-rpc-format'), JSON.stringify(report.failures))
  })
})

test('Runtime OnChatMessage evidence rejects non-hex args even when rpc.text is present', () => {
  withOracleTempDir('rpc-non-hex-args', (root) => {
    writeOracleMinFixture(root)
    mutateServerRuntimeRpcDrain(root, 'round-1', (rpcs) => {
      const changed = structuredClone(rpcs)
      changed[0].args = ['not-hex']
      changed[0].text = 'hello-1'
      return changed
    })
    const report = verifyRunFromLogs(join(root, 'round-1', 'server'), join(root, 'round-1', 'client'))
    assert.equal(report.ok, false)
    assert.ok(report.failures.some((failure) => failure.check === 's3:runtime-rpc-format'), JSON.stringify(report.failures))
  })
})

test('Runtime OnChatMessage evidence requires lowercase hex args', () => {
  withOracleTempDir('rpc-uppercase-args', (root) => {
    writeOracleMinFixture(root)
    mutateServerRuntimeRpcDrain(root, 'round-1', (rpcs) => {
      const changed = structuredClone(rpcs)
      changed[0].args[0] = changed[0].args[0].toUpperCase()
      return changed
    })
    const report = verifyRunFromLogs(join(root, 'round-1', 'server'), join(root, 'round-1', 'client'))
    assert.equal(report.ok, false)
    assert.ok(report.failures.some((failure) => failure.check === 's3:runtime-rpc-format'), JSON.stringify(report.failures))
  })
})

test('Runtime OnChatMessage evidence rejects invalid UTF-8 instead of replacement text', () => {
  withOracleTempDir('rpc-invalid-utf8', (root) => {
    writeOracleMinFixture(root)
    mutateServerRuntimeRpcDrain(root, 'round-1', (rpcs) => {
      const changed = structuredClone(rpcs)
      changed[0].args[0] = 'c3'
      return changed
    })
    const report = verifyRunFromLogs(join(root, 'round-1', 'server'), join(root, 'round-1', 'client'))
    assert.equal(report.ok, false)
    assert.ok(report.failures.some((failure) => failure.check === 's3:runtime-rpc-format'), JSON.stringify(report.failures))
  })
})

test('Runtime OnChatMessage evidence requires the formal target field', () => {
  withOracleTempDir('rpc-missing-target', (root) => {
    writeOracleMinFixture(root)
    mutateServerRuntimeRpcDrain(root, 'round-1', (rpcs) => {
      const changed = structuredClone(rpcs)
      delete changed[0].target
      return changed
    })
    const report = verifyRunFromLogs(join(root, 'round-1', 'server'), join(root, 'round-1', 'client'))
    assert.equal(report.ok, false)
    assert.ok(report.failures.some((failure) => failure.check === 's3:runtime-rpc-format'), JSON.stringify(report.failures))
  })
})

test('Runtime OnChatMessage evidence requires the formal scope field', () => {
  withOracleTempDir('rpc-missing-scope', (root) => {
    writeOracleMinFixture(root)
    mutateServerRuntimeRpcDrain(root, 'round-1', (rpcs) => {
      const changed = structuredClone(rpcs)
      delete changed[0].scope
      return changed
    })
    const report = verifyRunFromLogs(join(root, 'round-1', 'server'), join(root, 'round-1', 'client'))
    assert.equal(report.ok, false)
    assert.ok(report.failures.some((failure) => failure.check === 's3:runtime-rpc-format'), JSON.stringify(report.failures))
  })
})

test('Runtime decoded RPC text must match the corresponding client window event', () => {
  withOracleTempDir('rpc-window-text', (root) => {
    writeOracleMinFixture(root)
    mutateServerRuntimeRpcDrain(root, 'round-1', (rpcs) => {
      const changed = structuredClone(rpcs)
      changed[0].args[0] = Buffer.from('tampered', 'utf8').toString('hex')
      return changed
    })
    const report = verifyRunFromLogs(join(root, 'round-1', 'server'), join(root, 'round-1', 'client'))
    assert.equal(report.ok, false)
    assert.ok(report.failures.some((failure) => failure.check === 's6:rpc-event-order'), JSON.stringify(report.failures))
  })
})

test('client chat.event records cannot replace Runtime WorldChange.rpcs evidence', () => {
  withOracleTempDir('rpc-required', (root) => {
    writeOracleMinFixture(root)
    clearServerRuntimeFrames(root, 'round-1')
    const report = verifyRunFromLogs(join(root, 'round-1', 'server'), join(root, 'round-1', 'client'))
    assert.equal(report.ok, false)
    assert.ok(report.failures.some((failure) => failure.check === 's3:runtime-rpc'), JSON.stringify(report.failures))
  })
})

test('Runtime drain WorldChange.rpcs require strictly increasing roomSequence', () => {
  withOracleTempDir('rpc-sequence', (root) => {
    writeOracleMinFixture(root)
    for (const round of ['round-1', 'round-2']) {
      mutateServerRuntimeRpcDrain(root, round, (rpcs) => {
        const swapped = [...rpcs]
        const earlier = swapped[49]
        swapped[49] = swapped[50]
        swapped[50] = earlier
        return swapped
      })
    }
    const report = verifyRunFromLogs(join(root, 'round-1', 'server'), join(root, 'round-1', 'client'))
    assert.equal(report.ok, false)
    assert.ok(report.failures.some((failure) => failure.check === 's6:rpc-roomSequence'), JSON.stringify(report.failures))
  })
})

test('Runtime RPC C-1 counters reject non-canonical numeric mutations', () => {
  const mutations = [
    ['messageId', -1],
    ['roomSequence', 1.5],
    ['appliedTick', Number.MAX_SAFE_INTEGER + 1],
  ]
  for (const [field, value] of mutations) {
    withOracleTempDir(`rpc-counter-${field}`, (root) => {
      writeOracleMinFixture(root)
      mutateServerRuntimeRpcDrain(root, 'round-1', (rpcs) => {
        const changed = structuredClone(rpcs)
        changed[0][field] = value
        return changed
      })
      const report = verifyRunFromLogs(join(root, 'round-1', 'server'), join(root, 'round-1', 'client'))
      assert.equal(report.ok, false)
      assert.ok(report.failures.some((failure) => failure.check === 's3:runtime-rpc-format'), JSON.stringify(report.failures))
    })
  }
})

test('Runtime RPC C-1 counters reject NaN and Infinity', () => {
  const base = {
    target: senderHex(1n, 1n),
    componentId: 'ChatComponent',
    method: 'OnChatMessage',
    sender: senderHex(1n, 1n),
    messageId: 1,
    roomSequence: 1,
    appliedTick: 1,
    scope: 'room',
    args: [Buffer.from('hello', 'utf8').toString('hex')],
  }
  for (const field of ['messageId', 'roomSequence', 'appliedTick']) {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(chatEventFromRpc({ ...base, [field]: value }), null, `${field}=${value}`)
    }
  }
})

test('Runtime RPC C-1 roomSequence rejects duplicate mutations', () => {
  withOracleTempDir('rpc-sequence-duplicate', (root) => {
    writeOracleMinFixture(root)
    mutateServerRuntimeRpcDrain(root, 'round-1', (rpcs) => {
      const changed = structuredClone(rpcs)
      changed[1].roomSequence = changed[0].roomSequence
      return changed
    })
    const report = verifyRunFromLogs(join(root, 'round-1', 'server'), join(root, 'round-1', 'client'))
    assert.equal(report.ok, false)
    assert.ok(report.failures.some((failure) => failure.check === 's6:rpc-roomSequence'), JSON.stringify(report.failures))
  })
})

test('Runtime drain WorldChange.rpcs must exactly match received event identity and order', () => {
  withOracleTempDir('rpc-identity', (root) => {
    writeOracleMinFixture(root)
    for (const round of ['round-1', 'round-2']) {
      mutateServerRuntimeRpcDrain(root, round, (rpcs) => {
        const changed = structuredClone(rpcs)
        const earlierSender = changed[49].sender
        changed[49].sender = changed[50].sender
        changed[50].sender = earlierSender
        return changed
      })
    }
    const report = verifyRunFromLogs(join(root, 'round-1', 'server'), join(root, 'round-1', 'client'))
    assert.equal(report.ok, false)
    assert.ok(report.failures.some((failure) => failure.check === 's6:rpc-event-order'), JSON.stringify(report.failures))
  })
})

test('Runtime RPC evidence cannot replace missing client window events', () => {
  withOracleTempDir('rpc-window-required', (root) => {
    writeOracleMinFixture(root)
    for (const round of ['round-1', 'round-2']) {
      clearServerRuntimeFrames(root, round)
      appendClientRuntimeRpcDrain(root, round)
      const clientPath = join(root, round, 'client', 'client.ndjson')
      const rows = parseNdjson(readFileSync(clientPath, 'utf8'))
        .map((record) => record.ev)
        .filter((ev) => kindOf(ev) !== 'chat.window')
      writeFileSync(clientPath, ndjson(rows))
    }
    const report = verifyEvidenceDir(root)
    assert.equal(report.ok, false)
    assert.ok(report.round1.failures.some((failure) => failure.check === 's6:window'), JSON.stringify(report.failures))
  })
})

test('census excludes the Runtime WorldEntity from player and total counts', () => {
  const records = [{ ev: {
    kind: 'drain',
    frames: [{
      messageType: 'WorldChange',
      creates: [
        { entityType: 'world', netEntityId: senderHex(1n, 1n), fields: [] },
        { entityType: 'player', netEntityId: senderHex(1n, 2n), fields: [] },
      ],
    }],
    queries: [],
  } }]
  assert.deepEqual(censusFromServerLogs(records), {
    botCount: 0,
    playerCount: 1,
    total: 1,
    netEntityIds: [senderHex(1n, 2n)],
  })
})
