import { getConfig } from '../config';
import { buildContext, formatContextBlock, formatFileContent } from '../context/context-builder';
import { TerminalCapture } from '../context/terminal-context';
import type { ChatMessage } from '../types';

export const SLASH_PROMPTS: Record<string, string> = {
  explain:
    'Explain the following code clearly. Break down what it does, why, and any non-obvious details.',
  fix: 'Fix the errors in this file. Show the corrected code with a brief explanation of each fix.',
  test: 'Generate unit tests for the selected code. Use the testing framework already in use in this project if detectable.',
  commit:
    'Based on the current git diff, suggest a concise commit message. Follow conventional commits style if the project uses it.',
  review:
    'Review this code for bugs, performance issues, security concerns, and readability. Be direct and actionable.',
};

/**
 * The model to request from the daemon. "bree" triggers the character
 * path which injects soul.md, memory, RAG vault context, and tools
 * automatically — no need to duplicate persona instructions here.
 */
export const DAEMON_MODEL = 'bree';

/**
 * Build the full messages array for a chat request. Shared between
 * the Chat Participant handler and the Webview panel.
 *
 * The daemon injects Bree's full identity (soul.md, memory, RAG) when
 * model="bree" is requested. This function only adds workspace context
 * as a system message — the daemon prepends the persona prompt.
 */
export async function buildChatMessages(
  terminal: TerminalCapture,
  userPrompt: string,
  slashCommand: string | undefined,
  history: ChatMessage[]
): Promise<ChatMessage[]> {
  const config = getConfig();

  // Build workspace context
  const wsContext = await buildContext(terminal);
  const contextBlock = formatContextBlock(wsContext);
  const fileBlock = formatFileContent(wsContext);

  // Trim context to budget
  let contextContent = contextBlock;
  if (fileBlock) contextContent += '\n' + fileBlock;
  if (contextContent.length > config.contextBudget * 4) {
    contextContent =
      contextContent.slice(0, config.contextBudget * 4) +
      '\n... (context truncated to budget)';
  }

  const messages: ChatMessage[] = [];

  // Workspace context as system message — daemon adds soul.md on top
  messages.push({
    role: 'system',
    content: contextContent,
  });

  // Append conversation history
  for (const msg of history) {
    messages.push(msg);
  }

  // Current user message with optional slash command prefix
  const slashPrompt = slashCommand ? SLASH_PROMPTS[slashCommand] : undefined;
  const userContent = slashPrompt
    ? `${slashPrompt}\n\n${userPrompt || '(see context above)'}`
    : userPrompt;

  messages.push({ role: 'user', content: userContent });

  return messages;
}

/**
 * Parse a user input string for a leading slash command.
 */
export function parseSlashCommand(
  input: string
): { command: string | undefined; prompt: string } {
  const match = input.match(/^\/(\w+)\s*(.*)/s);
  if (match && match[1] in SLASH_PROMPTS) {
    return { command: match[1], prompt: match[2] };
  }
  return { command: undefined, prompt: input };
}
