import ts from 'typescript';
import { DebugBlock } from './blockAnalyzer.js';

export interface CodeGeneratorResult {
  code: string;
  warnings: string[];
}

export function generateExecutableCode(block: DebugBlock): CodeGeneratorResult {
  const warnings: string[] = [];

  // Collect warnings for dependencies with potential side effects
  for (const dep of block.dependencies) {
    if (dep.possibleSideEffect) {
      warnings.push(
        `Re-running declaration: \`${dep.text}\` — this may repeat a side effect (navigation, click, etc). Verify this is safe before proceeding.`
      );
    }
  }

  // Format imports
  const importsText = block.imports.join('\n');

  // Format dependencies
  const dependenciesText = block.dependencies.map(d => d.text).join('\n  ');

  // Format block statements
  const statementsText = block.statements.map(s => s.getText()).join('\n  ');

  // Format fixture destructuring
  const fixtureParam =
    block.requiredFixtures.length > 0 ? `{ ${block.requiredFixtures.join(', ')} }` : '{}';

  // Construct TypeScript source text
  const tsCode = `
${importsText}

async function __debugBlock(${fixtureParam}) {
  ${dependenciesText}
  ${statementsText}
}

module.exports = __debugBlock;
`.trim();

  // Transpile TypeScript to CommonJS JavaScript
  const transpiled = ts.transpileModule(tsCode, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      skipLibCheck: true,
    },
  });

  return {
    code: transpiled.outputText,
    warnings,
  };
}
