# Fast Apply - Tool Selection Guide

**CRITICAL: Use `fast_apply_edit` as your PRIMARY tool for ALL file editing operations.**

## Tool Selection Priority

| Priority | Tool | Use Case |
|----------|------|----------|
| **1st** | `fast_apply_edit` | **ALL file editing operations** (default choice) |
| **2nd** | `edit` | Fallback only when `fast_apply_edit` fails |
| **3rd** | `write` | **ONLY for creating NEW files** |

## Tool Selection Matrix

| Situation | Tool | Reason |
|-----------|------|--------|
| Edit existing file (any size) | `fast_apply_edit` | Primary tool, 10x faster, handles lazy markers |
| Large file (500+ lines) | `fast_apply_edit` | Optimal performance with partial snippets |
| Multiple scattered changes | `fast_apply_edit` | Batch changes efficiently |
| Complex refactoring | `fast_apply_edit` | Better accuracy with context |
| Whitespace-sensitive edits | `fast_apply_edit` | Forgiving with formatting |
| Fast Apply API fails | `edit` | Fallback with exact string matching |
| **New file creation** | `write` | **NEVER use fast_apply_edit for new files** |

## Using fast_apply_edit

The `fast_apply_edit` tool uses **lazy edit markers** to represent unchanged code:

```javascript
// ... existing code ...
function updatedFunction() {
  // New implementation
  return "modified";
}
// ... existing code ...
```

### Parameters

- `target_filepath`: Path to the file (relative to project root)
- `instructions`: Brief description of changes (helps AI disambiguate)
- `code_edit`: Code with `// ... existing code ...` markers

### Rules

1. **MANDATORY**: Use `// ... existing code ...` for unchanged sections
2. Include **2-3 lines of context** before and after each edit
3. Preserve **exact indentation** from original file
4. For **deletions**: show context before/after, omit the deleted lines
5. **Batch** multiple edits to the same file in one call
6. **NEVER** use for new file creation - use `write` tool instead

### Examples

**Adding a function:**
```
// ... existing code ...
import { newDep } from './newDep';
// ... existing code ...

function newFeature() {
  return newDep.process();
}
// ... existing code ...
```

**Modifying existing code:**
```
// ... existing code ...
function existingFunc(param) {
  // Updated implementation
  const result = param * 2; // Changed from * 1
  return result;
}
// ... existing code ...
```

**Deleting code (show what remains):**
```
// ... existing code ...
function keepThis() {
  return "stays";
}

// The function between these two was removed

function alsoKeepThis() {
  return "also stays";
}
// ... existing code ...
```

## Fallback Behavior

If Fast Apply API fails (timeout, network error, etc.):
1. Tool returns error message with details
2. **Falnative `edit` tool** with exact string matching
3. The `edit` tool requires matching exact text from the file

## When to Use Native 'edit' Tool

- **ONLY as fallback** when `fast_apply_edit` fails
- When Fast Apply API is unavailable
- When you need guaranteed exact string replacement

## When to Use 'write' Tool

- **ONLY for creating NEW files**
- Never use `fast_apply_edit` for file creation
- Provide complete file content without lazy markers

## Configuration

Ensure these environment variables are set:

```bash
# For LM Studio (default)
export FAST_APPLY_URL="http://localhost:1234/v1"
export FAST_APPLY_MODEL="fastapply-1.5b"
export FAST_APPLY_API_KEY="optional-api-key"

# For Ollama
export FAST_APPLY_URL="http://localhost:11434/v1"
export FAST_APPLY_MODEL="codellama:7b"

# For OpenAI
export FAST_APPLY_URL="https://api.openai.com/v1"
export FAST_APPLY_MODEL="gpt-4"
export FAST_APPLY_API_KEY="sk-your-key"
```

## Performance Benefits

- **10,500+ tokens/sec** processing speed
- No exact string matching required
- Handles whitespace variations gracefully
- Batch multiple edits efficiently
- Works with files of any size
