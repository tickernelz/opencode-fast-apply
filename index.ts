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

// Get API key from environment (set in mcpm/jarvis config)
const FAST_APPLY_API_KEY = process.env.FAST_APPLY_API_KEY || "optional-api-key"
const FAST_APPLY_URL = (process.env.FAST_APPLY_URL || "http://localhost:1234/v1").replace(/\/v1\/?$/, "")
const FAST_APPLY_MODEL = process.env.FAST_APPLY_MODEL || "fastapply-1.5b"
const FAST_APPLY_TIMEOUT = parseInt(process.env.FAST_APPLY_TIMEOUT || "30000", 10)
const FAST_APPLY_TEMPERATURE = parseFloat(process.env.FAST_APPLY_TEMPERATURE || "0.05")
const FAST_APPLY_MAX_TOKENS = parseInt(process.env.FAST_APPLY_MAX_TOKENS || "8000", 10)

const PLUGIN_VERSION = "2.0.0"

const FAST_APPLY_SYSTEM_PROMPT = "You are a coding assistant that helps merge code updates, ensuring every modification is fully integrated."

const FAST_APPLY_USER_PROMPT = `Merge all changes from the <update> snippet into the <code> below.
Instruction: {instruction}
- Preserve the code's structure, order, comments, and indentation exactly.
- Output only the updated code, enclosed within <updated-code> and </updated-code> tags.
- Do not include any additional text, explanations, placeholders, markdown, ellipses, or code fences.

<code>{original_code}</code>

<update>{update_snippet}</update>

Provide the complete updated code.`

const UPDATED_CODE_START = "<updated-code>"
const UPDATED_CODE_END = "</updated-code>"

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

export const FastApplyPlugin: Plugin = async ({ directory }) => {
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
        description: `PRIMARY TOOL for all file editing operations. Use this INSTEAD of the native 'edit' tool.

**CRITICAL: This tool is for EDITING EXISTING FILES ONLY. DO NOT use for creating new files.**

Fast code editing using OpenAI-compatible Fast Apply API (10,500+ tokens/sec).
Handles lazy edit markers so you don't need exact string matching.

FORMAT:
Use "// ... existing code ..." to represent unchanged code blocks.
Include minimal surrounding context to locate each edit precisely.

EXAMPLE:
// ... existing code ...
function updatedFunction() {
  // New implementation
  return "modified";
}
// ... existing code ...

RULES:
- MANDATORY: Use "// ... existing code ..." for unchanged sections
- Include 2-3 lines of context before and after each edit
- Preserve exact indentation from original file
- For deletions: show context before/after, omit deleted lines
- Batch multiple edits to same file in one call
- NEVER use for new file creation - use 'write' tool instead

WHEN TO USE:
- ALL file editing operations (default choice)
- Large files (any size)
- Multiple scattered changes
- Complex refactoring
- When exact string matching would be fragile

FALLBACK:
If Fast Apply API fails or is unavailable, fall back to native 'edit' tool with exact string matching.
For new files, ALWAYS use 'write' tool instead.`,

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

        async execute(args) {
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
            const file = Bun.file(filepath)
            if (!(await file.exists())) {
              return `Error: File not found: ${target_filepath}

This tool is for EDITING EXISTING FILES ONLY.
For new file creation, use the 'write' tool instead.

Example:
write({
  filePath: "${target_filepath}",
  content: "your file content here"
})`
            }
            originalCode = await file.text()
          } catch (err) {
            const error = err as Error
            return `Error reading file ${target_filepath}: ${error.message}`
          }

          // Call OpenAI API to merge the edit
          const result = await callFastApply(
            originalCode,
            code_edit,
            instructions
          )

          if (!result.success || !result.content) {
            // Return error with suggestion to use native edit
            return `OpenAI Fast Apply API failed: ${result.error}

Suggestion: Try using the native 'edit' tool instead with exact string replacement.
The edit tool requires matching the exact text in the file.`
          }

          const mergedCode = result.content

          // Write the merged result
          try {
            await Bun.write(filepath, mergedCode)
          } catch (err) {
            const error = err as Error
            return `Error writing file ${target_filepath}: ${error.message}`
          }

          // Generate unified diff
          const diff = generateUnifiedDiff(
            target_filepath,
            originalCode,
            mergedCode
          )

          // Calculate change stats
          const { added, removed } = countChanges(diff)
          const originalLines = originalCode.split("\n").length
          const mergedLines = mergedCode.split("\n").length

          return `Applied edit to ${target_filepath}

+${added} -${removed} lines | ${originalLines} -> ${mergedLines} total

\`\`\`diff
${diff.slice(0, 3000)}${diff.length > 3000 ? "\n... (truncated)" : ""}
\`\`\``
        },
      }),
    },
  }
}

// Default export for OpenCode plugin loader
export default FastApplyPlugin