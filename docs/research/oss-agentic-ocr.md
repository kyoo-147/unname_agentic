# OSS agentic OCR research

**Date:** 2026-11-21.

**Scope:** Source-only inspection of the official repositories requested by the user.

**Method:** Refreshed shallow clones outside the production tree under `C:\refs`, confirmed each remote head with `git ls-remote`, and inspected source files at the SHAs below.

No upstream code was copied, vendored, executed, or modified.

## Decision summary

- **Best design reference:** `OpenDataLab/AgenticOCR` for query-driven crop, zoom, rotation, OCR, and source-coordinate evidence.
- **Best verification reference:** `AIGeeksGroup/OCR-Agent` for bounded reflection, evidence-required revisions, capability filtering, verification, and JSONL trace export.
- **Poor direct fit:** `langfengQ/AgentOCR` compresses text histories into rendered images for RL agent training.
  It is not a document OCR or query-driven evidence system.
- **Reuse boundary:** Implement the smallest equivalent TypeScript slice cleanly inside `mirror_trans_pdf`.
  Do not copy code from AgenticOCR or OCR-Agent because the inspected commits contain no repository license file.
  AgentOCR is Apache-2.0 with a `Notice.txt`, but its relevant code belongs to a large veRL/GiGPO-derived training stack and is not needed for the proposed slice.

## Revisions and license evidence

