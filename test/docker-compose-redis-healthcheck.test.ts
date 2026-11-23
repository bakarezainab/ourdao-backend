import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

// Issue #610: the `redis` service had no healthcheck at all, unlike `db` --
// docker compose ps/inspect had no way to tell a Redis container that
// started but isn't accepting connections yet from one that's genuinely
// ready. No YAML parser dependency needed here (same reasoning as
// test/config-env-example.test.ts's plain-text .env.example check): this
// only needs to confirm the `redis:` service block itself, not interpret
// the whole compose file's structure.
describe('docker-compose.yml: redis service healthcheck (issue #610)', () => {
  it("gives redis a healthcheck, matching db's interval/timeout/retries style", () => {
    const compose = readFileSync(`${root}/docker-compose.yml`, 'utf8')

    const redisBlock = /^ {2}redis:\n(?: {4}.*\n)+/m.exec(compose)?.[0]
    expect(redisBlock, 'redis service block not found in docker-compose.yml').toBeTruthy()

    expect(redisBlock).toMatch(/healthcheck:/)
    expect(redisBlock).toMatch(/redis-cli/)
    expect(redisBlock).toMatch(/ping/)
    expect(redisBlock).toMatch(/interval:\s*5s/)
    expect(redisBlock).toMatch(/timeout:\s*5s/)
    expect(redisBlock).toMatch(/retries:\s*5/)
  })
})
