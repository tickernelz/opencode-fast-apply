# opencode-fast-apply

OpenCode plugin for Fast Apply - High-performance code editing with OpenAI-compatible APIs.

## Features

- **Partial file editing** - Only send relevant sections (50-500 lines), not entire files
- **Smart context matching** - Automatically finds and replaces code sections
- **Token efficient** - Save 80-98% tokens compared to full-file edits
- **Lazy edit markers** - Use `// ... existing code ...` for unchanged sections
- **Multi-backend support** - LM Studio, Ollama, OpenAI, any OpenAI-compatible endpoint
- **Robust XML handling** - Safely handles special characters and XML tags in code

## Installation

```bash
npm install -g opencode-fast-apply
```

Configure your API endpoint:

```bash
# LM Studio (default)
export FAST_APPLY_URL="http://localhost:1234"
export FAST_APPLY_MODEL="fastapply-1.5b"
export FAST_APPLY_API_KEY="optional-api-key"

# Ollama
export FAST_APPLY_URL="http://localhost:11434"
export FAST_APPLY_MODEL="codellama:7b"

# OpenAI
export FAST_APPLY_URL="https://api.openai.com"
export FAST_APPLY_MODEL="gpt-4"
export FAST_APPLY_API_KEY="sk-your-key"
```

Add to OpenCode config (`~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["opencode-fast-apply"]
}
```

Restart OpenCode. The `fast_apply_edit` tool is now available.

## Usage

```typescript
// 1. Read relevant section (not entire file)
const content = await read("src/app.ts", { offset: 100, limit: 50 })

// 2. Edit with partial context
fast_apply_edit({
  target_filepath: "src/app.ts",
  original_code: content,  // Just 50 lines!
  code_edit: `// ... existing code ...
function updated() {
  return "modified";
}
// ... existing code ...`
})
```

**Key points:**
- Provide 50-500 lines of context around the area you want to change
- Include 2-5 lines before/after the target section
- Tool automatically finds and replaces that section in the full file
- No need to send entire file (saves tokens and improves speed)

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `FAST_APPLY_API_KEY` | `optional-api-key` | API key (optional for local) |
| `FAST_APPLY_URL` | `http://localhost:1234` | API endpoint |
| `FAST_APPLY_MODEL` | `fastapply-1.5b` | Model name |

## How It Works

1. AI reads relevant file section (50-500 lines)
2. AI provides `original_code` (partial context) and `code_edit`
3. Tool sends to Fast Apply API for merging
4. Tool finds where `original_code` appears in full file
5. Tool replaces that section with merged code
6. Tool writes full file back and shows diff

## Token Savings

| File Size | Before (Full) | After (Partial) | Savings |
|-----------|--------------|-----------------|---------|
| 100 lines | 2,500 tokens | 500 tokens | -80% |
| 500 lines | 12,500 tokens | 1,000 tokens | -92% |
| 1000 lines | 25,000 tokens | 1,500 tokens | -94% |
| 5000 lines | 125,000 tokens | 2,000 tokens | -98% |

## Troubleshooting

**"Cannot locate original_code in file"**
- File was modified since you read it - re-read and try again
- Whitespace differs - tool tries normalized matching automatically
- Wrong section provided - verify you extracted the correct lines

**API connection issues**
```bash
curl -X POST http://localhost:1234/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"fastapply-1.5b","messages":[{"role":"user","content":"test"}]}'
```

## License

MIT
