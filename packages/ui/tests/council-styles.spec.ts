/** Motion and narrow-layout rules for the original chamber artwork. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/CouncilPage.module.css', import.meta.url), 'utf8')
it('enables flicker only when reduced motion is not requested', () => {
  expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.hologram\s*\{\s*animation: hologram-flicker/)
  expect(css.match(/animation:/g)).toHaveLength(1)
})
it('puts seats below the scene in narrow containers and preserves macOS clearance', () => {
  expect(css).toContain('@container council (max-width: 899px)')
  expect(css).toMatch(/\.seat, \.seat\[data-chair\] \{ position: relative; top: auto; left: auto;/)
  expect(css).toContain("[data-platform='darwin']")
  expect(css).toContain('calc(var(--dsh-frame-top-clearance, 0px) + 16px)')
})
