# opencode-fast-apply

OpenCode plugin for Fast Apply - High-performance code editing with OpenAI-compatible APIs (LM Studio, Ollama).

## Features

- **High-speed code editing** via OpenAI-compatible Fast Apply API (speed depends on your hardware and model)
- **Lazy edit markers** (`// ... existing code ...`) - no exact string matching needed
- **Unified diff output** with context for easy review
- **Graceful fallback** - suggests native `edit` tool on API failure
- **Multi-backend support** - LM Studio, Ollama, OpenAI, and any OpenAI-compatible endpoint
- **Robust XML tag handling** - safely handles code containing `<updated-code>` tags
- **Special character support** - preserves all string literals, regex patterns, and escape sequences

## Installation

### 1. Install from npm (Recommended)

```bash
npm install -g opencode-fast-apply
```

### 2. Configure your API endpoint

For **LM Studio** (default):
```bash
export FAST_APPLY_URL="http://localhost:1234"
export FAST_APPLY_MODEL="fastapply-1.5b"
export FAST_APPLY_API_KEY="optional-api-key"
```

For **Ollama**:
```bash
export FAST_APPLY_URL="http://localhost:11434"
export FAST_APPLY_MODEL="codellama:7b"
export FAST_APPLY_API_KEY="optional-api-key"
```

For **OpenAI**:
```bash
export FAST_APPLY_URL="https://api.openai.com"
export FAST_APPLY_MODEL="gpt-4"
export FAST_APPLY_API_KEY="sk-your-openai-key"
```

**Note:** The plugin automatically handles URLs with or without `/v1` suffix.

### 3. Add the plugin to your OpenCode config

Add to your global config (`~/.config/opencode/opencode.json` or `opencode.jsonc`):

```json
{
  "plugin": [
    "opencode-fast-apply"
  ]
}
```

**That's it!** The plugin automatically embeds all instructions - no additional configuration needed.

### 4. Restart OpenCode

The `fast_apply_edit` tool will now be available and configured as the default editing tool.

## Usage

The LLM can use `fast_apply_edit` for efficient partial file edits:

```
fast_apply_edit({
  target_filepath: "sth.ts",
  instructions: "Add error handling for invalid tokens",
  code_edit: `// ... existing code ...
function validateToken(token) {
  if (!token) {
    throw new Error("Token is required");
  }
  // ... existing code ...
}
// ... existing code ...`
})
```

### When to use `fast_apply_edit` vs `edit`

| Situation | Tool | Reason |
|-----------|------|--------|
| Small, exact replacement | `edit` | Fast, no API call |
| Large file (500+ lines) | `fast_apply_edit` | Handles partial snippets |
| Multiple scattered changes | `fast_apply_edit` | Batch efficiently |
| Whitespace-sensitive | `fast_apply_edit` | Forgiving with formatting |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `FAST_APPLY_API_KEY` | `optional-api-key` | API key (optional for local servers) |
| `FAST_APPLY_URL` | `http://localhost:1234/v1` | OpenAI-compatible API endpoint |
| `FAST_APPLY_MODEL` | `fastapply-1.5b` | Model name |
| `FAST_APPLY_TIMEOUT` | `30000` | Request timeout in ms |
| `FAST_APPLY_TEMPERATURE` | `0.05` | Temperature (0.0-2.0) |

## How It Works

1. Reads the original file content
2. Escapes XML tags in code to prevent conflicts
3. Sends system prompt + user prompt with `<instruction>`, `<code>`, and `<update>` to OpenAI-compatible API
4. API intelligently merges the lazy edit markers with original code
5. Extracts result from `<updated-code>` tags and unescapes XML
6. Writes the merged result back to the file
7. Returns a unified diff showing what changed

## Performance

Performance varies based on your setup:

| Setup | Estimated Speed | Hardware Requirement |
|-------|----------------|---------------------|
| fastapply-1.5b (Q4) + RTX 4090 | 10,000-15,000 tok/s | High-end GPU |
| codellama:7b (Q4) + RTX 3060 | 3,000-5,000 tok/s | Mid-range GPU |
| codellama:7b (Q4) + CPU only | 50-200 tok/s | Modern CPU |
| OpenAI GPT-4 API | 100-500 tok/s | Network dependent |

**Factors affecting performance:**
- Model size (1.5B vs 7B vs 13B+ parameters)
- Quantization level (Q4 vs Q5 vs Q8 vs FP16)
- Hardware (GPU VRAM, CPU cores, RAM)
- Backend optimization (LM Studio vs Ollama)

## Supported Backends

- **LM Studio** - Local inference server with GPU acceleration
- **Ollama** - Local LLM runtime with easy model management
- **OpenAI** - Cloud API with high reliability
- **Any OpenAI-compatible endpoint** - Custom servers and providers

## Edge Cases Handled

- ✅ String literals containing `<updated-code>` tags
- ✅ Multiple XML-like tags in regex patterns
- ✅ Special characters (quotes, backslashes, unicode, SQL, HTML entities)
- ✅ Large files (500+ lines)
- ✅ Multiple scattered changes in single edit
- ✅ Complex nested structures
- ✅ Template strings with `${variable}`
- ✅ Whitespace and indentation preservation

## Troubleshooting

### API Connection Issues
```bash
# Test your endpoint
curl -X POST http://localhost:1234/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"fastapply-1.5b","messages":[{"role":"user","content":"test"}]}'
```

### Slow Performance
- Use smaller models (1.5B-3B parameters)
- Enable GPU acceleration in LM Studio/Ollama
- Use Q4 quantization for faster inference
- Increase `FAST_APPLY_MAX_TOKENS` if responses are truncated

### Timeout Errors
```bash
# Increase timeout for slower hardware
export FAST_APPLY_TIMEOUT="60000"  # 60 seconds
```

## Contributing

Contributions welcome! This plugin could potentially be integrated into OpenCode core.

## License

[MIT](LICENSE)
