# opencode-fast-apply

OpenCode plugin for Fast Apply - 10x faster code editing with OpenAI-compatible APIs (LM Studio, Ollama).

## Features

- **10,500+ tokens/sec** code editing via OpenAI-compatible Fast Apply API
- **Lazy edit markers** (`// ... existing code ...`) - no exact string matching needed
- **Unified diff output** with context for easy review
- **Graceful fallback** - suggests native `edit` tool on API failure
- **Multi-backend support** - LM Studio, Ollama, OpenAI, and any OpenAI-compatible endpoint

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/tickernelz/opencode-fast-apply.git ~/dev/oc-plugins/fast-apply
cd ~/dev/oc-plugins/fast-apply
npm install
```

### 2. Configure your API endpoint

For **LM Studio** (default):
```bash
export FAST_APPLY_URL="http://localhost:1234/v1"
export FAST_APPLY_MODEL="fastapply-1.5b"
export FAST_APPLY_API_KEY="optional-api-key"
```

For **Ollama**:
```bash
export FAST_APPLY_URL="http://localhost:11434/v1"
export FAST_APPLY_MODEL="codellama:7b"
export FAST_APPLY_API_KEY="optional-api-key"
```

For **OpenAI**:
```bash
export FAST_APPLY_URL="https://api.openai.com/v1"
export FAST_APPLY_MODEL="gpt-4"
export FAST_APPLY_API_KEY="sk-your-openai-key"
```

### 3. Add the plugin to your OpenCode config

Add to your global config (`~/.config/opencode/opencode.json`):

```json
{
  "plugin": [
    "/path/to/fast-apply"
  ],
  "instructions": [
    "/path/to/fast-apply/FAST_APPLY_INSTRUCTIONS.md"
  ]
}
```

Or in a project-local `.opencode/config.json`:

```json
{
  "plugin": [
    "~/dev/oc-plugins/fast-apply"
  ],
  "instructions": [
    "~/dev/oc-plugins/fast-apply/FAST_APPLY_INSTRUCTIONS.md"
  ]
}
```

### 4. Restart OpenCode

The `fast_apply_edit` tool will now be available.

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
| `FAST_APPLY_MAX_TOKENS` | `8000` | Maximum tokens in response |

## How It Works

1. Reads the original file content
2. Sends `<instruction>`, `<code>`, and `<update>` to OpenAI-compatible API
3. API intelligently merges the lazy edit markers with original code
4. Writes the merged result back to the file
5. Returns a unified diff showing what changed

## Supported Backends

- **LM Studio** - Local inference server
- **Ollama** - Local LLM runtime
- **OpenAI** - Cloud API
- **Any OpenAI-compatible endpoint** - Custom servers

## Contributing

Contributions welcome! This plugin could potentially be integrated into OpenCode core.

## License

[MIT](LICENSE)
