import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const targets = [join(root, 'src', 'renderer', 'pages'), join(root, 'src', 'renderer', 'features')]
const map = new Map([
  ['div', 'Container'], ['main', 'MainRegion'], ['section', 'Section'], ['article', 'Article'], ['aside', 'Aside'],
  ['header', 'Header'], ['footer', 'Footer'], ['nav', 'Navigation'], ['span', 'InlineText'], ['small', 'SmallText'],
  ['p', 'Paragraph'], ['h1', 'Title1'], ['h2', 'Title2'], ['h3', 'Title3'], ['h4', 'Title4'], ['strong', 'Strong'],
  ['b', 'Strong'], ['i', 'Emphasis'], ['img', 'MediaImage'], ['canvas', 'MediaCanvas'], ['dl', 'DescriptionList'],
  ['dt', 'DescriptionTerm'], ['dd', 'DescriptionValue'], ['time', 'TimeValue'], ['pre', 'CodeBlock'],
  ['kbd', 'KeyboardKey'], ['label', 'FormLabel'], ['progress', 'Meter'], ['hr', 'Divider'], ['br', 'LineBreak'], ['a', 'Link']
])

for (const directory of targets) for (const file of walk(directory)) migrate(file)

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? walk(path) : extname(path) === '.tsx' ? [path] : []
  })
}

function migrate(file) {
  const input = readFileSync(file, 'utf8')
  if (!input.includes('<UiElement')) return
  const source = ts.createSourceFile(file, input, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const used = new Set()
  const result = ts.transform(source, [(context) => {
    const visit = (node) => {
      const visited = ts.visitEachChild(node, visit, context)
      if (ts.isJsxElement(visited) && visited.openingElement.tagName.getText(source) === 'UiElement') {
        const component = componentFor(visited.openingElement.attributes)
        if (component === undefined) return visited
        used.add(component)
        const tag = ts.factory.createIdentifier(component)
        const attributes = clean(visited.openingElement.attributes)
        return ts.factory.updateJsxElement(
          visited,
          ts.factory.updateJsxOpeningElement(visited.openingElement, tag, visited.openingElement.typeArguments, attributes),
          visited.children,
          ts.factory.updateJsxClosingElement(visited.closingElement, tag)
        )
      }
      if (ts.isJsxSelfClosingElement(visited) && visited.tagName.getText(source) === 'UiElement') {
        const component = componentFor(visited.attributes)
        if (component === undefined) return visited
        used.add(component)
        return ts.factory.updateJsxSelfClosingElement(visited, ts.factory.createIdentifier(component), visited.typeArguments, clean(visited.attributes))
      }
      return visited
    }
    return (rootNode) => ts.visitNode(rootNode, visit)
  }])
  let transformed = result.transformed[0]
  result.dispose()
  if (used.size === 0) return

  const existing = new Set()
  for (const statement of transformed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== '../../components/ui') continue
    const bindings = statement.importClause?.namedBindings
    if (bindings !== undefined && ts.isNamedImports(bindings)) for (const item of bindings.elements) existing.add(item.name.text)
  }
  const missing = [...used].filter((name) => !existing.has(name)).sort()
  if (missing.length > 0) {
    const declaration = ts.factory.createImportDeclaration(
      undefined,
      ts.factory.createImportClause(false, undefined, ts.factory.createNamedImports(missing.map((name) => ts.factory.createImportSpecifier(false, undefined, ts.factory.createIdentifier(name))))),
      ts.factory.createStringLiteral('../../components/ui')
    )
    transformed = ts.factory.updateSourceFile(transformed, [declaration, ...transformed.statements])
  }
  const output = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(transformed)
  writeFileSync(file, output, 'utf8')
}

function componentFor(attributes) {
  const as = attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.getText() === 'as')
  if (as === undefined || !ts.isJsxAttribute(as) || as.initializer === undefined || !ts.isStringLiteral(as.initializer)) return map.get('div')
  if (as.initializer.text === 'iframe') return undefined
  return map.get(as.initializer.text)
}

function clean(attributes) {
  return ts.factory.updateJsxAttributes(attributes, attributes.properties.filter((property) => {
    if (!ts.isJsxAttribute(property)) return true
    return !['as', 'variant', 'layout'].includes(property.name.getText())
  }))
}
