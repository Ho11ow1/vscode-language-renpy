import { CompletionItem, CompletionItemKind, SnippetString } from "vscode";

export function UpdateList(list: CompletionItem[], label: string, kind: CompletionItemKind, detail: string | undefined = undefined) {
    const item = new CompletionItem(label, kind);
    if (kind === CompletionItemKind.Method || kind === CompletionItemKind.Function) {
        item.insertText = new SnippetString(`${label}($1)`);
        item.command = {
            command: "editor.action.triggerParameterHints",
            title: "Parameter hints",
        };
    } else {
        item.insertText = new SnippetString(label);
    }

    if (detail !== undefined) {
        item.detail = detail;
    }

    list.push(item);
}
