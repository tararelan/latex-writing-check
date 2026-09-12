import * as vscode from 'vscode';

const IGNORED_KEY = 'latexWritingCheck.ignoredIssues';

/** A stable-ish signature for one flagged issue, used to remember "ignore this". */
export function issueSignature(category: string, quote: string): string {
  return `${category}::${quote}`;
}

export function getIgnoredSet(context: vscode.ExtensionContext): Set<string> {
  return new Set(context.globalState.get<string[]>(IGNORED_KEY, []));
}

export async function addIgnored(context: vscode.ExtensionContext, signature: string): Promise<void> {
  const list = context.globalState.get<string[]>(IGNORED_KEY, []);
  if (!list.includes(signature)) {
    list.push(signature);
    await context.globalState.update(IGNORED_KEY, list);
  }
}
