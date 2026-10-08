import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { agentTarget, entryFromArgs } from '../src/doctor.ts'

test('the registered server path survives spaces in the folder name', () => {
  assert.equal(
    entryFromArgs('--disable-warning=ExperimentalWarning /Users/ana/My Projects/wsp mcp/src/mcp.ts'),
    '/Users/ana/My Projects/wsp mcp/src/mcp.ts',
  )
  assert.equal(entryFromArgs('/opt/wsp-mcp/src/mcp.ts'), '/opt/wsp-mcp/src/mcp.ts')
  assert.equal(entryFromArgs('some-other-server --port 3000'), undefined)
})

test('the agent plist tells which copy of the code it runs', () => {
  const plist = join(mkdtempSync(join(tmpdir(), 'wsp-mcp-test-')), 'agent.plist')
  writeFileSync(
    plist,
    `<plist><dict><key>ProgramArguments</key><array>
      <string>/usr/local/bin/node</string>
      <string>--disable-warning=ExperimentalWarning</string>
      <string>/Users/ana/My Projects/wsp-mcp/src/bridge.ts</string>
    </array></dict></plist>`,
  )
  assert.equal(agentTarget(plist, '/src/bridge.ts'), '/Users/ana/My Projects/wsp-mcp/src/bridge.ts')
  assert.equal(agentTarget(plist, '/build/whatsapp-status'), undefined)
  assert.equal(agentTarget(join(tmpdir(), 'no-such.plist'), '/src/bridge.ts'), undefined)
})
