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
const FAST_APPLY_TEMPERATURE = parseFloat(process.env.FAST_APPLY_TEMPERATURE || "0.05")

const FAST_APPLY_SYSTEM_PROMPT = "You are a coding assistant that helps merge code updates, ensuring every modification is fully integrated."

const FAST_APPLY_USER_PROMPT = `Merge all changes from the UPDATE_BLOCK into the ORIGINAL_BLOCK below.
- Preserve the code's structure, order, comments, and indentation exactly.
- Output only the updated code, enclosed within <<<RESULT>>> and <<<END_RESULT>>> delimiters.
- Do not include any additional text, explanations, placeholders, ellipses, or code fences.

<<<ORIGINAL_CODE>>>
{original_code}
<<<END_ORIGINAL>>>

<<<UPDATE_CODE>>>
{update_snippet}
<<<END_UPDATE>>>

Provide the complete updated code wrapped in <<<RESULT>>> and <<<END_RESULT>>>.`

const UPDATED_CODE_START = "<<<RESULT>>>"
const UPDATED_CODE_END = "<<<END_RESULT>>>"

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

function extractUpdatedCode(raw: string): string {
  const stripped = raw.trim()
  const startTag = UPDATED_CODE_START
  const endTag = UPDATED_CODE_END

  let startIdx = stripped.indexOf(startTag)
  if (startIdx === -1) {
    startIdx = stripped.indexOf("<<<RESULT")
    if (startIdx !== -1) {
      const closeTagIdx = stripped.indexOf(">>>", startIdx)
      if (closeTagIdx !== -1) {
        startIdx = closeTagIdx + 3
      }
    }
  } else {
    startIdx += startTag.length
  }

  if (startIdx === -1 || startIdx === startTag.length - 1) {
    if (stripped.startsWith("```") && stripped.endsWith("```")) {
      const lines = stripped.split("\n")
      if (lines.length >= 2) {
        return lines.slice(1, -1).join("\n")
      }
    }
    return stripped
  }

  let endIdx = stripped.indexOf(endTag, startIdx)
  if (endIdx === -1) {
    endIdx = stripped.indexOf("<<<END_RESULT", startIdx)
  }

  if (endIdx === -1) {
    const extracted = stripped.slice(startIdx).trim()
    const lastCloseTag = extracted.lastIndexOf("<<<")
    if (lastCloseTag !== -1 && extracted.slice(lastCloseTag).toLowerCase().includes("end")) {
      return extracted.slice(0, lastCloseTag).trim()
    }
    return extracted
  }

  const inner = stripped.substring(startIdx, endIdx)
  if (!inner || inner.trim().length === 0) {
    throw new Error("Empty result block")
  }

  return inner
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
    const userContent = FAST_APPLY_USER_PROMPT
      .replace("{original_code}", originalCode)
      .replace("{update_snippet}", codeEdit)

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

    const mergedCode = extractUpdatedCode(rawResponse)

    return {
      success: true,
      content: mergedCode,
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