/**
 * OpenCode Fast Apply Plugin
 *
 * Integrates OpenAI-compatible Fast Apply API for 10x faster code editing.
 * Supports LM Studio, Ollama, and other OpenAI-compatible endpoints.
 * Uses lazy edit markers (// ... existing code ...) for partial file updates.
 *
 * @see https://github.com/tickernelz/opencode-fast-apply
 */

import { type Plugin, tool } from "@opencode-ai/plugin"
import { createTwoFilesPatch } from "diff"
import { readFile, writeFile, access } from "fs/promises"
import { constants } from "fs"

type SessionParams = {
  agent?: string
  providerId?: string
  modelId?: string
  variant?: string
}

const sessionParamsCache = new Map<string, SessionParams>()

// Get API key from environment (set in mcpm/jarvis config)
const FAST_APPLY_API_KEY = process.env.FAST_APPLY_API_KEY || "optional-api-key"
const FAST_APPLY_URL = (process.env.FAST_APPLY_URL || "http://localhost:1234/v1").replace(/\/v1\/?$/, "")
const FAST_APPLY_MODEL = process.env.FAST_APPLY_MODEL || "fastapply-1.5b"

const FAST_APPLY_SYSTEM_PROMPT = `You are a precise code merging assistant. Your role:
1. Merge updates while preserving all original structure and formatting
2. Output ONLY valid code within specified XML tags
3. Never add explanations or text outside tags
4. Preserve all escaped XML entities exactly as provided
5. Ensure output is syntactically valid and complete`

const FAST_APPLY_USER_PROMPT = `Merge <update> into <code> and output the complete merged file.

RULES:
- Preserve: structure, order, comments, indentation, escaped entities
- Output: entire file within <updated-code></updated-code> tags only
- Forbidden: explanations, placeholders, ellipses, code fences, nested tags
- Validation: ensure syntactically valid, complete code

<code>{original_code}</code>

<update>{update_snippet}</update>

Output complete merged code:`

const TOOL_INSTRUCTIONS = `DEFAULT tool for editing existing files. Use INSTEAD of native 'edit' tool.

CRITICAL: For EXISTING files ONLY. Use 'write' for new files.

WORKFLOW:
1. Read the file to understand current content
2. Extract relevant section (50-500 lines with context)
3. Call fast_apply_edit with original_code (partial) and code_edit

PARTIAL EDITING:
- You DON'T need to provide the entire file
- Provide 50-500 lines of context around the area you want to change
- Include 2-5 lines before and after the target section
- Tool will automatically find and replace that section in the file

PRIORITY:
1. fast_apply_edit - ALL file edits (default, 10x faster)
2. edit - Fallback if API fails
3. write - NEW files only

FORMAT:
Use \`// ... existing code ...\` markers for unchanged sections:
\`\`\`
// ... existing code ...
function updated() { return "modified"; }
// ... existing code ...
\`\`\`

RULES:
- MANDATORY: Read file first to get original_code
- Provide 50-500 lines of context (not entire file unless small)
- Use \`// ... existing code ...\` markers in code_edit
- Include 2-5 lines context before/after edits
- Preserve exact indentation and whitespace
- ONE edit block per call (multiple blocks = suboptimal)

EXAMPLE:
\`\`\`typescript
// 1. Read file
const content = await read("src/app.ts", { offset: 100, limit: 50 })

// 2. Call fast_apply_edit with partial context
fast_apply_edit({
  target_filepath: "src/app.ts",
  original_code: content,  // Just 50 lines, not entire file!
  code_edit: "... updated code ..."
})
\`\`\`

FALLBACK: If API fails, use native 'edit' tool.`

