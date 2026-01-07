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

// Get API key from environment (set in mcpm/jarvis config)
const FAST_APPLY_API_KEY = process.env.FAST_APPLY_API_KEY || "optional-api-key"
const FAST_APPLY_URL = (process.env.FAST_APPLY_URL || "http://localhost:1234/v1").replace(/\/v1\/?$/, "")
const FAST_APPLY_MODEL = process.env.FAST_APPLY_MODEL || "fastapply-1.5b"
const FAST_APPLY_TIMEOUT = parseInt(process.env.FAST_APPLY_TIMEOUT || "30000", 10)
const FAST_APPLY_TEMPERATURE = parseFloat(process.env.FAST_APPLY_TEMPERATURE || "0.05")
const FAST_APPLY_MAX_TOKENS = parseInt(process.env.FAST_APPLY_MAX_TOKENS || "8000", 10)

const FAST_APPLY_SYSTEM_PROMPT = "Merge code edits into original files. Preserve structure, indentation, and comments exactly."

const FAST_APPLY_USER_PROMPT = `Task: {instruction}

<code>{original_code}</code>
<update>{update_snippet}</update>

Output complete merged code in <updated-code></updated-code> tags. No explanations, markdown, or ellipses.`

const UPDATED_CODE_START = "<updated-code>"
const UPDATED_CODE_END = "</updated-code>"

const TOOL_INSTRUCTIONS = `**DEFAULT tool for editing existing files. Use INSTEAD of native 'edit' tool.**

CRITICAL: For EXISTING files ONLY. Use 'write' for new files.

## Priority
1. \`fast_apply_edit\` - ALL file edits (default)
2. \`edit\` - Fallback if API fails
3. \`write\` - NEW files only

## Format
Use \`// ... existing code ...\` for unchanged sections:

\`\`\`
// ... existing code ...
function updated() {
  return "modified";
}
// ... existing code ...
\`\`\`

## Rules
- MANDATORY: Use \`// ... existing code ...\` markers
- Include 2-3 lines context before/after edits
- Preserve exact indentation
- ONE edit block per call (multiple blocks = suboptimal results)
- Deletions: show context, omit deleted lines
- NEVER for new files

## Examples

**Add function:**
\`\`\`
// ... existing code ...
import { newDep } from './newDep';
// ... existing code ...

function newFeature() {
  return newDep.process();
}
// ... existing code ...
\`\`\`

**Modify:**
\`\`\`
// ... existing code ...
function existingFunc(param) {
  const result = param * 2;
  return result;
}
// ... existing code ...
\`\`\`

**Delete:**
\`\`\`
// ... existing code ...
function keepThis() {
  return "stays";
}

function alsoKeepThis() {
  return "stays";
}
// ... existing code ...
\`\`\`

## Fallback
If API fails, use native \`edit\` tool with exact string matching.`

function escapeXmlTags(text: string): string {
  return text
    .replace(/<updated-code>/g, "&lt;updated-code&gt;")
    .replace(/<\/updated-code>/g, "&lt;/updated-code&gt;")
}

function unescapeXmlTags(text: string): string {
  return text
    .replace(/&lt;updated-code&gt;/g, "<updated-code>")
    .replace(/&lt;\/updated-code&gt;/g, "</updated-code>")
}

function extractUpdatedCode(raw: string): string {
  const stripped = raw.trim()
  const start = stripped.indexOf(UPDATED_CODE_START)
  const end = stripped.lastIndexOf(UPDATED_CODE_END)
  
  if (start === -1 || end === -1 || end <= start) {
    if (stripped.startsWith("```") && stripped.endsWith("```")) {
      const lines = stripped.split("\n")
      if (lines.length >= 2) {
        return unescapeXmlTags(lines.slice(1, -1).join("\n"))
      }
    }
    return unescapeXmlTags(stripped)
  }
  
  const inner = stripped.substring(start + UPDATED_CODE_START.length, end)
  if (!inner || inner.trim().length === 0) {
    throw new Error("Empty updated-code block")
  }
  
  return unescapeXmlTags(inner)
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

function truncate(str: string, maxLen: number = 80): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 3) + "..."
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

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FAST_APPLY_TIMEOUT)

  try {
    const escapedOriginalCode = escapeXmlTags(originalCode)
    const escapedCodeEdit = escapeXmlTags(codeEdit)
    
    const userContent = FAST_APPLY_USER_PROMPT
      .replace("{instruction}", instructions || "Apply the requested code changes.")
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
        temperature: FAST_APPLY_TEMPERATURE,
        max_tokens: FAST_APPLY_MAX_TOKENS,
      }),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

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

    const mergedCode = extractUpdatedCode(rawResponse)

    return {
      success: true,
      content: mergedCode,
    }
  } catch (err) {
    clearTimeout(timeoutId)
    const error = err as Error
    if (error.name === "AbortError") {
      return {
        success: false,
        error: `Fast Apply API timeout after ${FAST_APPLY_TIMEOUT}ms`,
      }
    }
    return {
      success: false,
      error: `Fast Apply API request failed: ${error.message}`,
    }
  }
}

async function sendTUINotification(
  client: any,
  sessionID: string,
  filePath: string,
  workingDir: string,
  insertions: number,
  deletions: number,
  modifiedTokens: number
): Promise<void> {
  const shortPath = shortenPath(filePath, workingDir)
  const tokenStr = formatTokenCount(modifiedTokens)
  
  const message = [
    `▣ Fast Apply | ~${tokenStr} tokens modified`,
    "",
    "Applied changes:",
    `→ ${shortPath}: +${insertions} -${deletions}`
  ].join("\n")

  try {
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
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
            return formatErrorOutput(result.error || "Unknown error", target_filepath, directory)
          }

          const mergedCode = result.content

          try {
            await writeFile(filepath, mergedCode, "utf-8")
          } catch (err) {
            const error = err as Error
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
            modifiedTokens
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