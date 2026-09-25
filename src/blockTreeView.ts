import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { analyzeDebugBlocks, DebugBlock } from './blockAnalyzer.js';

export class DebugBlockTreeItem extends vscode.TreeItem {
  constructor(
    public readonly block: DebugBlock,
    public readonly filePath: string
  ) {
    super(block.name, vscode.TreeItemCollapsibleState.None);

    const relativePath = vscode.workspace.asRelativePath(filePath);
    this.description = `L${block.startLine}-${block.endLine} (${path.basename(filePath)})`;
    this.tooltip = `Debug Block: "${block.name}" in ${relativePath}\nFixtures: [${block.requiredFixtures.join(', ')}]`;
    this.iconPath = new vscode.ThemeIcon('play');

    // Click item to run debug block directly
    this.command = {
      command: 'playwright-debug.openBlock',
      title: 'Go to Debug Block',
      arguments: [block],
    };

    this.contextValue = 'debugBlockItem';
  }
}

export class PlaywrightDebugTreeDataProvider
  implements vscode.TreeDataProvider<DebugBlockTreeItem>
{
  private _onDidChangeTreeData: vscode.EventEmitter<
    DebugBlockTreeItem | undefined | null | void
  > = new vscode.EventEmitter<DebugBlockTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<
    DebugBlockTreeItem | undefined | null | void
  > = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: DebugBlockTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(
    element?: DebugBlockTreeItem
  ): Promise<DebugBlockTreeItem[]> {
    if (element) {
      return [];
    }

    const items: DebugBlockTreeItem[] = [];
    const scannedPaths = new Set<string>();

    // 1. Check active text editor first
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document) {
      const filePath = activeEditor.document.fileName;
      if (this.isSupportedFile(filePath)) {
        scannedPaths.add(filePath);
        const text = activeEditor.document.getText();
        const blocks = analyzeDebugBlocks(filePath, text);
        for (const b of blocks) {
          items.push(new DebugBlockTreeItem(b, filePath));
        }
      }
    }

    // 2. Check all open text documents in workspace
    for (const doc of vscode.workspace.textDocuments) {
      const filePath = doc.fileName;
      if (!scannedPaths.has(filePath) && this.isSupportedFile(filePath)) {
        scannedPaths.add(filePath);
        const text = doc.getText();
        const blocks = analyzeDebugBlocks(filePath, text);
        for (const b of blocks) {
          items.push(new DebugBlockTreeItem(b, filePath));
        }
      }
    }

    // 3. Search workspace for files containing @pw-debug:block
    try {
      const files = await vscode.workspace.findFiles(
        '**/*.{ts,js,tsx,jsx}',
        '**/node_modules/**'
      );
      for (const fileUri of files) {
        const filePath = fileUri.fsPath;
        if (!scannedPaths.has(filePath)) {
          scannedPaths.add(filePath);
          if (fs.existsSync(filePath)) {
            const text = fs.readFileSync(filePath, 'utf-8');
            if (/(?:@?pw-debug:|@?debug:)block/i.test(text)) {
              const blocks = analyzeDebugBlocks(filePath, text);
              for (const b of blocks) {
                items.push(new DebugBlockTreeItem(b, filePath));
              }
            }
          }
        }
      }
    } catch (e) {
      // Ignore findFiles errors in non-folder workspaces
    }

    return items;
  }

  private isSupportedFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ['.ts', '.js', '.tsx', '.jsx'].includes(ext);
  }
}
