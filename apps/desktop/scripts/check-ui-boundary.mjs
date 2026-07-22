import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const desktopRoot = resolve(import.meta.dirname, '..')
const rendererRoot = join(desktopRoot, 'src', 'renderer')
const pageRoots = [join(rendererRoot, 'pages'), join(rendererRoot, 'features')]
const violations = []

for (const root of pageRoots) {
  for (const file of walk(root)) inspect(file)
  for (const file of walkExtensions(root, ['.css'])) violations.push(`${relative(desktopRoot, file).replaceAll('\\', '/')}:1:1 page and feature CSS files are forbidden`)
}
inspectGlobalStyles()
inspectComponentBoundary()
inspectPageStyleControlOverrides()

if (violations.length > 0) {
  process.stderr.write(`UI whitelist gate failed with ${violations.length} violation(s):\n`)
  for (const violation of violations) process.stderr.write(`- ${violation}\n`)
  process.exit(1)
}

process.stdout.write('UI whitelist gate passed. Pages only compose components/ui exports.\n')

function walk(directory) {
  return walkExtensions(directory, ['.ts', '.tsx'])
}

function walkExtensions(directory, extensions) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return walkExtensions(path, extensions)
    return extensions.includes(extname(entry.name)) ? [path] : []
  })
}

function inspect(file) {
  const sourceText = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const display = relative(desktopRoot, file).replaceAll('\\', '/')

  const report = (node, message) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source))
    violations.push(`${display}:${line + 1}:${character + 1} ${message}`)
  }

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text
      if (specifier === '/ui') report(node, "absolute '/ui' bypass imports are forbidden")
      if (specifier.endsWith('.css')) report(node, 'page-level CSS imports are forbidden')
      if (specifier.includes('/components/') && !specifier.endsWith('/components/ui')) {
        report(node, `UI imports must use the components/ui whitelist, found '${specifier}'`)
      }
    }

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source)
      if (/^[a-z]/u.test(tag)) report(node, `native visual element <${tag}> is forbidden in page code`)
      if (tag === 'UiElement') report(node, 'arbitrary UiElement wrappers are forbidden; use a typed components/ui control')
      for (const property of node.attributes.properties) {
        if (!ts.isJsxAttribute(property)) continue
        const name = property.name.getText(source)
        if (name === 'className' || name === 'style' || name === 'dangerouslySetInnerHTML') {
          report(property, `'${name}' is forbidden in page code; expose a typed global UI variant instead`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
}

function inspectGlobalStyles() {
  const file = join(rendererRoot, 'styles.css')
  const source = readFileSync(file, 'utf8')
  source.split(/\r?\n/u).forEach((line, index) => {
    if (/^\s*@import\s+["'](?:pages|features)\//u.test(line)) {
      violations.push(`src/renderer/styles.css:${index + 1}:1 global styles may not import page or feature CSS`)
    }
  })
}

function inspectComponentBoundary() {
  const componentsRoot = join(rendererRoot, 'components')
  const forbidden = [
    [/\bUiElement\b/u, 'arbitrary UiElement is forbidden'],
    [/\bvariant\?\s*:\s*string\b/u, 'unbounded string variants are forbidden'],
    [/\b(?:layout|visualStyle)\?\s*:\s*CSSProperties\b/u, 'arbitrary style object APIs are forbidden'],
    [/<iframe\b/u, 'embedded legacy documents are forbidden in global UI'],
    [/createElement\(['"]webview['"]/u, 'webview is restricted to the typed external-login boundary']
  ]
  for (const file of walk(componentsRoot)) {
    const source = readFileSync(file, 'utf8')
    const display = relative(desktopRoot, file).replaceAll('\\', '/')
    for (const [pattern, message] of forbidden) {
      if (pattern.test(source) && !(message.startsWith('webview') && display.endsWith('/media/ExternalWebview.tsx'))) violations.push(`${display}:1:1 ${message}`)
    }
  }
}

function inspectPageStyleControlOverrides() {
  const pageStylesRoot = join(rendererRoot, 'components', 'page-styles')
  const protectedControl = /\.ui-(?:button|icon-button|pressable|input|textarea|select|range|check|switch|radio|tabs|listbox|menu|dialog|drawer|popover)\b/u
  const protectedGeometry = /(?:^|;)\s*(?:display|width|min-width|max-width|height|min-height|max-height|padding|border|border-radius|font|font-size|line-height)\s*:/u
  for (const file of walkExtensions(pageStylesRoot, ['.css'])) {
    const source = readFileSync(file, 'utf8')
    const display = relative(desktopRoot, file).replaceAll('\\', '/')
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      const selector = match[1] ?? ''
      const declarations = match[2] ?? ''
      if (protectedControl.test(selector) && protectedGeometry.test(declarations)) {
        const line = source.slice(0, match.index).split(/\r?\n/u).length
        violations.push(`${display}:${line}:1 page styles may not override global control geometry`)
      }
    }
  }
}
