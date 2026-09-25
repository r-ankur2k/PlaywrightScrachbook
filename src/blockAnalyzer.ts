import ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';

// ── Public interfaces ──────────────────────────────────────────────

export interface ResolvedDependency {
  text: string;
  possibleSideEffect: boolean;
  declaredInFile: string;
}

export interface DebugBlock {
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  statements: ts.Statement[];
  dependencies: ResolvedDependency[];
  requiredFixtures: string[];
  imports: string[];
}

// ── Constants ──────────────────────────────────────────────────────

const PLAYWRIGHT_FIXTURES = ['page', 'context', 'browser', 'request'] as const;

const SIDE_EFFECT_NAMES = new Set([
  'navigate', 'click', 'goto', 'fill', 'submit',
  'dblclick', 'check', 'uncheck', 'selectOption', 'type',
  'press', 'setInputFiles', 'hover', 'tap', 'dragTo',
]);

const MAX_RESOLVE_DEPTH = 10;

// ── Compiler Options Helper ─────────────────────────────────────────

function loadProjectCompilerOptions(filePath: string): ts.CompilerOptions {
  const baseOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    allowJs: true,
    strict: false,
    noEmit: true,
    skipLibCheck: true,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };

  try {
    let currentDir = path.dirname(filePath);
    while (currentDir && currentDir !== path.dirname(currentDir)) {
      const configPath = path.join(currentDir, 'tsconfig.json');
      if (fs.existsSync(configPath)) {
        const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
        if (configFile.config) {
          const parsed = ts.parseJsonConfigFileContent(
            configFile.config,
            ts.sys,
            currentDir
          );
          return {
            ...baseOptions,
            ...parsed.options,
            noEmit: true,
          };
        }
        break;
      }
      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }
  } catch (e) {
    console.error('[PW-DEBUG] Error reading tsconfig:', e);
  }

  return baseOptions;
}

// ── Marker Detection (Line-based) ──────────────────────────────────

interface MarkerPair {
  name: string;
  startLine: number; // 1-based line of @pw-debug:block <name>
  endLine: number;   // 1-based line of @pw-debug:end
}

function findMarkerPairs(sourceText: string): MarkerPair[] {
  const lines = sourceText.split(/\r?\n/);
  const pairs: MarkerPair[] = [];
  const stack: { name: string; line: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const lineText = lines[i];

    const blockMatch = lineText.match(/\/\/\s*(?:@?pw-debug:|@?debug:)block\s+(\S+)/i);
    if (blockMatch) {
      stack.push({ name: blockMatch[1], line: lineNum });
      continue;
    }

    const endMatch = lineText.match(/\/\/\s*(?:@?pw-debug:|@?debug:)end/i);
    if (endMatch && stack.length > 0) {
      const start = stack.pop()!;
      pairs.push({
        name: start.name,
        startLine: start.line,
        endLine: lineNum,
      });
    }
  }

  return pairs;
}

// ── Statement Extraction ───────────────────────────────────────────

function extractBlockStatements(
  sourceFile: ts.SourceFile,
  startLine: number,
  endLine: number,
): ts.Statement[] {
  const matchingStatements: ts.Statement[] = [];

  function visit(node: ts.Node) {
    if (ts.isStatement(node)) {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

      if (start > startLine && end < endLine) {
        matchingStatements.push(node as ts.Statement);
        return;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return matchingStatements;
}

// ── Fixture Detection ──────────────────────────────────────────────

function findEnclosingFixtures(node: ts.Node): string[] {
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current)
    ) {
      const parent = current.parent;
      if (parent && ts.isCallExpression(parent)) {
        const exprText = parent.expression.getText();
        if (/\btest\b/.test(exprText)) {
          return extractFixtureNames(current as ts.ArrowFunction | ts.FunctionExpression);
        }
      }
    }
    current = current.parent;
  }
  return [];
}

