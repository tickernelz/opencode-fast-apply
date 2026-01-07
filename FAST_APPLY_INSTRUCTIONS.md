# Fast Apply - Tool Selection Guide

**CRITICAL: Use `fast_apply_edit` as your DEFAULT tool for ALL file editing operations.**

## Tool Selection Priority

| Priority | Tool | Use Case |
|----------|------|----------|
| **1st** | `fast_apply_edit` | **ALL file editing operations** (default choice) |
| **2nd** | `edit` | Fallback only when `fast_apply_edit` fails |
| **3rd** | `write` | **ONLY for creating NEW files** |

## Default Behavior

**ALWAYS use `fast_apply_edit` for editing existing files unless:**
- Fast Apply API is unavailable or returns error
- You need guaranteed exact string replacement
- The file doesn't exist yet (use `write` instead)

## Tool Selection Matrix

| Situation | Tool | Reason |
|-----------|------|--------|
| Edit existing file (any size) | `fast_apply_edit` | **DEFAULT**, handles lazy markers, robust |
| Small change (1-2 lines) | `fast_apply_edit` | **DEFAULT**, no need to switch tools |
| Large file (500+ lines) | `fast_apply_edit` | **DEFAULT**, optimal performance with partial snippets |
| Multiple scattered changes | `fast_apply_edit` | **DEFAULT**, batch changes efficiently |
| Complex refactoring | `fast_apply_edit` | **DEFAULT**, better accuracy with context |
| Whitespace-sensitive edits | `fast_apply_edit` | **DEFAULT**, forgiving with formatting |
| Special characters in code | `fast_apply_edit` | **DEFAULT**, handles XML tags, regex, etc. |
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
2. **Fallback to native `edit` tool** with exact string matching
3. The `edit` tool requires matching exact text from the file

**Note:** API failures are rare. Always try `fast_apply_edit` first.

## When to Use Native 'edit' Tool

- **ONLY as fallback** when `fast_apply_edit` fails
- When Fast Apply API is unavailable
- When you need guaranteed exact string replacement

## When to Use 'write' Tool

- **ONLY for creating NEW files**
- Never use `fast_apply_edit` for file creation
- Provide complete file content without lazy markers
