import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as Module from 'module';
import { createRequire } from 'module';
import ts from 'typescript';
import { PlaywrightDebugCodeLensProvider } from './codeLensProvider.js';
import { analyzeDebugBlocks, getBlockAtLine, DebugBlock } from './blockAnalyzer.js';
import { getFixtureBindings, launchChrome } from './cdpConnect.js';
import { generateExecutableCode } from './codeGenerator.js';
import { PlaywrightDebugTreeDataProvider, DebugBlockTreeItem } from './blockTreeView.js';

let outputChannel: vscode.OutputChannel;

function resolveTsconfigPaths(request: string, parentFilename: string): string | undefined {
  try {
    let currentDir = path.dirname(parentFilename);
    let tsconfigPath: string | undefined;

    while (currentDir && currentDir !== path.dirname(currentDir)) {
      const candidate = path.join(currentDir, 'tsconfig.json');
      if (fs.existsSync(candidate)) {
        tsconfigPath = candidate;
        break;
      }
      const jsconfigCandidate = path.join(currentDir, 'jsconfig.json');
      if (fs.existsSync(jsconfigCandidate)) {
        tsconfigPath = jsconfigCandidate;
        break;
      }
      currentDir = path.dirname(currentDir);
    }

    if (!tsconfigPath) return undefined;

    const tsconfigContent = fs.readFileSync(tsconfigPath, 'utf-8');
    const cleanedJson = tsconfigContent.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    const parsed = JSON.parse(cleanedJson);
    const compilerOptions = parsed.compilerOptions || {};
    const baseUrl = compilerOptions.baseUrl ? path.resolve(path.dirname(tsconfigPath), compilerOptions.baseUrl) : path.dirname(tsconfigPath);
    const paths = compilerOptions.paths || {};

    for (const pattern of Object.keys(paths)) {
      const starIndex = pattern.indexOf('*');
      let prefix = pattern;
      let suffix = '';
      if (starIndex !== -1) {
        prefix = pattern.slice(0, starIndex);
        suffix = pattern.slice(starIndex + 1);
      }

      if (request.startsWith(prefix) && request.endsWith(suffix)) {
        const matched = request.slice(prefix.length, request.length - suffix.length);
        const targetPatterns = paths[pattern];

        for (const targetPattern of targetPatterns) {
          const targetStarIndex = targetPattern.indexOf('*');
          let resolvedSub = targetPattern;
          if (targetStarIndex !== -1) {
            resolvedSub = targetPattern.replace('*', matched);
          }

          const fullPathCandidate = path.resolve(baseUrl, resolvedSub);

          const extensionsToTry = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];
          for (const ext of extensionsToTry) {
            const pathWithExt = fullPathCandidate + ext;
            if (fs.existsSync(pathWithExt) && fs.statSync(pathWithExt).isFile()) {
              return pathWithExt;
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('[PW-DEBUG] Error resolving tsconfig paths:', e);
  }
  return undefined;
}

function setupModuleHooks() {
  try {
    if (require.extensions && !(require.extensions as any)['.ts']) {
      (require.extensions as any)['.ts'] = function (module: any, filename: string) {
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

    const targetModule: any = (Module as any).default || Module;
    if (targetModule && targetModule._resolveFilename && !targetModule.__pwDebugHooked) {
      const __origResolveFilename = targetModule._resolveFilename;
      targetModule.__pwDebugHooked = true;
      targetModule._resolveFilename = function (
        request: string,
        parent: any,
        isMain: boolean,
        options: any
      ) {
        try {
          return __origResolveFilename.call(this, request, parent, isMain, options);
        } catch (err) {
          if (parent && parent.filename) {
            const aliasResolved = resolveTsconfigPaths(request, parent.filename);
            if (aliasResolved) {
              return aliasResolved;
            }
          }
          if (typeof request === 'string' && (request.endsWith('.js') || !path.extname(request))) {
            const tsReq = request.endsWith('.js') ? request.slice(0, -3) + '.ts' : request + '.ts';
            try {
              return __origResolveFilename.call(this, tsReq, parent, isMain, options);
            } catch (e) {}
          }
          throw err;
        }
      };
    }
  } catch (e) {
    console.error('[PW-DEBUG] Error setting up module hooks:', e);
  }
}

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Playwright Debug');
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine('[PW-DEBUG] Playwright Debug extension activated successfully.');

  setupModuleHooks();

  // 1. CodeLens Provider
  const codeLensProvider = new PlaywrightDebugCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [
        { language: 'typescript' },
        { language: 'typescriptreact' },
        { language: 'javascript' },
        { language: 'javascriptreact' },
      ],
      codeLensProvider
    )
  );

  // 2. Sidebar TreeView Provider
  const treeDataProvider = new PlaywrightDebugTreeDataProvider();
  const treeView = vscode.window.createTreeView('playwright-debug-blocks-view', {
    treeDataProvider,
  });
  context.subscriptions.push(treeView);

  // Refresh sidebar tree view & CodeLens on editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      treeDataProvider.refresh();
      codeLensProvider.refresh();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (
        vscode.window.activeTextEditor &&
        e.document === vscode.window.activeTextEditor.document
      ) {
        treeDataProvider.refresh();
        codeLensProvider.refresh();
      }
    }),
    vscode.workspace.onDidSaveTextDocument(() => {
      treeDataProvider.refresh();
      codeLensProvider.refresh();
    }),
    vscode.workspace.onDidOpenTextDocument(() => {
      treeDataProvider.refresh();
      codeLensProvider.refresh();
    })
  );

  // Command: Refresh Sidebar Tree View
  context.subscriptions.push(
    vscode.commands.registerCommand('playwright-debug.refreshTree', () => {
      treeDataProvider.refresh();
      codeLensProvider.refresh();
    })
  );

  // Command: Launch Chrome for Debugging
  context.subscriptions.push(
    vscode.commands.registerCommand('playwright-debug.launchChrome', async () => {
      outputChannel.show(true);
      outputChannel.appendLine('[PW-DEBUG] Launching Chrome on port 9222...');
      const success = await launchChrome('http://localhost:9222');
      if (success) {
        vscode.window.showInformationMessage('Chrome launched successfully with remote debugging on port 9222.');
        outputChannel.appendLine('[PW-DEBUG] Chrome is ready for CDP debug connections.');
      } else {
        vscode.window.showErrorMessage('Failed to launch Chrome on port 9222. Please check your Chrome installation.');
        outputChannel.appendLine('[PW-DEBUG ERROR] Could not start Chrome executable.');
      }
    })
  );

  // Command: Go to Debug Block line in editor
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'playwright-debug.openBlock',
      async (args?: DebugBlock | { filePath: string; startLine: number }) => {
        if (!args) return;
        const filePath = 'filePath' in args ? args.filePath : undefined;
        const startLine = 'startLine' in args ? args.startLine : undefined;

        if (filePath && startLine) {
          const doc = await vscode.workspace.openTextDocument(filePath);
          const editor = await vscode.window.showTextDocument(doc);
          const pos = new vscode.Position(startLine - 1, 0);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }
      }
    )
  );

  // Command: Debug Block Execution
  const commandDisposable = vscode.commands.registerCommand(
    'playwright-debug.debugBlock',
    async (rawArgs?: any) => {
      try {
        let filePath: string | undefined;
        let blockName: string | undefined;

        if (rawArgs) {
          if (rawArgs instanceof DebugBlockTreeItem || (rawArgs.filePath && rawArgs.block)) {
            filePath = rawArgs.filePath;
            blockName = rawArgs.block?.name;
          } else if (typeof rawArgs === 'object') {
            filePath = rawArgs.filePath;
            blockName = rawArgs.blockName;
          }
        }

        let sourceText: string | undefined;
        const editor = vscode.window.activeTextEditor;

        // 1. Read document & locate block
        if (filePath && fs.existsSync(filePath)) {
          sourceText = fs.readFileSync(filePath, 'utf-8');
        } else if (editor) {
          filePath = editor.document.fileName;
          sourceText = editor.document.getText();
        }

        if (!filePath || !sourceText) {
          vscode.window.showWarningMessage('Playwright Debug: No active document found.');
          return;
        }

        const blocks = analyzeDebugBlocks(filePath, sourceText);
        if (blocks.length === 0) {
          vscode.window.showWarningMessage(
            'Playwright Debug: No tagged debug blocks (e.g. // debug:block <name> or // @pw-debug:block <name>) found in document.'
          );
          return;
        }

        let targetBlock: DebugBlock | undefined;
        if (blockName) {
          targetBlock = blocks.find((b) => b.name === blockName);
        } else if (editor) {
          const currentLine = editor.selection.active.line + 1;
          targetBlock = getBlockAtLine(blocks, currentLine);
        }

        if (!targetBlock) {
          targetBlock = blocks[0];
        }

        outputChannel.clear();
        outputChannel.show(true);
        const targetFixtures = targetBlock.requiredFixtures.length > 0 ? targetBlock.requiredFixtures : ['page'];
        outputChannel.appendLine(
          `[PW-DEBUG] Target block: "${targetBlock.name}" in ${targetBlock.filePath}`
        );
        outputChannel.appendLine(
          `[PW-DEBUG] Required fixtures: [${targetFixtures.join(', ')}]`
        );

        // 2. Generate executable JS code
        const { code, warnings } = generateExecutableCode(targetBlock);

        // 3. Prompt user if there are warnings
        if (warnings.length > 0) {
          const warningMessage =
            `Playwright Debug Warnings for block "${targetBlock.name}":\n\n` +
            warnings.join('\n\n') +
            `\n\nDo you want to proceed?`;

          const choice = await vscode.window.showWarningMessage(
            warningMessage,
            { modal: true },
            'Proceed',
            'Cancel'
          );

          if (choice !== 'Proceed') {
            outputChannel.appendLine(`[PW-DEBUG] Cancelled by user due to warnings.`);
            return;
          }
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Executing Playwright Debug Block "${targetBlock.name}"...`,
            cancellable: false,
          },
          async () => {
            // 4. Get live fixture bindings from Chrome CDP
            outputChannel.appendLine(`[PW-DEBUG] Connecting to Chrome CDP at http://localhost:9222...`);
            const bindings = await getFixtureBindings(
              targetFixtures,
              'http://localhost:9222',
              targetBlock!.filePath
            );

            // 5. Execute generated JS via Node's vm module
            outputChannel.appendLine(`[PW-DEBUG] Executing code via vm.Script...`);

            const wrappedCode = `(function (exports, require, module, __filename, __dirname) {\n${code}\n});`;
            const script = new vm.Script(wrappedCode, {
              filename: targetBlock!.filePath,
            });

            const customModule = { exports: {} as any };
            const customRequire = createRequire(targetBlock!.filePath);
            const customFilename = targetBlock!.filePath;
            const customDirname = path.dirname(targetBlock!.filePath);

            const factory = script.runInThisContext();
            factory(
              customModule.exports,
              customRequire,
              customModule,
              customFilename,
              customDirname
            );

            const debugFn =
              typeof customModule.exports === 'function'
                ? customModule.exports
                : customModule.exports?.default || customModule.exports;

            if (typeof debugFn !== 'function') {
              throw new Error(
                `Generated code for block "${targetBlock!.name}" did not export a function.`
              );
            }

            // Execute exported debug function with fixture bindings
            await debugFn(bindings);

            // 6. On success: showInformationMessage
            outputChannel.appendLine(
              `[PW-DEBUG] Block "${targetBlock!.name}" executed successfully.`
            );
            vscode.window.showInformationMessage(
              `Block "${targetBlock!.name}" executed successfully`
            );
          }
        );
      } catch (err: any) {
        // 7. On failure: showErrorMessage with details
        let lineInfo = '';
        if (err?.stack) {
          const stackLines = (err.stack as string).split('\n');
          for (const line of stackLines) {
            if (
              line.includes(rawArgs?.filePath || '') ||
              line.includes('evalmachine') ||
              line.includes('.ts') ||
              line.includes('.js')
            ) {
              lineInfo = ` (${line.trim()})`;
              break;
            }
          }
        }

        const errMsg = `Block "${rawArgs?.blockName || 'debugBlock'}" failed: ${err?.message || err}${lineInfo}`;
        outputChannel.appendLine(`[PW-DEBUG ERROR] ${errMsg}`);
        if (err?.stack) {
          outputChannel.appendLine(err.stack);
        }
        vscode.window.showErrorMessage(errMsg);
      }
    }
  );

  context.subscriptions.push(commandDisposable);
}

export function deactivate() {}
