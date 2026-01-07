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
- MANDATORY: Use \`// ... existing code ...\` markers
- Include 2-3 lines context before/after edits
- Preserve exact indentation
- ONE edit block per call (multiple blocks = suboptimal)
- Deletions: show context, omit deleted lines

FALLBACK: If API fails, use native 'edit' tool with exact string matching.`

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
  codeEdit: string,
  instructions: string
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
  params: SessionParams
): Promise<void> {
  const shortPath = shortenPath(filePath, workingDir)
  const tokenStr = formatTokenCount(modifiedTokens)
  
  const message = [
    `▣ Fast Apply | ~${tokenStr} tokens modified`,
    "",
    "Applied changes:",
    `→ ${shortPath}: +${insertions} -${deletions}`
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
          instructions: tool.schema
            .string()
            .describe(
              "Brief first-person description of what you're changing (helps disambiguate)"
            ),
          code_edit: tool.schema
            .string()
            .describe(
              'The code changes with "// ... existing code ..." markers for unchanged sections'
            ),
        },

        async execute(args, toolCtx) {
          const { target_filepath, instructions, code_edit } = args

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

          // Read the original file
          let originalCode: string
          try {
            await access(filepath, constants.R_OK)
            originalCode = await readFile(filepath, "utf-8")
          } catch (err) {
            const error = err as Error
            if (error.message.includes("ENOENT") || error.message.includes("no such file")) {
              return `Error: File not found: ${target_filepath}

This tool is for EDITING EXISTING FILES ONLY.
For new file creation, use the 'write' tool instead.

Example:
write({
  filePath: "${target_filepath}",
  content: "your file content here"
})`
            }
            return `Error reading file ${target_filepath}: ${error.message}`
          }

          // Call OpenAI API to merge the edit
          const result = await callFastApply(
            originalCode,
            code_edit,
            instructions
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

          try {
            await writeFile(filepath, mergedCode, "utf-8")
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

          const diff = generateUnifiedDiff(
            target_filepath,
            originalCode,
            mergedCode
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