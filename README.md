<div align="center">

# 🎭 Playwright Debug Block

<p align="center">
  <strong>Execute tagged Playwright code blocks instantly against an active Chrome browser session</strong>
</p>

---

### 👑 Created by **Ankur Raj**

[![LinkedIn](https://img.shields.io/badge/LinkedIn-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/ankur29feb/)

[![VS Code Extension](https://img.shields.io/badge/VS%20Code-Extension-blue.svg?style=for-the-badge&logo=visualstudiocode)](https://code.visualstudio.com/)
[![Playwright](https://img.shields.io/badge/Playwright-v1.63.0-green.svg?style=for-the-badge&logo=playwright)](https://playwright.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-v5.3.0-blue.svg?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-orange.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

---

</div>

## 📌 Overview

**Playwright Debug Block** is a lightweight, high-performance VS Code extension designed for test automation engineers and developers working with Playwright. Instead of re-running entire test suites or re-launching browser windows every time you modify a locator or interaction, Playwright Debug Block parses tagged code blocks (such as `// debug:block <name>` or `// @pw-debug:block <name>`) using **TypeScript AST analysis** and executes them directly inside an already open Chrome browser session via **Chrome DevTools Protocol (CDP)** on port `9222`.

---

## 📦 Installation (from GitHub Release)

1. Download the latest `.vsix` file from the [GitHub Releases](https://github.com/r-ankur2k/PlaywrightScrachbook/releases) page.
2. Open VS Code.
3. Go to the **Extensions** view (`Ctrl+Shift+X` on Windows/Linux or `Cmd+Shift+X` on macOS).
4. Click the **`...`** (Views and More Actions) menu in the top-right corner of the Extensions panel.
5. Select **Install from VSIX...**
6. Select the downloaded `.vsix` file and click **Install**.

---

## ✨ Key Features

- **⚡ Instant Execution**: Run isolated code blocks in milliseconds without launching new browser instances or re-authenticating.
- **🧠 AST Dependency Parsing**: Uses TypeScript Compiler APIs (`ts.createProgram`, `ts.TypeChecker`) to automatically resolve local variables, helper functions, Page Object Model (POM) classes, and imports up to a depth of 10.
- **▶ CodeLens UI**: Displays an interactive `▶ Debug Block` button directly above tagged blocks in `.ts` and `.js` test files.
- **🌲 Activity Bar Sidebar View**: Displays a dedicated **Debug Blocks** tree view in the VS Code sidebar listing all tagged blocks in your open files.
- **🌐 Automatic & Manual Chrome Debugging**: Connects to `http://localhost:9222` over CDP. Automatically launches Chrome in remote debugging mode if port 9222 is closed, or allows 1-click launch via the sidebar title bar.
- **🛡 Safe & Non-Destructive**: Runs generated code inside Node's V8 `vm.Script` context with mock fixture injection. Original test files remain completely untouched.

---

## 🚀 How to Use

### 1. Tag your Code Block

Add `// debug:block <name>` (or `// @pw-debug:block <name>`) and `// debug:end` comments around the code block you want to debug:

```typescript
import { test, expect } from "@playwright/test";
import { LoginPage } from "../pages/loginPage";

test("User authentication flow", async ({ page }) => {
  const loginPage = new LoginPage(page);
  await loginPage.navigate();

  // debug:block login-action
  await loginPage.fillCredentials("admin@example.com", "Secret123!");
  await loginPage.clickLoginButton();
  await expect(page.locator("#dashboard")).toBeVisible();
  // debug:end
});
```

### 2. Execute the Debug Block

You can run a tagged block in three ways:

1. **CodeLens**: Click `▶ Debug Block` appearing directly above the `// debug:block` (or `// @pw-debug:block`) line in the editor.
2. **Sidebar View**: Open the **Playwright Debug** tab on the VS Code activity bar, expand your file, and click the inline **Play** icon next to any block.
3. **Command Palette**: Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on macOS) and run `Playwright: Debug Block`.

---

## 🌐 Chrome Setup & Debug Mode

Playwright Debug Block connects to Chrome running with Chrome DevTools Protocol enabled on port `9222`.

### Option A: Automatic Launch (Recommended)

If Chrome is not running when you click `▶ Debug Block`, the extension will automatically detect your local Chrome installation and start it with `--remote-debugging-port=9222`.

### Option B: Manual Launch via Sidebar Icon

Click the **🌐 Globe Icon** ("Playwright: Launch Chrome (Debug Mode)") in the **Debug Blocks** sidebar view header.

### Option C: Launching via Command Line

Run the following command in your terminal:

**Windows:**

```powershell
Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList "--remote-debugging-port=9222","--user-data-dir=$env:TEMP\chrome-pw-debug"
```

**macOS:**

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-pw-debug
```

**Linux:**

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-pw-debug
```

---

## ⌨️ Extension Commands

| Command                         | Title                                    | Description                                                         |
| :------------------------------ | :--------------------------------------- | :------------------------------------------------------------------ |
| `playwright-debug.debugBlock`   | `Playwright: Debug Block`                | Executes the target debug block under cursor or tree view selection |
| `playwright-debug.launchChrome` | `Playwright: Launch Chrome (Debug Mode)` | Launches Chrome with CDP port `9222` enabled                        |
| `playwright-debug.refreshTree`  | `Refresh Debug Blocks`                   | Re-scans workspace files and refreshes sidebar tree view            |
| `playwright-debug.openBlock`    | `Go to Debug Block`                      | Navigates editor cursor directly to selected debug block line       |

---

## 🧩 Supported Fixtures

The extension automatically analyzes your code block to determine which Playwright fixtures are required and injects them from the active CDP session:

- `page` — Active tab of the browser context
- `context` — Primary browser context
- `browser` — Playwright Browser instance
- `request` — APIRequestContext associated with the context

---

## ⚙️ Extension Settings & Configuration

The extension requires zero setup out of the box, but listens for standard Playwright TypeScript files (`.ts`, `.tsx`, `.js`, `.jsx`).

- **CDP Endpoint**: Default `http://localhost:9222`
- **Dependency Resolution Limit**: Depth 10 recursive traversal

---

<div align="center">

**Developed with ❤️ by Ankur Raj**  
🔗 [LinkedIn Profile](https://www.linkedin.com/in/ankur29feb/)

</div>