function extractFixtureNames(fn: ts.ArrowFunction | ts.FunctionExpression): string[] {
  const fixtures: string[] = [];
  for (const param of fn.parameters) {
    if (ts.isObjectBindingPattern(param.name)) {
      for (const element of param.name.elements) {
        if (ts.isIdentifier(element.name)) {
          const name = element.name.text;
          if ((PLAYWRIGHT_FIXTURES as readonly string[]).includes(name)) {
            fixtures.push(name);
          }
        }
      }
    } else if (ts.isIdentifier(param.name)) {
      const name = param.name.text;
      if ((PLAYWRIGHT_FIXTURES as readonly string[]).includes(name)) {
        fixtures.push(name);
      }
    }
  }
  return fixtures;
}

// ── Free Identifier Collection ─────────────────────────────────────

function collectDeclaredNames(nodes: ts.Node[]): Set<string> {
  const names = new Set<string>();

  function walk(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      names.add(node.name.text);
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      names.add(node.name.text);
    }
    if (ts.isClassDeclaration(node) && node.name) {
      names.add(node.name.text);
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, walk);
  }

  for (const n of nodes) walk(n);
  return names;
}

function collectFreeIdentifiers(
  nodes: ts.Node[],
  locallyDeclared: Set<string>,
): Set<string> {
  const free = new Set<string>();

  function walk(node: ts.Node) {
    if (ts.isIdentifier(node)) {
      const name = node.text;

      if (locallyDeclared.has(name)) return;

      const parent = node.parent;
      if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) return;

      if (parent && ts.isVariableDeclaration(parent) && parent.name === node) return;
      if (parent && ts.isFunctionDeclaration(parent) && parent.name === node) return;
      if (parent && ts.isClassDeclaration(parent) && parent.name === node) return;
      if (parent && ts.isParameter(parent) && parent.name === node) return;
      if (parent && ts.isPropertyAssignment(parent) && parent.name === node) return;
      if (parent && ts.isImportSpecifier(parent)) return;

      if (parent && (
        ts.isTypeReferenceNode(parent) ||
        ts.isTypeAliasDeclaration(parent) ||
        ts.isInterfaceDeclaration(parent)
      )) return;

      free.add(name);
    }

    ts.forEachChild(node, walk);
  }

  for (const n of nodes) {
    walk(n);
  }

  return free;
}

// ── Side-Effect Detection ──────────────────────────────────────────

function hasSideEffects(node: ts.Node): boolean {
  let found = false;

  function walk(n: ts.Node) {
    if (found) return;

    if (ts.isAwaitExpression(n)) {
      found = true;
      return;
    }

    if (ts.isCallExpression(n)) {
      const expr = n.expression;
      if (ts.isPropertyAccessExpression(expr)) {
        if (SIDE_EFFECT_NAMES.has(expr.name.text)) {
          found = true;
          return;
        }
      }
      if (ts.isIdentifier(expr)) {
        if (SIDE_EFFECT_NAMES.has(expr.text)) {
          found = true;
          return;
        }
      }
    }

    ts.forEachChild(n, walk);
  }

  walk(node);
  return found;
}

// ── Dependency Resolution (TypeChecker-based) ──────────────────────

interface RawDep {
  name: string;
  declaration: ts.Node;
  sourceFile: ts.SourceFile;
  isSynthetic?: boolean;
  syntheticText?: string;
  syntheticClassName?: string;
  syntheticClassFilePath?: string;
}

interface CustomFixtureResolution {
  name: string;
  className: string;
  classFilePath?: string;
  syntheticText: string;
}

function resolveCustomFixture(
  name: string,
  decl: ts.Node,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  program: ts.Program,
): CustomFixtureResolution | undefined {
  let className: string | undefined;

  try {
    const type = checker.getTypeAtLocation(decl);
    const sym = type.getSymbol() || type.aliasSymbol;
    if (sym && sym.name && sym.name !== '__type' && sym.name !== 'Object' && sym.name !== 'any') {
      className = sym.name;
    }
  } catch (e) {}

  if (!className && name.length > 2) {
    className = name.charAt(0).toUpperCase() + name.slice(1);
  }

  if (!className) return undefined;

  let classFilePath: string | undefined;
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    for (const stmt of sf.statements) {
      if (ts.isClassDeclaration(stmt) && stmt.name && stmt.name.text === className) {
        classFilePath = sf.fileName;
        break;
      }
    }
    if (classFilePath) break;
  }

  return {
    name,
    className,
    classFilePath,
    syntheticText: `const ${name} = new ${className}(page);`,
  };
}