function escapeXmlTags(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function unescapeXmlTags(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

function validateNoNestedTags(content: string): void {
  const unescaped = content
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
  
  if (unescaped.includes("<updated-code>") || unescaped.includes("</updated-code>")) {
    throw new Error("Content contains unescaped tag-like sequences that could break parsing")
  }
  
  if (unescaped.includes("<code>") || unescaped.includes("</code>")) {
    throw new Error("Content contains unescaped <code> tags that could break prompt structure")
  }
  
  if (unescaped.includes("<update>") || unescaped.includes("</update>")) {
    throw new Error("Content contains unescaped <update> tags that could break prompt structure")
  }
}

function extractUpdatedCode(raw: string): string {
  const stripped = raw.trim()
  
  const startRegex = /<updated-code\s*>/i
  const endRegex = /<\/updated-code\s*>/i
  
  const startMatch = stripped.match(startRegex)
  if (!startMatch || startMatch.index === undefined) {
    throw new Error("Missing or malformed <updated-code> start tag in AI response")
  }
  
  const startIdx = startMatch.index + startMatch[0].length
  const remaining = stripped.slice(startIdx)
  
  const endMatch = remaining.match(endRegex)
  if (!endMatch || endMatch.index === undefined) {
    throw new Error("Missing or malformed </updated-code> end tag in AI response")
  }
  
  const endIdx = endMatch.index
  const inner = remaining.slice(0, endIdx)
  
  if (!inner.trim()) {
    throw new Error("Empty updated-code block in AI response")
  }
  
  const unescaped = unescapeXmlTags(inner)
  
  validateNoNestedTags(unescaped)
  
  return unescaped
}

function generateUnifiedDiff(
  filepath: string,
  original: string,
  modified: string
): string {
  const patch = createTwoFilesPatch(
    `a/${filepath}`,
    `b/${filepath}`,
    original,
    modified,
    "",
    "",
    { context: 3 }
  )
  if (!patch.includes("@@")) {
    return "No changes detected"
  }
  return patch
}

/**
 * Count additions and deletions from a unified diff
 */
function countChanges(diff: string): { added: number; removed: number } {
  const lines = diff.split("\n")
  let added = 0
  let removed = 0

  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added++
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed++
    }
  }

  return { added, removed }
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`.replace(".0K", "K")
  }
  return tokens.toString()
}

function shortenPath(filePath: string, workingDir: string): string {
  if (filePath.startsWith(workingDir + "/")) {
    return filePath.slice(workingDir.length + 1)
  }
  if (filePath === workingDir) {
    return "."
  }
  return filePath
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function formatDiffForMarkdown(diff: string): string {
  return "```diff\n" + diff + "\n```"
}

function normalizeWhitespace(text: string): string {
  return text
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/\r\n/g, '\n')
    .trim()
}

function findExactMatch(haystack: string, needle: string): number {
  return haystack.indexOf(needle)
}

function findNormalizedMatch(haystack: string, needle: string): number {
  const normalizedHaystack = normalizeWhitespace(haystack)
  const normalizedNeedle = normalizeWhitespace(needle)
  
  const index = normalizedHaystack.indexOf(normalizedNeedle)
  
  if (index === -1) return -1
  
  let actualIndex = 0
  let normalizedIndex = 0
  
  while (normalizedIndex < index && actualIndex < haystack.length) {
    const char = haystack[actualIndex]
    const normalizedChar = normalizedHaystack[normalizedIndex]
    
    if (char === '\r' && haystack[actualIndex + 1] === '\n') {
      actualIndex += 2
      normalizedIndex += 1
    } else if (char === normalizedChar) {
      actualIndex++
      normalizedIndex++
    } else {
      actualIndex++
    }
  }
  
  return actualIndex
}

async function applyPartialEdit(
  filepath: string,
  original_code: string,
  merged_code: string
): Promise<{ success: boolean; newFileContent?: string; error?: string }> {
  const currentFile = await readFile(filepath, "utf-8")
  
  if (currentFile.includes('\0')) {
    return {
      success: false,
      error: "Cannot edit binary files"
    }
  }
  
  let index = findExactMatch(currentFile, original_code)
  let matchType = "exact"
  
  if (index === -1) {
    index = findNormalizedMatch(currentFile, original_code)
    matchType = "normalized"
  }
  
  if (index === -1) {
    return {
      success: false,
      error: `Cannot locate original_code in ${filepath}.

The content you provided doesn't match the current file.

POSSIBLE CAUSES:
- File was modified since you read it
- Whitespace or indentation differs
- Wrong section provided
- File encoding issues

SOLUTIONS:
1. Re-read the file to get current content
2. Verify exact whitespace and indentation
3. Provide more context (more surrounding lines)
4. Use native 'edit' tool for exact string matching`
    }
  }
  
  const occurrences = currentFile.split(original_code).length - 1
  if (occurrences > 1) {
    return {
      success: false,
      error: `original_code appears ${occurrences} times in ${filepath}.

Please provide more context (more surrounding lines) to uniquely identify the section you want to edit.`
    }
  }
  
  const newFileContent = 
    currentFile.substring(0, index) +
    merged_code +
    currentFile.substring(index + original_code.length)
  
  console.log(`[fast-apply] Applied ${matchType} match at position ${index}`)
  
  return {
    success: true,
    newFileContent
  }
}

function formatFastApplyResult(
  filePath: string,
  workingDir: string,
  insertions: number,
  deletions: number,
  diffPreview: string,
  modifiedTokens: number
): string {
  const shortPath = shortenPath(filePath, workingDir)
  const tokenStr = formatTokenCount(modifiedTokens)

  const lines = [
    "✓ Fast Apply complete",
    "",
    `File: ${shortPath}`,
    `Changes: +${insertions} -${deletions} (~${tokenStr} tokens)`,
    "",
    "Unified diff:",
    diffPreview
  ]

  return lines.join("\n")
}

function formatErrorOutput(error: string, filePath: string, workingDir: string): string {
  const shortPath = shortenPath(filePath, workingDir)

  return [
    "✗ Fast Apply failed",
    "",
    `File: ${shortPath}`,
    `Error: ${error}`,
    "",
    "Fallback: Use native 'edit' tool with exact string matching"
  ].join("\n")
}

/**
 * Call OpenAI's Fast Apply API to merge code edits
 */
async function callFastApply(
  originalCode: string,
  codeEdit: string
): Promise<{ success: boolean; content?: string; error?: string }> {
  if (!FAST_APPLY_API_KEY) {
    return {
      success: false,
      error:
        "FAST_APPLY_API_KEY not set. Get one at https://openai.com/api",
    }
  }

  try {
    const escapedOriginalCode = escapeXmlTags(originalCode)
    const escapedCodeEdit = escapeXmlTags(codeEdit)

    const userContent = FAST_APPLY_USER_PROMPT
      .replace("{original_code}", escapedOriginalCode)
      .replace("{update_snippet}", escapedCodeEdit)

    const response = await fetch(`${FAST_APPLY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${FAST_APPLY_API_KEY}`,
      },
      body: JSON.stringify({
        model: FAST_APPLY_MODEL,
        messages: [
          {
            role: "system",
            content: FAST_APPLY_SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: userContent,
          },
        ],
        temperature: 0,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      return {
        success: false,
        error: `Fast Apply API error (${response.status}): ${errorText}`,
      }
    }

    const result = (await response.json()) as {
      choices: Array<{ message: { content: string } }>
    }
    const rawResponse = result.choices?.[0]?.message?.content

    if (!rawResponse) {
      return {
        success: false,
        error: "Fast Apply API returned empty response",
      }
    }

    try {
      const mergedCode = extractUpdatedCode(rawResponse)
      return {
        success: true,
        content: mergedCode,
      }
    } catch (parseError) {
      const error = parseError as Error
      return {
        success: false,
        error: `Failed to parse AI response: ${error.message}`,
      }
    }
  } catch (err) {
    const error = err as Error
    return {
      success: false,
      error: `Fast Apply API request failed: ${error.message}`,
    }
  }
}

async function sendTUIMessage(
  client: any,
  sessionID: string,
  message: string,
  params: SessionParams
): Promise<void> {
  const agent = params.agent || undefined
  const variant = params.variant || undefined
  const model = params.providerId && params.modelId
    ? {
        providerID: params.providerId,
        modelID: params.modelId,
      }
    : undefined

  try {
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        agent: agent,
        model: model,
        variant: variant,
        parts: [
          {
            type: "text",
            text: message,
            ignored: true,
          },
        ],
      },
    })
  } catch (error: any) {
    console.error("[fast-apply] Failed to send TUI notification:", error.message)
  }
}

async function sendTUINotification(
  client: any,
  sessionID: string,
  filePath: string,
  workingDir: string,
  insertions: number,
  deletions: number,
  modifiedTokens: number,
  diff: string,
  params: SessionParams
): Promise<void> {
  const shortPath = shortenPath(filePath, workingDir)
  const tokenStr = formatTokenCount(modifiedTokens)
  
  const message = [
    `▣ Fast Apply | ~${tokenStr} tokens modified`,
    "",
    `Applied changes to ${shortPath} (+${insertions} -${deletions}):`,
    "",
    formatDiffForMarkdown(diff)
  ].join("\n")

  await sendTUIMessage(client, sessionID, message, params)
}

async function sendTUIErrorNotification(
  client: any,
  sessionID: string,
  filePath: string,
  workingDir: string,
  errorMessage: string,
  params: SessionParams
): Promise<void> {
  const shortPath = shortenPath(filePath, workingDir)
  
  const message = [
    `✗ Fast Apply Error`,
    "",
    `File: ${shortPath}`,
    `Error: ${errorMessage}`,
    "",
    "Fallback: Use native 'edit' tool"
  ].join("\n")

  await sendTUIMessage(client, sessionID, message, params)
}

export const FastApplyPlugin: Plugin = async ({ directory, client }) => {
  if (!FAST_APPLY_API_KEY) {
    console.warn(
      "[fast-apply] FAST_APPLY_API_KEY not set - fast_apply_edit tool will be disabled"
    )
  } else {
    console.log(
      `[fast-apply] Plugin loaded with model: ${FAST_APPLY_MODEL} at ${FAST_APPLY_URL}`
    )
  }

  return {
    "chat.message": async (input: {
      sessionID: string
      agent?: string
      model?: { providerID: string; modelID: string }
      variant?: string
    }) => {
      sessionParamsCache.set(input.sessionID, {
        agent: input.agent,
        providerId: input.model?.providerID,
        modelId: input.model?.modelID,
        variant: input.variant,
      })
    },
    tool: {
      fast_apply_edit: tool({
        description: TOOL_INSTRUCTIONS,

        args: {
          target_filepath: tool.schema
            .string()
            .describe("Path of the file to modify (relative to project root)"),
          original_code: tool.schema
            .string()
            .describe(`The original code section to be modified. 

IMPORTANT:
- Provide 50-500 lines of context around the area you want to change
- Include 2-5 lines before and after the target section
- Must match the current file content exactly (whitespace matters)
- Can be partial (doesn't need to be entire file)

WORKFLOW:
1. Read the file first to get current content
2. Extract the relevant section with context
3. Provide that section as original_code`),
          code_edit: tool.schema
            .string()
            .describe(
              'The updated code with changes applied. Use "// ... existing code ..." markers for unchanged sections within this context.'
            ),
        },

        async execute(args, toolCtx) {
          const { target_filepath, original_code, code_edit } = args

          const params = sessionParamsCache.get(toolCtx.sessionID) || {}

          // Resolve file path relative to project directory
          const filepath = target_filepath.startsWith("/")
            ? target_filepath
            : `${directory}/${target_filepath}`

          // Check if API key is available
          if (!FAST_APPLY_API_KEY) {
            return `Error: FAST_APPLY_API_KEY not configured.

To use fast_apply_edit, set the FAST_APPLY_API_KEY environment variable.
Get your API key at: https://openai.com/api

Alternatively, use the native 'edit' tool for this change.`
          }

          // Check if file exists and is writable
          try {
            await access(filepath, constants.R_OK | constants.W_OK)
          } catch (err) {
            return `Error: File not found or not writable: ${target_filepath}

This tool is for EDITING EXISTING FILES ONLY.
For new file creation, use the 'write' tool instead.

Example:
write({
  filePath: "${target_filepath}",
  content: "your file content here"
})`
          }

          // Call Fast Apply API to merge the edit
          const result = await callFastApply(
            original_code,
            code_edit
          )

          if (!result.success || !result.content) {
            const errorMsg = result.error || "Unknown error"
            await sendTUIErrorNotification(
              client,
              toolCtx.sessionID,
              target_filepath,
              directory,
              errorMsg,
              params
            )
            return formatErrorOutput(errorMsg, target_filepath, directory)
          }

          const mergedCode = result.content

          // Apply partial edit with smart matching
          const applyResult = await applyPartialEdit(filepath, original_code, mergedCode)

          if (!applyResult.success) {
            await sendTUIErrorNotification(
              client,
              toolCtx.sessionID,
              target_filepath,
              directory,
              applyResult.error!,
              params
            )
            return formatErrorOutput(applyResult.error!, target_filepath, directory)
          }

          // Write merged file back
          try {
            await writeFile(filepath, applyResult.newFileContent!, "utf-8")
          } catch (err) {
            const error = err as Error
            await sendTUIErrorNotification(
              client,
              toolCtx.sessionID,
              target_filepath,
              directory,
              error.message,
              params
            )
            return formatErrorOutput(error.message, target_filepath, directory)
          }

          // Read origfile for diff comparison
          const originalFileContent = await readFile(filepath, "utf-8")
          const diff = generateUnifiedDiff(
            target_filepath,
            originalFileContent,
            applyResult.newFileContent!
          )

          const { added, removed } = countChanges(diff)
          const modifiedTokens = estimateTokens(diff)

          await sendTUINotification(
            client,
            toolCtx.sessionID,
            target_filepath,
            directory,
            added,
            removed,
            modifiedTokens,
            diff,
            params
          )

          return formatFastApplyResult(
            target_filepath,
            directory,
            added,
            removed,
            diff,
            modifiedTokens
          )
        },
      }),
    },
  }
}

// Default export for OpenCode plugin loader
export default FastApplyPlugin