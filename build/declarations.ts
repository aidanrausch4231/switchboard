/** Flatten adapter references in emitted declarations. Otherwise a portable Flow type
 * loads the entire Host barrel and merges Host services into the Client Context. */
import ts from 'typescript'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
for (const pkg of ['core', 'council', 'fallback']) {
  const dir = resolve(root, 'packages', pkg, 'lib/types')
  const adapter = ts.createSourceFile('dsh.d.ts', readFileSync(resolve(dir, 'dsh.d.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  const exports = new Map<string, { name: string; module: string }>()
  for (const node of adapter.statements) if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.exportClause && ts.isNamedExports(node.exportClause)) {
    for (const spec of node.exportClause.elements) exports.set(spec.name.text, { name: spec.propertyName?.text ?? spec.name.text, module: node.moduleSpecifier.text })
  }
  for (const entry of readdirSync(dir, { recursive: true })) {
    if (!entry.endsWith('.d.ts') || entry === 'dsh.d.ts') continue
    const file = resolve(dir, entry), text = readFileSync(file, 'utf8')
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const edits: [number, number, string][] = []
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || !/\/dsh\.(?:ts|js)$/.test(node.moduleSpecifier.text)) continue
      const clause = node.importClause
      if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) throw new Error(`Unsupported declaration import: ${file}`)
      const lines = clause.namedBindings.elements.map(spec => {
        const item = exports.get(spec.propertyName?.text ?? spec.name.text)
        if (!item) return `import ${clause.isTypeOnly || spec.isTypeOnly ? 'type ' : ''}{ ${spec.getText(source)} } from ${node.moduleSpecifier.getText(source)};`
        return `import ${clause.isTypeOnly || spec.isTypeOnly ? 'type ' : ''}{ ${item.name}${item.name !== spec.name.text ? ' as ' + spec.name.text : ''} } from '${item.module}';`
      })
      edits.push([node.getStart(source), node.end, lines.join('\n')])
    }
    let output = text
    for (const [start, end, replacement] of edits.reverse()) output = output.slice(0, start) + replacement + output.slice(end)
    if (edits.length) writeFileSync(file, output)
  }
}