function resolveDependencies(
  freeNames: Set<string>,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  blockStatements: ts.Statement[],
  program: ts.Program,
  depth: number = 0,
  visited: Set<string> = new Set(),
): RawDep[] {
  if (depth >= MAX_RESOLVE_DEPTH) {
    return [];
  }

  const deps: RawDep[] = [];
  const blockNodeSet = new Set<ts.Node>(blockStatements);

  for (const name of freeNames) {
    if (visited.has(name)) continue;
    visited.add(name);

    const symbol = findSymbolForName(name, sourceFile, checker, blockStatements);
    if (!symbol) continue;

    const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!decl) continue;

    if (isInsideBlock(decl, blockNodeSet)) continue;

    if (ts.isImportSpecifier(decl) ||
        ts.isImportClause(decl) ||
        ts.isNamespaceImport(decl) ||
        ts.isImportDeclaration(decl)) {
      continue;
    }

    if (ts.isParameter(decl) || ts.isBindingElement(decl)) {
      if (!PLAYWRIGHT_FIXTURES.includes(name as any)) {
        const fixtureRes = resolveCustomFixture(name, decl, checker, sourceFile, program);
        if (fixtureRes) {
          deps.push({
            name,
            declaration: decl,
            sourceFile: decl.getSourceFile(),
            isSynthetic: true,
            syntheticText: fixtureRes.syntheticText,
            syntheticClassName: fixtureRes.className,
            syntheticClassFilePath: fixtureRes.classFilePath,
          });
        }
      }
      continue;
    }

    const declSourceFile = decl.getSourceFile();
    if (
      declSourceFile.fileName.includes('typescript/lib') ||
      (declSourceFile.fileName.includes('/lib.') && declSourceFile.fileName.endsWith('.d.ts')) ||
      declSourceFile.hasNoDefaultLib
    ) {
      continue;
    }

    const topDecl = getTopLevelDeclaration(decl);

    deps.push({
      name,
      declaration: topDecl,
      sourceFile: declSourceFile,
    });

    const innerDeclared = collectDeclaredNames([topDecl]);
    const innerFree = collectFreeIdentifiers([topDecl], innerDeclared);
    innerFree.delete(name);

    const transitive = resolveDependencies(
      innerFree, checker, sourceFile, blockStatements, program,
      depth + 1, visited,
    );
    deps.push(...transitive);
  }

  return deps;
}

function findSymbolForName(
  name: string,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  blockStatements: ts.Statement[],
): ts.Symbol | undefined {
  let result: ts.Symbol | undefined;

  function walkBlock(node: ts.Node) {
    if (result) return;
    if (ts.isIdentifier(node) && node.text === name) {
      const sym = checker.getSymbolAtLocation(node);
      if (sym) {
        result = sym;
        return;
      }
    }
    ts.forEachChild(node, walkBlock);
  }

  for (const stmt of blockStatements) {
    walkBlock(stmt);
    if (result) return result;
  }

  function walkFile(node: ts.Node) {
    if (result) return;
    if (ts.isIdentifier(node) && node.text === name) {
      const sym = checker.getSymbolAtLocation(node);
      if (sym) {
        result = sym;
        return;
      }
    }
    ts.forEachChild(node, walkFile);
  }

  walkFile(sourceFile);
  return result;
}

function isInsideBlock(node: ts.Node, blockNodes: Set<ts.Node>): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (blockNodes.has(current)) return true;
    current = current.parent;
  }
  return false;
}

function getTopLevelDeclaration(decl: ts.Node): ts.Node {
  let current = decl;
  while (current.parent) {
    if (ts.isVariableStatement(current)) return current;
    if (ts.isFunctionDeclaration(current)) return current;
    if (ts.isClassDeclaration(current)) return current;
    if (ts.isSourceFile(current.parent) || ts.isBlock(current.parent)) {
      return current;
    }
    current = current.parent;
  }
  return current;
}

// ── Import Extraction ──────────────────────────────────────────────

function extractImports(sourceFile: ts.SourceFile): string[] {
  const imports: string[] = [];
  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt)) {
      imports.push(stmt.getText(sourceFile));
    }
  }
  return imports;
}

