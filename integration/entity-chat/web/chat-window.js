// Browser chat-window presentation for the R-00354 harness.
// Chat-window contents are client-only; they are never restored from Snapshot.
// Wire field names follow the Architecture C-1 WorldChange ClientRpc record.

export function createChatWindow() {
  return { lines: [] }
}

export function appendAcceptedEvent(window, event) {
  if (!isEvent(event)) return false
  const last = window.lines.length === 0 ? null : window.lines[window.lines.length - 1]
  if (last !== null && (event.roomSequence <= last.roomSequence || event.messageId <= last.messageId)) {
    return false
  }
  window.lines = window.lines.concat([
    Object.freeze({
      messageId: event.messageId,
      roomSequence: event.roomSequence,
      senderNetEntityId: String(event.senderNetEntityId),
      text: event.text,
      appliedTick: event.appliedTick,
    }),
  ])
  return true
}

export function formatLine(event) {
  return `${event.senderNetEntityId}: ${event.text}`
}

export function extractChatEventsFromFrame(frame) {
  if (frame == null) return []
  let parsed = frame
  if (typeof frame === 'string') {
    try { parsed = JSON.parse(frame) } catch { return [] }
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  if (parsed.messageType !== 'WorldChange' || !Array.isArray(parsed.rpcs)) return []
  const events = []
  for (const rpc of parsed.rpcs) {
    const event = chatEventFromRpc(rpc)
    if (event) events.push(event)
  }
  return events
}

function decodeRpcText(args) {
  if (!Array.isArray(args) || args.length === 0 || typeof args[0] !== 'string') return null
  const hex = args[0]
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function chatEventFromRpc(rpc) {
  if (rpc == null || typeof rpc !== 'object') return null
  if (rpc.componentId !== 'ChatComponent' || rpc.method !== 'OnChatMessage') return null
  if (typeof rpc.target !== 'string' || !/^[0-9a-f]{32}$/.test(rpc.target)) return null
  if (rpc.scope !== 'room') return null
  if (typeof rpc.sender !== 'string' || !/^[0-9a-f]{32}$/.test(rpc.sender)) return null
  if (!Number.isSafeInteger(rpc.messageId) || rpc.messageId < 0) return null
  if (!Number.isSafeInteger(rpc.roomSequence) || rpc.roomSequence < 0) return null
  if (!Number.isSafeInteger(rpc.appliedTick) || rpc.appliedTick < 0) return null
  const text = decodeRpcText(rpc.args)
  if (text == null) return null
  return {
    messageId: rpc.messageId,
    roomSequence: rpc.roomSequence,
    senderNetEntityId: rpc.sender.toLowerCase(),
    text,
    appliedTick: rpc.appliedTick,
  }
}

function isEvent(event) {
  return event !== null
    && typeof event === 'object'
    && Number.isSafeInteger(event.messageId)
    && event.messageId >= 0
    && Number.isSafeInteger(event.roomSequence)
    && event.roomSequence >= 0
    && typeof event.senderNetEntityId === 'string'
    && /^[0-9a-f]{32}$/i.test(event.senderNetEntityId)
    && typeof event.text === 'string'
    && Number.isSafeInteger(event.appliedTick)
    && event.appliedTick >= 0
}
