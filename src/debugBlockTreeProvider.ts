import * as vscode from 'vscode';
import { analyzeDebugBlocks, DebugBlock } from './blockAnalyzer.js';

export class DebugBlockTreeItem extends vscode.TreeItem {
  constructor(
    public readonly block: DebugBlock,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(block.name, collapsibleState);
    this.tooltip = `Block "${block.name}" (lines ${block.startLine}-${block.endLine})\nFixtures: [${block.requiredFixtures.join(', ')}]`;
    this.description = `L${block.startLine}-L${block.endLine}`;
    this.iconPath = new vscode.ThemeIcon('bug');
    this.contextValue = 'debugBlockItem';

    this.command = {
      command: 'playwright-debug.openBlock',
      title: 'Go to Debug Block',
      arguments: [block],
    };
  }
}

export class DebugBlockTreeProvider implements vscode.TreeDataProvider<DebugBlockTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<DebugBlockTreeItem | undefined | null | void> =
    new vscode.EventEmitter<DebugBlockTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<DebugBlockTreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: DebugBlockTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: DebugBlockTreeItem): Thenable<DebugBlockTreeItem[]> {
    if (element) {
      return Promise.resolve([]);
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return Promise.resolve([]);
    }

    const doc = editor.document;
    if (
      !['typescript', 'javascript', 'typescriptreact', 'javascriptreact'].includes(doc.languageId)
    ) {
      return Promise.resolve([]);
    }

    try {
      const blocks = analyzeDebugBlocks(doc.fileName, doc.getText());
      const items = blocks.map(
        (b) => new DebugBlockTreeItem(b, vscode.TreeItemCollapsibleState.None)
      );
      return Promise.resolve(items);
    } catch {
      return Promise.resolve([]);
    }
  }
}
