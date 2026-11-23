import { describe, expect, it } from 'vitest'
import { parseIntegerAmount } from '../src/api/loan-derived.js'

describe('parseIntegerAmount', () => {
  it('parses valid integer strings', () => {
    expect(parseIntegerAmount('0')).toBe(0n)
    expect(parseIntegerAmount('123')).toBe(123n)
    expect(parseIntegerAmount('-456')).toBe(-456n)
    expect(parseIntegerAmount('999999999999999999999999999999')).toBe(999999999999999999999999999999n)
  })

  it('parses safe integers as numbers', () => {
    expect(parseIntegerAmount(0)).toBe(0n)
    expect(parseIntegerAmount(123)).toBe(123n)
    expect(parseIntegerAmount(-456)).toBe(-456n)
    expect(parseIntegerAmount(Number.MAX_SAFE_INTEGER)).toBe(BigInt(Number.MAX_SAFE_INTEGER))
  })

  it('returns null for unsafe numbers', () => {
    expect(parseIntegerAmount(Number.MAX_SAFE_INTEGER + 1)).toBeNull()
    expect(parseIntegerAmount(1.5)).toBeNull()
    expect(parseIntegerAmount(NaN)).toBeNull()
    expect(parseIntegerAmount(Infinity)).toBeNull()
    expect(parseIntegerAmount(-Infinity)).toBeNull()
  })

  it('returns null for invalid string formats', () => {
    expect(parseIntegerAmount('100.00')).toBeNull()
    expect(parseIntegerAmount('1.5')).toBeNull()
    expect(parseIntegerAmount('abc')).toBeNull()
    expect(parseIntegerAmount('')).toBeNull()
    expect(parseIntegerAmount(' ')).toBeNull()
    expect(parseIntegerAmount('1e5')).toBeNull()
    expect(parseIntegerAmount('1.23e10')).toBeNull()
    expect(parseIntegerAmount('0x123')).toBeNull()
    expect(parseIntegerAmount('123n')).toBeNull()
  })

  it('returns null for non-string non-number types', () => {
    expect(parseIntegerAmount(null)).toBeNull()
    expect(parseIntegerAmount(undefined)).toBeNull()
    expect(parseIntegerAmount({})).toBeNull()
    expect(parseIntegerAmount([])).toBeNull()
    expect(parseIntegerAmount(true)).toBeNull()
    expect(parseIntegerAmount(false)).toBeNull()
  })

  describe('fuzz testing: random inputs (issue #195)', () => {
    it('never throws on 10,000 random strings', () => {
      const samples = 10000
      for (let i = 0; i < samples; i++) {
        const input = generateRandomString()
        expect(() => parseIntegerAmount(input)).not.toThrow()
        const result = parseIntegerAmount(input)
        expect(result === null || typeof result === 'bigint').toBe(true)
      }
    })

    it('never throws on random floating-point numbers', () => {
      const samples = 10000
      for (let i = 0; i < samples; i++) {
        const input = Math.random() * Number.MAX_VALUE * (Math.random() > 0.5 ? 1 : -1)
        expect(() => parseIntegerAmount(input)).not.toThrow()
        const result = parseIntegerAmount(input)
        expect(result === null || typeof result === 'bigint').toBe(true)
      }
    })

    it('never throws on extreme BigInt-like strings', () => {
      const samples = 10000
      for (let i = 0; i < samples; i++) {
        const input = generateExtremeBigIntString()
        expect(() => parseIntegerAmount(input)).not.toThrow()
        const result = parseIntegerAmount(input)
        expect(result === null || typeof result === 'bigint').toBe(true)
      }
    })

    it('never throws on scientific notation strings', () => {
      const samples = 1000
      for (let i = 0; i < samples; i++) {
        const input = `${Math.random() * 1000}e${Math.floor(Math.random() * 100) - 50}`
        expect(() => parseIntegerAmount(input)).not.toThrow()
        const result = parseIntegerAmount(input)
        expect(result === null || typeof result === 'bigint').toBe(true)
      }
    })

    it('never throws on Unicode and special characters', () => {
      const samples = 5000
      const specialChars = [
        '\u0000', '\n', '\r', '\t', '\u200B', '\uFEFF', // whitespace/control
        '٠', '١', '٢', '٣', '٤', '٥', // Arabic-Indic digits
        '𝟎', '𝟏', '𝟐', '𝟑', '𝟒', '𝟓', // Mathematical bold digits
        '①', '②', '③', '④', // Circled numbers
        '½', '¼', '¾', // Fractions
        '∞', '±', '×', '÷', // Math symbols
      ]
      for (let i = 0; i < samples; i++) {
        const input = specialChars[Math.floor(Math.random() * specialChars.length)] +
          generateRandomString() +
          specialChars[Math.floor(Math.random() * specialChars.length)]
        expect(() => parseIntegerAmount(input)).not.toThrow()
        const result = parseIntegerAmount(input)
        expect(result === null || typeof result === 'bigint').toBe(true)
      }
    })

    it('never throws on special numeric values', () => {
      const specialValues = [
        NaN,
        Infinity,
        -Infinity,
        Number.MAX_VALUE,
        Number.MIN_VALUE,
        Number.MAX_SAFE_INTEGER,
        Number.MIN_SAFE_INTEGER,
        Number.EPSILON,
        0,
        -0,
        1 / 0,
        -1 / 0,
        0 / 0,
      ]
      for (const input of specialValues) {
        expect(() => parseIntegerAmount(input)).not.toThrow()
        const result = parseIntegerAmount(input)
        expect(result === null || typeof result === 'bigint').toBe(true)
      }
    })

    it('never throws on mixed valid/invalid patterns', () => {
      const samples = 5000
      const patterns = [
        () => `${Math.floor(Math.random() * 1000)}.${Math.floor(Math.random() * 1000)}`,
        () => `-${Math.random()}`,
        () => `+${Math.floor(Math.random() * 1000)}`,
        () => ` ${Math.floor(Math.random() * 1000)} `,
        () => `0${'0'.repeat(Math.floor(Math.random() * 50))}${Math.floor(Math.random() * 1000)}`,
        () => Array.from({ length: Math.floor(Math.random() * 100) }, () => Math.floor(Math.random() * 10)).join(''),
        () => `${Math.random() > 0.5 ? '-' : ''}${Array.from({ length: 50 }, () => Math.floor(Math.random() * 10)).join('')}`,
      ]
      for (let i = 0; i < samples; i++) {
        const pattern = patterns[Math.floor(Math.random() * patterns.length)]
        const input = pattern?.()
        expect(() => parseIntegerAmount(input)).not.toThrow()
        const result = parseIntegerAmount(input)
        expect(result === null || typeof result === 'bigint').toBe(true)
      }
    })
  })
})

// Helper: generate random strings with various characters
function generateRandomString(): string {
  const length = Math.floor(Math.random() * 100)
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,.<>?/~`\n\r\t '
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

// Helper: generate extreme BigInt-like strings (valid and invalid)
function generateExtremeBigIntString(): string {
  const length = Math.floor(Math.random() * 200) + 1
  const sign = Math.random() > 0.7 ? '-' : ''
  const digits = Array.from({ length }, () => Math.floor(Math.random() * 10)).join('')
  // Sometimes add invalid characters to test robustness
  if (Math.random() > 0.8) {
    const insertPos = Math.floor(Math.random() * digits.length)
    const invalidChar = ['e', '.', 'n', ' ', '_'][Math.floor(Math.random() * 5)]
    return sign + digits.slice(0, insertPos) + invalidChar + digits.slice(insertPos)
  }
  return sign + digits
}
