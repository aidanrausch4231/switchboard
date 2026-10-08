#!/usr/bin/env node
/** Enforce a single dsh import module per package, including tests and type-only imports. */
import ts from 'typescript'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const adapters = new Set(['build/dsh.ts', ...['core', 'council', 'fallback', 'bundle'].map(p => `packages/${p}/src/dsh.ts`), 'packages/ui/src/client/dsh.ts'])
const errors = []
function visit(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['.git', '.typert', 'node_modules', 'lib', 'coverage'].includes(entry.name)) continue
    const file = resolve(dir, entry.name)
    if (entry.isDirectory()) { visit(file); continue }
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue
    const name = relative(root, file)
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    function check(node) {
      let spec
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) spec = node.moduleSpecifier
      if (ts.isImportTypeNode(node)) spec = node.argument.literal
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')) spec = node.arguments[0]
      if (spec && ts.isStringLiteral(spec)) {
        if (spec.text.startsWith('@deepseek-ai/') && !adapters.has(name)) errors.push(`${name}: dsh import outside adapter: ${spec.text}`)
        if (spec.text.includes('/src/') && spec.text.startsWith('@deepseek-ai/')) errors.push(`${name}: private source import: ${spec.text}`)
        if (/dsh(?:-upstream)?\//.test(spec.text) && spec.text.startsWith('.')) errors.push(`${name}: repository-relative dsh import: ${spec.text}`)
      }
      ts.forEachChild(node, check)
    }
    check(source)
  }
}
visit(root)
if (errors.length) { console.error(errors.join('\n')); process.exit(1) }
console.log('Adapter check passed (five package adapters + build tooling adapter).')
