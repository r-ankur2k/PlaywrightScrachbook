import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import ts from 'typescript';
import { DebugBlock } from './blockAnalyzer.js';

export interface ExecutionOptions {
  cdpEndpoint?: string;
  tempDir?: string;
  timeoutMs?: number;
  cdpConnectModulePath?: string;
}

export interface ExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  runnerFilePath: string;
}

/**
 * Rewrites relative import paths in an import statement to absolute paths
 * based on the source file's directory.
 */
export function rebaseImportStatement(importStmt: string, sourceFilePath: string): string {
  return importStmt.replace(
    /from\s+(['"])([^'"]+)\1/g,
    (match, quote, modulePath) => {
      if (modulePath.startsWith('.')) {
        const sourceDir = path.dirname(sourceFilePath);
        let absolutePath = path.resolve(sourceDir, modulePath).replace(/\\/g, '/');
        if (!fs.existsSync(absolutePath)) {
          const tsPath = absolutePath.replace(/\.js$/, '.ts');
          if (fs.existsSync(tsPath)) {
            absolutePath = tsPath;
          }
        }
        return `from ${quote}${absolutePath}${quote}`;
      }
      return match;
    }
  );
}

/**
 * Generates the complete TypeScript runner code for a given DebugBlock.
 */
export function generateRunnerCode(
  block: DebugBlock,
  cdpEndpoint: string = 'http://localhost:9222',
  cdpConnectModulePath?: string
): string {
  // 1. Rebase imports from original file (excluding @playwright/test test runner fixtures if present)
  const rebasedImports = block.imports
    .filter(imp => !imp.includes('@playwright/test'))
    .map(imp => rebaseImportStatement(imp, block.filePath));

  // 2. Format dependencies (helper functions, variables, class declarations)
  const dependencyTexts = block.dependencies.map(dep => dep.text);

  // 3. Format block statements
  const statementTexts = block.statements.map(stmt => stmt.getText());

  // 4. Identify required fixtures (default to 'page' if none detected)
  const fixtures = block.requiredFixtures.length > 0 ? block.requiredFixtures : ['page'];
  const fixtureArrayStr = JSON.stringify(fixtures);

  // Determine path to cdpConnect module
  const cdpPath = (cdpConnectModulePath || path.resolve(__dirname, './cdpConnect.js')).replace(/\\/g, '/');

  const runnerTs = `
import * as fs from 'fs';
import ts from 'typescript';

const moduleObj: any = require('module');
// Intercept module resolution to map .js imports to existing .ts files
const __origResolveFilename = moduleObj._resolveFilename;
moduleObj._resolveFilename = function (request: string, parent: any, isMain: boolean, options: any) {
  try {
    return __origResolveFilename.call(this, request, parent, isMain, options);
  } catch (err) {
    if (typeof request === 'string' && request.endsWith('.js')) {
      const tsReq = request.slice(0, -3) + '.ts';
      try {
        return __origResolveFilename.call(this, tsReq, parent, isMain, options);
      } catch (e) {}
    }
    throw err;
  }
};

// Register TypeScript file loader for Node.js
if (!require.extensions['.ts']) {
  require.extensions['.ts'] = function (module: any, filename: string) {
    const content = fs.readFileSync(filename, 'utf8');
    const compiled = ts.transpileModule(content, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        skipLibCheck: true,
      },
    }).outputText;
    module._compile(compiled, filename);
  };
}

import { getFixtureBindings } from '${cdpPath}';
${rebasedImports.join('\n')}

// ── Debug Block Execution ─────────────────────────────────────────
async function __runDebugBlock__() {
  console.log('[PW-DEBUG-BLOCK] Connecting to Chrome CDP at ${cdpEndpoint}...');
  const __bindings__ = await getFixtureBindings(${fixtureArrayStr}, '${cdpEndpoint}');

  ${fixtures.map(f => `const ${f} = __bindings__.${f};`).join('\n  ')}

  // ── Resolved Dependencies ──────────────────────────────────────────
  ${dependencyTexts.join('\n  ')}

  console.log('[PW-DEBUG-BLOCK] Executing block "${block.name}"...');

  ${statementTexts.join('\n  ')}
}

__runDebugBlock__()
  .then(() => {
    console.log('[PW-DEBUG-BLOCK] Block "${block.name}" executed successfully.');
    process.exit(0);
  })
  .catch((err: any) => {
    console.error('[PW-DEBUG-BLOCK] Block "${block.name}" failed with error:');
    console.error(err?.stack || err);
    process.exit(1);
  });
`;

  return runnerTs;
}

/**
 * Transpiles TypeScript code to CommonJS JavaScript using the TypeScript compiler API.
 */
export function transpileRunnerCode(tsCode: string): string {
  const result = ts.transpileModule(tsCode, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      skipLibCheck: true,
    },
  });
  return result.outputText;
}

/**
 * Executes a debug block in a separate Node.js process against live Chrome.
 */
export async function executeDebugBlock(
  block: DebugBlock,
  options: ExecutionOptions = {}
): Promise<ExecutionResult> {
  const cdpEndpoint = options.cdpEndpoint || 'http://localhost:9222';
  const timeoutMs = options.timeoutMs || 30000;

  // Determine temp directory
  const baseTempDir = options.tempDir || path.join(process.cwd(), '.pw-debug-tmp');
  if (!fs.existsSync(baseTempDir)) {
    fs.mkdirSync(baseTempDir, { recursive: true });
  }

  const timestamp = Date.now();
  const safeName = block.name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const runnerFileName = `runner_${safeName}_${timestamp}.js`;
  const runnerFilePath = path.join(baseTempDir, runnerFileName);

  // Generate TS code and transpile to JS
  const tsCode = generateRunnerCode(block, cdpEndpoint, options.cdpConnectModulePath);
  const jsCode = transpileRunnerCode(tsCode);

  fs.writeFileSync(runnerFilePath, jsCode, 'utf-8');

  return new Promise<ExecutionResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(process.execPath, [runnerFilePath], {
      cwd: path.dirname(block.filePath),
      env: { ...process.env },
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        resolve({
          success: false,
          stdout,
          stderr: stderr + `\n[PW-DEBUG-BLOCK] Timed out after ${timeoutMs}ms`,
          exitCode: null,
          runnerFilePath,
        });
      }
    }, timeoutMs);

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          success: code === 0,
          stdout,
          stderr,
          exitCode: code,
          runnerFilePath,
        });
      }
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          success: false,
          stdout,
          stderr: stderr + `\n${err.message}`,
          exitCode: 1,
          runnerFilePath,
        });
      }
    });
  });
}