| Repository | Exact inspected revision | License evidence | Reuse decision |
| --- | --- | --- | --- |
| [OpenDataLab/AgenticOCR](https://github.com/OpenDataLab/AgenticOCR) | `main` at [`15703444c9eadfd24ca268d57a04af7d179ec7e9`](https://github.com/OpenDataLab/AgenticOCR/tree/15703444c9eadfd24ca268d57a04af7d179ec7e9) | No `LICENSE`, `COPYING`, or `NOTICE` file exists in the inspected tree. | Read ideas only unless the authors provide a license. |
| [AIGeeksGroup/OCR-Agent](https://github.com/AIGeeksGroup/OCR-Agent) | `main` at [`28baee6f8533dbed557cbfe2973d383c493f2844`](https://github.com/AIGeeksGroup/OCR-Agent/tree/28baee6f8533dbed557cbfe2973d383c493f2844) | No license file exists. The README instead says to add the license required by the intended release and upstream datasets/models ([README](https://github.com/AIGeeksGroup/OCR-Agent/blob/28baee6f8533dbed557cbfe2973d383c493f2844/README.md#L169-L177)). | Read ideas only. Do not copy implementation code. |
| [langfengQ/AgentOCR](https://github.com/langfengQ/AgentOCR) | `master` at [`25736f7b6e19f35d2b8b439bbdffb6892e61bb20`](https://github.com/langfengQ/AgentOCR/tree/25736f7b6e19f35d2b8b439bbdffb6892e61bb20) | [`LICENSE`](https://github.com/langfengQ/AgentOCR/blob/25736f7b6e19f35d2b8b439bbdffb6892e61bb20/LICENSE) is Apache-2.0. [`Notice.txt`](https://github.com/langfengQ/AgentOCR/blob/25736f7b6e19f35d2b8b439bbdffb6892e61bb20/Notice.txt) attributes veRL and veRL-agent/GiGPO contributions. | Reuse would require preserving Apache notices and auditing derived and dependency licenses. Prefer a clean-room implementation because the training stack is out of scope. |

License status is based on the checked-in files at these exact commits.

Model, dataset, MinerU, veRL, ALFWorld, Search-R1, and other dependency licenses remain separate obligations.

## Comparison

### 1. Query-driven OCR

**AgenticOCR** is the only repository in this set with a direct query-to-region OCR loop.

Its system prompt requires the model to locate query-relevant evidence and call `image_zoom_and_ocr_tool` for text, numbers, tables, equations, images, or factual details ([`src/agents/AgenticOCR.py`](https://github.com/OpenDataLab/AgenticOCR/blob/15703444c9eadfd24ca268d57a04af7d179ec7e9/src/agents/AgenticOCR.py#L15-L89)).

The RAG layer retrieves page elements and builds page-grouped context containing full pages, crops, model OCR, and optional raw OCR ([`src/agents/RAGAgent.py`](https://github.com/OpenDataLab/AgenticOCR/blob/15703444c9eadfd24ca268d57a04af7d179ec7e9/src/agents/RAGAgent.py#L217-L376)).

**OCR-Agent** is question-driven answer correction, not query-driven crop selection.

It starts with a VLM answer, asks the same model to reflect on visible evidence, and optionally sends fixed high-resolution tiles during revision ([`ocr_agent/core/pipeline.py`](https://github.com/AIGeeksGroup/OCR-Agent/blob/28baee6f8533dbed557cbfe2973d383c493f2844/ocr_agent/core/pipeline.py#L22-L150)).

**AgentOCR** does not query documents.

Its `OCRTool` converts textual agent trajectory history into images, with segment caching for repeated history lines ([`agentocr/ocrtool.py`](https://github.com/langfengQ/AgentOCR/blob/25736f7b6e19f35d2b8b439bbdffb6892e61bb20/agentocr/ocrtool.py#L146-L190)).

### 2. Crop, zoom, rotation, and tool traces

**AgenticOCR:** `ImageZoomOCRTool.call` accepts a normalized `[x1, y1, x2, y2]` box, clamps it, crops, rotates, smart-resizes, saves the crop, and calls MinerU ([`src/agents/MinerUTool.py`](https://github.com/OpenDataLab/AgenticOCR/blob/15703444c9eadfd24ca268d57a04af7d179ec7e9/src/agents/MinerUTool.py#L41-L58), [`#L131-L254`](https://github.com/OpenDataLab/AgenticOCR/blob/15703444c9eadfd24ca268d57a04af7d179ec7e9/src/agents/MinerUTool.py#L131-L254)).

For region OCR, it maps MinerU result boxes back through resize, rotation, and crop offsets to normalized coordinates in the original page ([`src/agents/MinerUTool.py`](https://github.com/OpenDataLab/AgenticOCR/blob/15703444c9eadfd24ca268d57a04af7d179ec7e9/src/agents/MinerUTool.py#L60-L113), [`#L211-L254`](https://github.com/OpenDataLab/AgenticOCR/blob/15703444c9eadfd24ca268d57a04af7d179ec7e9/src/agents/MinerUTool.py#L211-L254)).

The agent loop retains assistant messages, tool responses, and generated crop paths in `predictions` and `images` ([`src/agents/AgenticOCR.py`](https://github.com/OpenDataLab/AgenticOCR/blob/15703444c9eadfd24ca268d57a04af7d179ec7e9/src/agents/AgenticOCR.py#L273-L344)).

**OCR-Agent:** `VisualToolExecutor` creates four overlapping quadrants, cached by source path, and adds them only to revision requests ([`ocr_agent/visual_tools.py`](https://github.com/AIGeeksGroup/OCR-Agent/blob/28baee6f8533dbed557cbfe2973d383c493f2844/ocr_agent/visual_tools.py#L11-L53), [`ocr_agent/core/pipeline.py`](https://github.com/AIGeeksGroup/OCR-Agent/blob/28baee6f8533dbed557cbfe2973d383c493f2844/ocr_agent/core/pipeline.py#L104-L128)).

It does not expose model-selected crop coordinates or a crop tool API.

**AgentOCR:** its cache is useful for repeated text-to-image rendering, not for page crop or OCR provenance ([`agentocr/ocrtool.py`](https://github.com/langfengQ/AgentOCR/blob/25736f7b6e19f35d2b8b439bbdffb6892e61bb20/agentocr/ocrtool.py#L37-L143)).

### 3. Provenance and evidence grounding

**AgenticOCR** has the strongest grounding shape.

`PageElement` carries `bbox`, `type`, OCR `content`, `corpus_id`, `corpus_path`, and `crop_path` ([`src/loaders/base_loader.py`](https://github.com/OpenDataLab/AgenticOCR/blob/15703444c9eadfd24ca268d57a04af7d179ec7e9/src/loaders/base_loader.py#L10-L34)).

The agent output asks for self-contained evidence plus a normalized source box ([`src/agents/AgenticOCR.py`](https://github.com/OpenDataLab/AgenticOCR/blob/15703444c9eadfd24ca268d57a04af7d179ec7e9/src/agents/AgenticOCR.py#L66-L89)).

This is useful provenance, but it is not a cryptographically immutable citation record.

The source identity is primarily a path or corpus identifier, and tool traces are transcript-like rather than a versioned typed event schema.

**OCR-Agent** stores textual evidence, image paths, action decisions, memory, and per-round trace fields such as `revision_evidence`, `verification_decision`, and generated tile paths ([`ocr_agent/data_models.py`](https://github.com/AIGeeksGroup/OCR-Agent/blob/28baee6f8533dbed557cbfe2973d383c493f2844/ocr_agent/data_models.py#L60-L125)).

It requires non-placeholder evidence before a revision and can require an independent verification pass ([`ocr_agent/core/pipeline.py`](https://github.com/AIGeeksGroup/OCR-Agent/blob/28baee6f8533dbed557cbfe2973d383c493f2844/ocr_agent/core/pipeline.py#L399-L461), [`#L520-L544`](https://github.com/AIGeeksGroup/OCR-Agent/blob/28baee6f8533dbed557cbfe2973d383c493f2844/ocr_agent/core/pipeline.py#L520-L544)).

It does not anchor evidence to page coordinates.

**AgentOCR** records no document evidence, page boxes, or OCR result provenance because its target is rendered agent history.

### 4. Model and provider assumptions

| Repository | Assumptions observed in source | Implication for mirror_trans_pdf |
| --- | --- | --- |
| AgenticOCR | Python 3.12, CUDA 12.8, GPU-backed OCR/extractor/reranker/generator, MinerU HTTP service, Qwen3-VL reranking, and OpenAI-compatible extractor/generator endpoints ([README](https://github.com/OpenDataLab/AgenticOCR/blob/15703444c9eadfd24ca268d57a04af7d179ec7e9#L46-L69), [config](https://github.com/OpenDataLab/AgenticOCR/blob/15703444c9eadfd24ca268d57a04af7d179ec7e9/configs/template.yaml#L25-L77)). | Strong design reference, but too GPU/service-heavy for the local TypeScript/Rust product path. |
| OCR-Agent | Mock, OpenAI-compatible Chat Completions or Responses, and Gemini backends; default examples use local RolmOCR through an OpenAI-compatible gateway ([`model_service.py`](https://github.com/AIGeeksGroup/OCR-Agent/blob/28baee6f8533dbed557cbfe2973d383c493f2844/ocr_agent/model_service.py#L16-L161), [README](https://github.com/AIGeeksGroup/OCR-Agent/blob/28baee6f8533dbed557cbfe2973d383c493f2844/README.md#L77-L107)). | The provider abstraction and mock backend are portable ideas. Do not import the Python implementation. |
| AgentOCR | veRL-based RL training, vLLM 0.11.0, flash-attn, Python 3.12, CUDA-oriented environments, and heavyweight ALFWorld/Search-R1 setup ([README](https://github.com/langfengQ/AgentOCR/blob/25736f7b6e19f35d2b8b439bbdffb6892e61bb20/README.md#L40-L89)). | Not an application OCR dependency. Reuse only the abstract idea of caching repeated rendered segments if a future history view needs it. |

## Proposed smallest integration slice

Implement one narrow, provider-neutral feature in `mirror_trans_pdf`, without adding a new agent framework.

1. **Evidence record:** Define a small internal record with `sourceId`, `pageIndex`, source-pixel `bbox`, `angle`, `text`, OCR engine identifier, and a stable `traceId`.
2. **One crop tool:** Given an existing PDF page or capture image plus a bbox, crop and optionally rotate using the existing local raster/OCR path, then map OCR boxes back to the original source coordinates.
3. **One chat action:** Let document chat request this crop tool only when the existing text layer or visible OCR evidence is insufficient, and return the resulting evidence record with the answer.
4. **One acceptance test:** Use a real small-text or rotated-table fixture and assert the answer, source page, bbox, and preserved failure behavior when OCR returns no evidence.

Do not initially add RL training, automatic multi-round planning, a new provider abstraction, MinerU, Qwen reranking, or four-quadrant tiling.

The smallest valuable slice is a deterministic crop-and-ground operation that composes with the existing `src/pdf` geometry and OCR pipeline.

## Open questions before implementation

- Whether chat should call the crop operation automatically or require an explicit user-visible “inspect region” action.
- Whether the source identity should use a document-content hash in addition to the current library/document identifier.
- Whether table and rotated-text OCR need a distinct engine or can meet the first fixture's acceptance threshold with the existing local engine.

**Recommendation:** adopt AgenticOCR's normalized geometry and evidence shape, adopt OCR-Agent's evidence-required revision and trace discipline, and implement both clean-room in the existing local-first pipeline.
