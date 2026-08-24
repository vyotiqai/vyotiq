---
title: Indexing and dictation issues
description: Recover from model downloads, hash fallback, reindex failures, Ollama embedding errors, and voice setup problems.
section: troubleshooting
order: 5
type: troubleshooting
audience: Search and voice users
related:
  - tools/indexing
  - tools/voice-dictation
  - reference/storage
---

## Semantic search is unavailable

Open Settings → Indexing. Confirm Enable codebase index is on. When off, `codebase_search` is removed from the tool catalog.

Read Index status:

- downloading or loading: wait for the active model phase.
- indexing: inspect file and chunk progress.
- `fallback_hash`: dense embedding failed and local hash is serving as fallback.
- error: preserve the message before changing settings.

Use Reindex workspace once after fixing the cause.

## Local dense model download fails

Confirm Auto-download model, network access, disk space, and model-directory permissions. A partial model must pass required-file validation before it becomes ready.

## Ollama embedder fails

Confirm Ollama is reachable and Ollama embedding model exists on that host. The default model is nomic-embed-text. A remote Ollama host receives the indexed text.

## Dictation mic or transcription fails

Open [Settings → Voice](/docs/tools/voice-dictation) and confirm the selected Dictation engine:

- **OpenAI** needs a saved **OpenAI** key.
- **OpenRouter** needs a saved **OpenRouter** key.
- **Local** needs an installed Whisper model.

The engine is read on mic stop. Installation alone does not switch to **Local**.

## Local Whisper fails

Check the model card for download, load, or error status. Try Unload before reloading. Use Delete … cache only when you intend to redownload required model files.

The supported local IDs are whisper-tiny.en and whisper-small.en. **Local** transcription is English.

## Collect evidence

Record app version, platform, selected embedder or dictation engine, model ID, phase, progress text, and exact error. Do not delete indexes or caches before capturing the error unless the recovery step specifically requires it.