// ── Public API ─────────────────────────────────────────────────────

export function analyzeDebugBlocks(filePath: string, sourceText: string): DebugBlock[] {
  const compilerOptions = loadProjectCompilerOptions(filePath);

  const host = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = host.getSourceFile.bind(host);

  host.getSourceFile = (
    fileName: string,
    languageVersion: ts.ScriptTarget,
    onError?: (message: string) => void,
  ) => {
    if (normalizePath(fileName) === normalizePath(filePath)) {
      return ts.createSourceFile(fileName, sourceText, languageVersion, true);
    }
    return originalGetSourceFile(fileName, languageVersion, onError);
  };

  host.fileExists = (fileName: string) => {
    if (normalizePath(fileName) === normalizePath(filePath)) return true;
    return ts.sys.fileExists(fileName);
  };

  host.readFile = (fileName: string) => {
    if (normalizePath(fileName) === normalizePath(filePath)) return sourceText;
    return ts.sys.readFile(fileName);
  };

  const program = ts.createProgram([filePath], compilerOptions, host);
  const sourceFile = program.getSourceFile(filePath);
  if (!sourceFile) return [];

  const checker = program.getTypeChecker();

  const markerPairs = findMarkerPairs(sourceText);
  const imports = extractImports(sourceFile);

  const blocks: DebugBlock[] = [];

  for (const pair of markerPairs) {
    const stmts = extractBlockStatements(sourceFile, pair.startLine, pair.endLine);
    if (stmts.length === 0) continue;

    const firstStmt = stmts[0];
    const startLine = pair.startLine;
    const endLine = pair.endLine;

    const locallyDeclared = collectDeclaredNames(stmts);
    const freeNames = collectFreeIdentifiers(stmts, locallyDeclared);

    const rawDeps = resolveDependencies(freeNames, checker, sourceFile, stmts, program);

    const seen = new Set<string>();
    const uniqueDeps = rawDeps.filter(d => {
      const key = d.declaration.getStart(d.sourceFile) + ':' + d.sourceFile.fileName + ':' + (d.syntheticText || '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    uniqueDeps.sort(
      (a, b) => a.declaration.getStart(a.sourceFile) - b.declaration.getStart(b.sourceFile),
    );

    const dependencies: ResolvedDependency[] = uniqueDeps.map(d => ({
      text: d.isSynthetic ? d.syntheticText! : d.declaration.getText(d.sourceFile),
      possibleSideEffect: d.isSynthetic ? false : hasSideEffects(d.declaration),
      declaredInFile: d.sourceFile.fileName,
    }));

    // Check if any synthetic dependency needs class import
    for (const d of uniqueDeps) {
      if (d.isSynthetic && d.syntheticClassName && d.syntheticClassFilePath) {
        const className = d.syntheticClassName;
        const hasImport = imports.some(imp => imp.includes(className));
        if (!hasImport) {
          const formattedPath = normalizePath(d.syntheticClassFilePath);
          imports.push(`import { ${className} } from "${formattedPath}";`);
        }
      }
    }

    const allFixturesInScope = findEnclosingFixtures(firstStmt);
    const allReferencedNames = new Set([
      ...freeNames,
      ...rawDeps.flatMap(d => {
        if (d.isSynthetic) return ['page'];
        const innerDeclared = collectDeclaredNames([d.declaration]);
        return [...collectFreeIdentifiers([d.declaration], innerDeclared)];
      }),
    ]);

    let requiredFixtures = allFixturesInScope.filter(f => allReferencedNames.has(f));

    // If synthetic custom fixture was used (e.g. const loginPage = new LoginPage(page)), ensure 'page' is in requiredFixtures
    if (uniqueDeps.some(d => d.isSynthetic) && !requiredFixtures.includes('page')) {
      requiredFixtures.push('page');
    }

    blocks.push({
      name: pair.name,
      filePath,
      startLine,
      endLine,
      statements: stmts,
      dependencies,
      requiredFixtures,
      imports,
    });
  }

  return blocks;
}

export function getBlockAtLine(blocks: DebugBlock[], line: number): DebugBlock | undefined {
  return blocks.find(b => line >= b.startLine && line <= b.endLine);
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}
