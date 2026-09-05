import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const LAUNCHER = join(SCRIPT_DIR, 'launcher.mjs')

test('launcher CLI loads the formal verifier before missing-replay handling', () => {
  const root = mkdtempSync(join(tmpdir(), 'lumio-entity-chat-launcher-'))
  const out = join(root, 'evidence')
  const env = {
    ...process.env,
    LUMIO_SERVER_ROOT: join(root, 'missing-server'),
    LUMIO_ENTITY_CHAT_REPLAY: join(root, 'missing-replay'),
  }
  delete env.NODE_TEST_CONTEXT

  try {
    const result = spawnSync(process.execPath, [LAUNCHER, '--out', out], { encoding: 'utf8', env })
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    assert.equal(result.status, 1, output)
    assert.match(result.stdout ?? '', /entity-chat launcher, evidence /, output)
    assert.match(result.stderr ?? '', /BLOCKED missing lumio-entity-chat-replay/, output)
    assert.doesNotMatch(output, /does not provide an export named ['"]verifyRun['"]/, output)
    assert.equal(JSON.parse(readFileSync(join(out, 'blocked.json'), 'utf8')).status, 'BLOCKED')
    assert.equal(existsSync(join(out, 'manifest.json')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
