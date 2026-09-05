import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendAcceptedEvent,
  applyFullSnapshot,
  createChatWindow,
  extractChatEventsFromFrame,
  formatLine,
} from './chat-window.js'

const GG_SENDER = '00000000000000000000000000000065'

function canonicalWorldChange(rpcs) {
  return {
    messageType: 'WorldChange',
    tick: 7,
    creates: [],
    fields: [],
    destroys: [],
    rpcs,
  }
}

function canonicalChatRpc({ messageId, roomSequence, sender, text }) {
  return {
    target: sender,
    componentId: 'ChatComponent',
    method: 'OnChatMessage',
    args: [Buffer.from(text, 'utf8').toString('hex')],
    messageId,
    roomSequence,
    sender,
    appliedTick: 7,
    scope: 'room',
  }
}

test('extractChatEventsFromFrame reads ordered ChatComponent.OnChatMessage RPCs from WorldChange', () => {
  const firstSender = '00000000000000010000000000000065'
  const secondSender = '00000000000000010000000000000066'
  const events = extractChatEventsFromFrame(canonicalWorldChange([
    canonicalChatRpc({ messageId: 1, roomSequence: 1, sender: firstSender, text: 'first' }),
    canonicalChatRpc({ messageId: 2, roomSequence: 2, sender: secondSender, text: 'second' }),
  ]))
  assert.deepEqual(events, [
    { messageId: 1, roomSequence: 1, senderNetEntityId: firstSender, text: 'first', appliedTick: 7 },
    { messageId: 2, roomSequence: 2, senderNetEntityId: secondSender, text: 'second', appliedTick: 7 },
  ])
})

test('applyFullSnapshot clears the client-only window', () => {
  const window = createChatWindow()
  appendAcceptedEvent(window, {
    messageId: 1,
    roomSequence: 1,
    senderNetEntityId: GG_SENDER,
    text: 'gg',
    appliedTick: 7,
  })
  applyFullSnapshot(window)
  assert.equal(window.lines.length, 0)
})

test('formatLine uses sender and text', () => {
  assert.equal(formatLine({ senderNetEntityId: GG_SENDER, text: 'gg' }), `${GG_SENDER}: gg`)
})
