import { describe, expect, it } from 'vitest'
import { classifyLicense } from '../scripts/check-licenses.js'

// Issue #487: the license policy in docs/DEPENDENCY-LICENSES.md had no unit
// coverage, so a change to the approved list or the self-package exclusion
// could silently stop enforcing it.
describe('check-licenses classifyLicense (issue #487)', () => {
  it.each([
    'MIT',
    'ISC',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'BlueOak-1.0.0',
    'MPL-2.0',
    'CC0-1.0',
    'CC-BY-3.0',
    '(MIT AND CC-BY-3.0)',
  ])('approves %s', (license) => {
    expect(classifyLicense('some-dep@1.0.0', license)).toBeNull()
  })

  it.each(['GPL-2.0', 'GPL-3.0', 'LGPL-2.0', 'LGPL-3.0', 'AGPL-3.0', 'UNLICENSED'])('rejects %s', (license) => {
    expect(classifyLicense('some-dep@1.0.0', license)).toMatch(/Disallowed license/)
  })

  it('rejects a dependency with no license information', () => {
    expect(classifyLicense('some-dep@1.0.0', undefined)).toMatch(/Disallowed license: UNLICENSED/)
    expect(classifyLicense('some-dep@1.0.0', '')).toMatch(/Disallowed license: UNLICENSED/)
  })

  it('flags an unknown license for review', () => {
    expect(classifyLicense('some-dep@1.0.0', 'WTFPL')).toMatch(/not on approved list/)
  })

  it('exempts this repository from the UNLICENSED check only', () => {
    expect(classifyLicense('ourdao-backend@0.1.0', 'UNLICENSED')).toBeNull()
    expect(classifyLicense('ourdao-backend@0.1.0', undefined)).toBeNull()
    expect(classifyLicense('ourdao-backend@0.1.0', 'GPL-3.0')).toMatch(/Disallowed license/)
  })
})
