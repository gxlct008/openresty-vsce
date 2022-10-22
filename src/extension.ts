
import * as vscode from 'vscode';
import { loadItems } from './completion';
import { getFileLink } from './filelink';
import { getHover } from './hover';
import { loadDocSymbols } from "./docSymbos";
import { getSignature } from './signature';
import { openrestyDebug, openrestyAction } from './command';

const selector = [{ scheme: 'file', language: "lua" }];

export function activate(context: vscode.ExtensionContext) {

	/** 文件跳转 */
	context.subscriptions.push(vscode.languages.registerDefinitionProvider(
		selector, { provideDefinition: getFileLink }
	));

	/** 悬停提示 */
	context.subscriptions.push(vscode.languages.registerHoverProvider(
		selector, { provideHover: getHover }
	));

	/** 参数提示 */
	context.subscriptions.push(vscode.languages.registerSignatureHelpProvider(
		selector, { provideSignatureHelp: getSignature }, "(", ",", "{"
	));

	/** 代码补全 */
	context.subscriptions.push(vscode.languages.registerCompletionItemProvider(
		selector, { provideCompletionItems: loadItems }, '.', ':', "$", "#", "%", "@"
	));

	/** 文档大纲 */
	context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(
		selector, { provideDocumentSymbols: loadDocSymbols }
	));

	/** 注册命令 */
	context.subscriptions.push(vscode.commands.registerCommand('openresty.debug', openrestyDebug));
	context.subscriptions.push(vscode.commands.registerCommand('openresty.action', openrestyAction));

}

export function deactivate() {}
