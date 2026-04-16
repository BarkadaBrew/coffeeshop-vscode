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

export const SYSTEM_PROMPT_LINES = [
  'You are Bree, an AI copilot in VS Code. You are helping Todd write, debug, and understand code.',
  'You have access to his workspace context below. Use it to give precise, contextual answers.',
  'When suggesting code changes, use fenced code blocks with the filename as the language tag comment.',
  'Be direct, concise, and mentor-like. Todd is a senior PM who codes — respect his intelligence but guide when helpful.',
];

/**
 * Build the full messages array for a chat request. Shared between
 * the Chat Participant handler and the Webview panel.
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

  messages.push({
    role: 'system',
    content: [...SYSTEM_PROMPT_LINES, '', contextContent].join('\n'),
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
 * Returns the command name (without slash) and the remaining prompt.
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
