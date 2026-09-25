import * as vscode from 'vscode';
import { analyzeDebugBlocks } from './blockAnalyzer.js';

export class PlaywrightDebugCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

  public refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.CodeLens[] {
    try {
      const filePath = document.fileName;
      const sourceText = document.getText();

      if (!/(?:@?pw-debug:|@?debug:)block/i.test(sourceText)) {
        return [];
      }

      const blocks = analyzeDebugBlocks(filePath, sourceText);
      const codeLenses: vscode.CodeLens[] = [];

      for (const block of blocks) {
        // block.startLine is 1-based (line of the @pw-debug:block marker)
        const lineIndex = Math.max(0, block.startLine - 1);
        const range = new vscode.Range(lineIndex, 0, lineIndex, 0);

        const command: vscode.Command = {
          title: '▶ Debug Block',
          command: 'playwright-debug.debugBlock',
          arguments: [
            {
              filePath: document.fileName,
              blockName: block.name,
            },
          ],
        };

        codeLenses.push(new vscode.CodeLens(range, command));
      }

      return codeLenses;
    } catch (err) {
      console.error('[PW-DEBUG] Error providing CodeLenses:', err);
      return [];
    }
  }
}
