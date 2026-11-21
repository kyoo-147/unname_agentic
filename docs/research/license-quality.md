# OCR and document-intelligence licensing evidence

**Evidence snapshot:** 2026-11-21 UTC
**Scope:** source repositories, package/runtime metadata, model-weight references, hosted API boundaries, and commercial-distribution implications for the requested OCR/document systems.
**Evidence rule:** repository claims below are tied to the exact commit shown. A package license is not a license for its model weights, system binaries, datasets, hosted APIs, or transitive dependencies.

This is an engineering evidence report, not legal advice. Before shipping a product, freeze the exact source commit, model revision, dependency lockfile/container digest, and provider terms used by that product variant.

## Executive findings

1. **Do not redistribute AgenticOCR or OCR-Agent yet.** At the inspected commits neither repository contains a declared root `LICENSE` file, and OCR-Agent's `pyproject.toml` has no license field. A public GitHub repository is not automatically redistributable.
2. **The cleanest source-license candidates are Docling (MIT), PaddleOCR (Apache-2.0), AgentOCR (Apache-2.0), GROBID (Apache-2.0), and RAGFlow (Apache-2.0), subject to their separately licensed models, datasets, native tools, and dependencies.** Docling's default model repository is separately dual-labelled CDLA-Permissive-2.0/Apache-2.0; optional models can be more restrictive.
3. **PDFMathTranslate, PDFMathTranslate-next, and BabelDOC are AGPL-3.0.** A distributed derivative or combined covered program needs AGPL compliance; a modified network service can trigger AGPL section 13 source-offer obligations. Their translation-provider APIs remain separately governed by each provider's terms.
4. **MinerU is not Apache-only.** The inspected source carries a custom “MinerU Open Source License” based on Apache-2.0, with a USD 20M monthly-revenue or 100M MAU commercial-license threshold and an online-service attribution obligation. The package metadata correctly uses `LicenseRef-MinerU-Open-Source-License`.
5. **OCRmyPDF is MPL-2.0, but common operation uses external Tesseract and Ghostscript.** The OCRmyPDF project explicitly calls out Ghostscript's AGPL-3.0 terms for deployments that use it. Paperless-ngx adds GPL-3.0 obligations and the same OCR/system-tool stack.
6. **Model/API choice is a separate release gate.** AgenticOCR, OCR-Agent, PDFMathTranslate, BabelDOC, Paperless-ngx, and RAGFlow are designed to call configurable or hosted models. The source license does not grant rights to the selected model, API, data processing, rate limits, or commercial service.

## Exact source snapshots

The SHA is the inspected default-branch tip. Links use GitHub's immutable commit URL. GitHub's API license field is only a classifier; the repository license file and package metadata are the controlling evidence for this report.

| Project | Repository / exact SHA | Root license evidence | Package/runtime evidence |
|---|---|---|---|
| AgenticOCR | [opendatalab/AgenticOCR @ `15703444c9eadfd24ca268d57a04af7d179ec7e9`](https://github.com/opendatalab/AgenticOCR/tree/15703444c9eadfd24ca268d57a04af7d179ec7e9) | No root `LICENSE` file in the inspected tree; no SPDX license was declared by the repository metadata inspected. | [`requirements.txt`](https://github.com/opendatalab/AgenticOCR/blob/15703444c9eadfd24ca268d57a04af7d179ec7e9/requirements.txt), [`requirements_full.txt`](https://github.com/opendatalab/AgenticOCR/blob/15703444c9eadfd24ca268d57a04af7d179ec7e9/requirements_full.txt), [`configs/template.yaml`](https://github.com/opendatalab/AgenticOCR/blob/15703444c9eadfd24ca268d57a04af7d179ec7e9/configs/template.yaml) |
| OCR-Agent | [AIGeeksGroup/OCR-Agent @ `28baee6f8533dbed557cbfe2973d383c493f2844`](https://github.com/AIGeeksGroup/OCR-Agent/tree/28baee6f8533dbed557cbfe2973d383c493f2844) | No root `LICENSE` file in the inspected tree; [`pyproject.toml`](https://github.com/AIGeeksGroup/OCR-Agent/blob/28baee6f8533dbed557cbfe2973d383c493f2844/pyproject.toml) has no project license field. | [`pyproject.toml`](https://github.com/AIGeeksGroup/OCR-Agent/blob/28baee6f8533dbed557cbfe2973d383c493f2844/pyproject.toml), [`README.md`](https://github.com/AIGeeksGroup/OCR-Agent/blob/28baee6f8533dbed557cbfe2973d383c493f2844/README.md) |
| AgentOCR | [langfengQ/AgentOCR @ `25736f7b6e19f35d2b8b439bbdffb6892e61bb20`](https://github.com/langfengQ/AgentOCR/tree/25736f7b6e19f35d2b8b439bbdffb6892e61bb20) | [Apache-2.0 `LICENSE`](https://github.com/langfengQ/AgentOCR/blob/25736f7b6e19f35d2b8b439bbdffb6892e61bb20/LICENSE); [third-party `Notice.txt`](https://github.com/langfengQ/AgentOCR/blob/25736f7b6e19f35d2b8b439bbdffb6892e61bb20/Notice.txt). | [`requirements.txt`](https://github.com/langfengQ/AgentOCR/blob/25736f7b6e19f35d2b8b439bbdffb6892e61bb20/requirements.txt), [`pyproject.toml`](https://github.com/langfengQ/AgentOCR/blob/25736f7b6e19f35d2b8b439bbdffb6892e61bb20/pyproject.toml), [`README.md`](https://github.com/langfengQ/AgentOCR/blob/25736f7b6e19f35d2b8b439bbdffb6892e61bb20/README.md) |
| PDFMathTranslate | [Byaidu/PDFMathTranslate @ `200ffbada1cc12a48c36e9d8c9bdf2a28ab4aacc`](https://github.com/Byaidu/PDFMathTranslate/tree/200ffbada1cc12a48c36e9d8c9bdf2a28ab4aacc) | [AGPL-3.0 `LICENSE`](https://github.com/Byaidu/PDFMathTranslate/blob/200ffbada1cc12a48c36e9d8c9bdf2a28ab4aacc/LICENSE). | [`pyproject.toml`](https://github.com/Byaidu/PDFMathTranslate/blob/200ffbada1cc12a48c36e9d8c9bdf2a28ab4aacc/pyproject.toml) |
| BabelDOC | [funstory-ai/BabelDOC @ `dd9adc352b957533d05b8cb94e88a7589cc56a35`](https://github.com/funstory-ai/BabelDOC/tree/dd9adc352b957533d05b8cb94e88a7589cc56a35) | [AGPL-3.0 `LICENSE`](https://github.com/funstory-ai/BabelDOC/blob/dd9adc352b957533d05b8cb94e88a7589cc56a35/LICENSE). | [`pyproject.toml`](https://github.com/funstory-ai/BabelDOC/blob/dd9adc352b957533d05b8cb94e88a7589cc56a35/pyproject.toml), [`rust/Cargo.toml`](https://github.com/funstory-ai/BabelDOC/blob/dd9adc352b957533d05b8cb94e88a7589cc56a35/rust/Cargo.toml), vendored [`lopdf/LICENSE`](https://github.com/funstory-ai/BabelDOC/blob/dd9adc352b957533d05b8cb94e88a7589cc56a35/rust/vendor/lopdf/LICENSE) |
| PDFMathTranslate-next | [PDFMathTranslate/PDFMathTranslate-next @ `07022b4d8585330c6b8413dd2cea9d203d1efb36`](https://github.com/PDFMathTranslate/PDFMathTranslate-next/tree/07022b4d8585330c6b8413dd2cea9d203d1efb36) | [AGPL-3.0 `LICENSE`](https://github.com/PDFMathTranslate/PDFMathTranslate-next/blob/07022b4d8585330c6b8413dd2cea9d203d1efb36/LICENSE). | [`pyproject.toml`](https://github.com/PDFMathTranslate/PDFMathTranslate-next/blob/07022b4d8585330c6b8413dd2cea9d203d1efb36/pyproject.toml) |
| Docling | [docling-project/docling @ `5182e556308958f3ac4762bb7d03a092c2f339c9`](https://github.com/docling-project/docling/tree/5182e556308958f3ac4762bb7d03a092c2f339c9) | [MIT `LICENSE`](https://github.com/docling-project/docling/blob/5182e556308958f3ac4762bb7d03a092c2f339c9/LICENSE). | [`packages/docling-slim/pyproject.toml`](https://github.com/docling-project/docling/blob/5182e556308958f3ac4762bb7d03a092c2f339c9/packages/docling-slim/pyproject.toml), [`packages/docling/pyproject.toml`](https://github.com/docling-project/docling/blob/5182e556308958f3ac4762bb7d03a092c2f339c9/packages/docling/pyproject.toml) |
| MinerU | [opendatalab/MinerU @ `097de7f63f54722c9b805ee1c9a14a0c5b02e078`](https://github.com/opendatalab/MinerU/tree/097de7f63f54722c9b805ee1c9a14a0c5b02e078) | [`LICENSE.md`](https://github.com/opendatalab/MinerU/blob/097de7f63f54722c9b805ee1c9a14a0c5b02e078/LICENSE.md): Apache-2.0 base plus custom additional terms. | [`pyproject.toml`](https://github.com/opendatalab/MinerU/blob/097de7f63f54722c9b805ee1c9a14a0c5b02e078/pyproject.toml), [model-source documentation](https://github.com/opendatalab/MinerU/blob/097de7f63f54722c9b805ee1c9a14a0c5b02e078/docs/en/usage/model_source.md) |
| PaddleOCR | [PaddlePaddle/PaddleOCR @ `dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf`](https://github.com/PaddlePaddle/PaddleOCR/tree/dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf) | [Apache-2.0 `LICENSE`](https://github.com/PaddlePaddle/PaddleOCR/blob/dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf/LICENSE). | [`pyproject.toml`](https://github.com/PaddlePaddle/PaddleOCR/blob/dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf/pyproject.toml), [`deploy/cpp_infer/THIRD_PARTY_LICENSES`](https://github.com/PaddlePaddle/PaddleOCR/tree/dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf/deploy/cpp_infer/THIRD_PARTY_LICENSES) |
| OCRmyPDF | [ocrmypdf/OCRmyPDF @ `86a5e723ea2b612e8df4a647056b0ebf3b3c97a5`](https://github.com/ocrmypdf/OCRmyPDF/tree/86a5e723ea2b612e8df4a647056b0ebf3b3c97a5) | [MPL-2.0 `LICENSE`](https://github.com/ocrmypdf/OCRmyPDF/blob/86a5e723ea2b612e8df4a647056b0ebf3b3c97a5/LICENSE); non-core code and docs/tests have additional SPDX/CC terms. | [`pyproject.toml`](https://github.com/ocrmypdf/OCRmyPDF/blob/86a5e723ea2b612e8df4a647056b0ebf3b3c97a5/pyproject.toml), [installation requirements](https://ocrmypdf.readthedocs.io/en/latest/installation.html) |
| Paperless-ngx | [paperless-ngx/paperless-ngx `dev` @ `4973be8499bc61dc4f791a609d0d31e9ac9ccd41`](https://github.com/paperless-ngx/paperless-ngx/tree/4973be8499bc61dc4f791a609d0d31e9ac9ccd41) | [GPL-3.0 `LICENSE`](https://github.com/paperless-ngx/paperless-ngx/blob/4973be8499bc61dc4f791a609d0d31e9ac9ccd41/LICENSE). The current GitHub default branch at capture time was `dev`. | [`pyproject.toml`](https://github.com/paperless-ngx/paperless-ngx/blob/4973be8499bc61dc4f791a609d0d31e9ac9ccd41/pyproject.toml), [setup/system dependencies](https://docs.paperless-ngx.com/setup/), [AI provider configuration](https://docs.paperless-ngx.com/configuration/) |
| GROBID | [grobidOrg/grobid @ `c11e7c4a8767092dc51f516a46dcf678218904d3`](https://github.com/grobidOrg/grobid/tree/c11e7c4a8767092dc51f516a46dcf678218904d3) | [Apache-2.0 license statement](https://github.com/grobidOrg/grobid/blob/c11e7c4a8767092dc51f516a46dcf678218904d3/doc/License.md). Documentation is CC0 and annotated data is CC-BY. | [`build.gradle`](https://github.com/grobidOrg/grobid/blob/c11e7c4a8767092dc51f516a46dcf678218904d3/build.gradle), [requirements](https://github.com/grobidOrg/grobid/blob/c11e7c4a8767092dc51f516a46dcf678218904d3/Readme.md) |
| RAGFlow | [infiniflow/ragflow @ `91c702e86be3dcb3cabc9f6d81e485d02241bef8`](https://github.com/infiniflow/ragflow/tree/91c702e86be3dcb3cabc9f6d81e485d02241bef8) | [Apache-2.0 `LICENSE`](https://github.com/infiniflow/ragflow/blob/91c702e86be3dcb3cabc9f6d81e485d02241bef8/LICENSE). | [`pyproject.toml`](https://github.com/infiniflow/ragflow/blob/91c702e86be3dcb3cabc9f6d81e485d02241bef8/pyproject.toml), [provider configuration](https://ragflow.io/docs/dev/llm_api_key_setup) |

## Per-project evidence and implications

### 1. AgenticOCR

**Source license status:** unresolved. The exact repository tree has no root license file. Do not treat the Apache/MIT licenses of its dependencies or the paper as a source-code license.

**Declared runtime:** Python 3.12 and CUDA 12.8 are the reference environment. The pinned full requirements include PyTorch 2.9.1, torchvision 0.24.1, torchaudio 2.9.1, Transformers 4.57.1, vLLM 0.14.0, FAISS CPU, DeepSpeed, bitsandbytes, FlashInfer, CuPy CUDA 12, NVIDIA CUDA runtime libraries, FastAPI/Uvicorn, Gradio, Streamlit, OpenAI, Anthropic, Hugging Face Hub, ModelScope, and many other packages. The smaller requirements file still includes the GPU/model-serving stack and `mineru_vl_utils==0.1.20` is called out by the README.

**Models and APIs:** `configs/template.yaml` names `qwen3-vl-32b-thinking`, a local embedding/reranker path, MinerU server/model fields, and OpenAI-compatible generator, extractor, judge, and evaluator endpoints. The repository therefore does not identify one complete, license-closed model bundle. Qwen3-VL embedding/reranker model cards currently identify Apache-2.0 for those particular checkpoints, but the generator, MinerU checkpoint, reranker revision, and any evaluator are configurable and must be pinned separately.

**Commercial implication:** source redistribution is blocked until the authors add or confirm a license. A private internal experiment can still have separate obligations for the selected model weights, datasets, API providers, and transitive packages. Do not ship a combined AgenticOCR product under an assumed Apache license.

### 2. OCR-Agent

**Source license status:** unresolved. The exact tree has no root `LICENSE`; `pyproject.toml` declares package name/version, Python `>=3.10`, and dependencies but no license field.

**Declared runtime:** the package metadata declares only `Pillow>=9.0`, `pandas>=1.5`, and `pyarrow>=10.0`. The README configures an OpenAI-compatible chat-completions endpoint and recommends a vision-capable model. It is a router/agent boundary, not a bundled OCR model distribution.

**Models and APIs:** model identity, provider, endpoint, API key, retention, and commercial use are all deployment choices. `OPENAI_API_KEY` is accepted, but the code also supports local or compatible endpoints. No model-weight license can be inferred from the package metadata.

**Commercial implication:** no redistribution or commercial embedding should proceed without an explicit source license from the authors. If the source license is later clarified, keep the selected model/API contract as an independent approval item.

### 3. AgentOCR

**Source license:** Apache-2.0 at the exact SHA, with a `Notice.txt` that must be preserved and reviewed because the repository vendors or incorporates substantial veRL/verl-agent and environment code.

**Declared runtime:** Python 3.12; vLLM 0.11.0; Flash-Attention 2.7.4.post1; editable installation. The ALFWorld path adds Gymnasium, Stable-Baselines3, and ALFWorld plus downloaded PDDL/game data and a Mask R-CNN detector. The Search path uses a separate Python 3.10 retrieval environment with PyTorch 2.6.0/CUDA 12.4, Transformers, datasets, Pyserini, Hugging Face Hub, FAISS-GPU 1.8.0, Uvicorn, and FastAPI. The README reports roughly 6 GB GPU memory per GPU for the local retrieval server.

**Models and data:** the exact training scripts use `Qwen/Qwen2.5-VL-3B-Instruct` for ALFWorld and `Qwen/Qwen2.5-VL-7B-Instruct` for Search. Those Qwen model cards are Apache-2.0, but the model revision, ALFWorld/Search-R1 datasets, downloaded indexes, detector artifacts, and any environment assets are separate items. The repository also contains third-party environment code and notices.

**Commercial implication:** the root source is commercially usable under Apache-2.0 with attribution/notice and patent terms, but a redistributed training bundle must carry all applicable third-party notices and model/data terms. Treat the full environment as a multi-license distribution, not as one Apache-only artifact.

### 4. PDFMathTranslate

**Source license:** AGPL-3.0.

**Declared runtime:** Python `>=3.11,<3.13`; Requests, Googletrans, PyMuPDF, NumPy, Ollama, Xinference client, DeepL SDK, OpenAI SDK, Azure translation SDK, Gradio, Hugging Face Hub, ONNX/ONNX Runtime, OpenCV, Tencent translation SDK, pdfminer.six, gradio-pdf, pikepdf, Peewee, `babeldoc`, and Rich. Optional extras add OCR downloads, Flask/Celery/Redis backend support, Argos Translate, CUDA/DirectML ONNX Runtime, and a separate “precise” environment.

**Models and APIs:** the package does not fix one translation model. It can call Google, DeepL, OpenAI, Azure, Tencent, Ollama, Xinference, and BabelDOC. OCR/layout model artifacts and PyMuPDF's model/download paths are separately governed. The README acknowledges BabelDOC, PyMuPDF, pdfminer.six, DocLayout-YOLO, fonts, and other upstreams.

**Commercial implication:** distributing modified source, binaries, containers, or a linked/combined product requires an AGPL compliance design. A network service that modifies and exposes the program should be reviewed under AGPL section 13. The use of a paid translation API is not covered by AGPL and requires the provider's commercial/API/privacy terms. PyMuPDF itself is an additional material licensing checkpoint, commonly AGPL or commercial depending on the distribution/license selected.

### 5. BabelDOC

**Source license:** AGPL-3.0.

**Declared runtime:** Python `>=3.10,<3.14`; `configargparse`, HTTPX with SOCKS support, Hugging Face Hub, NumPy, ONNX/ONNX Runtime, OpenAI, orjson, cryptography, Peewee, psutil, PyMuPDF, Rich, TOML, tqdm, xsdata with lxml/CLI/SOAP, msgpack, Pydantic, Tenacity, scikit-image, freetype-py, tiktoken, Levenshtein, OpenCV, pyzstd, Hyperscan, Rtree, charset detection, SciPy, uharfbuzz, and scikit-learn. Optional extras add DirectML, CUDA ONNX Runtime, or memray. The build also uses Rust through Maturin/PyO3 and a workspace with vendored `lopdf`.

**Models and APIs:** BabelDOC is primarily a document translation library/API. It calls configurable translation providers and does not grant rights to their models or hosted endpoints. The source distribution contains separate Rust/font assets and license files that must remain in any compliant redistribution.

**Commercial implication:** AGPL obligations apply to the source/program distribution. Provider costs, data processing, and model use remain governed by the selected provider. Audit the generated wheel/container, the vendored Rust code, PyMuPDF, fonts, and any downloaded model or font assets before commercial release.

### 6. PDFMathTranslate-next

**Source license:** AGPL-3.0. It is the newer reference UI/CLI layer around BabelDOC.

**Declared runtime:** Python `>=3.10,<3.14`; Requests, NumPy, Ollama, Xinference, DeepL, OpenAI, Azure translation, Gradio, Tencent translation, gradio-pdf, Peewee, fontTools, BabelDOC `>=0.7.1,<0.8.0`, Pydantic settings, HTTPX, FastAPI/Uvicorn, SSE Starlette, chardet, `gradio-i18n`, PyYAML, and Rich. Development metadata adds MkDocs and build/test tooling.

**Models and APIs:** the repository exposes multiple translation backends and calls BabelDOC. No single model revision is part of the source license. API keys and provider contracts are external. The online service referenced by the README is a hosted service, not evidence that the AGPL source grants access to that service.

**Commercial implication:** AGPL compliance is required for redistribution or a modified exposed service. Audit BabelDOC and all selected translation/OCR/layout models independently. Do not assume the hosted Immersive Translate quota, SiliconFlow service, or any other provider is sublicensed by this repository.

### 7. Docling

**Source license:** MIT for the Docling code at the exact SHA.

**Declared runtime:** the default `docling-slim` package is intentionally small: Pydantic, docling-core, pydantic-settings, filetype, Requests, certifi, pluggy, tqdm, and langcodes. Extras add PDF backends (`pypdfium2`, `docling-parse`), Office/web parsers, NumPy/Pillow/SciPy/Rtree, OCR engines such as RapidOCR/EasyOCR/Tesseract/macOS OCR, local Torch/TorchVision/Accelerate/Hugging Face models, ONNX Runtime, Transformers, OpenCLIP/timm/PEFT, audio/ASR, Playwright, and remote KServe/OpenAI-compatible clients.

**Models and APIs:** the official FAQ says PDF processing needs model weights from `docling-project/docling-models`. The Hugging Face model card currently labels that repository `CDLA-Permissive-2.0` and `Apache-2.0`. The Docling model catalog also lists third-party models with their own terms. For example, the catalog warns that the optional Surya OCR weights use a modified OpenRAIL-M license with a USD 5M funding/revenue boundary. Remote services and external plugins are disabled by default in current pipeline options, but can be enabled.

**Commercial implication:** MIT source integration is permissive, but the default model artifact and every optional OCR/VLM/ASR model require their own notice and commercial-use review. A “Docling is MIT” statement is insufficient for a model-bundled product. Pin the exact model repository revision and preserve its license files.

### 8. MinerU

**Source license:** custom MinerU Open Source License. The text says it is based on Apache-2.0 but adds enforceable terms:

- no separate commercial license is required until the user and affiliates exceed either **100 million monthly active users** or **USD 20 million total monthly revenue**;
- an online service provided to third parties must clearly and prominently identify that it uses MinerU in the product interface or public documentation;
- failure to obtain a required commercial license or satisfy attribution terminates the license automatically.

The package metadata uses `LicenseRef-MinerU-Open-Source-License`, and GitHub's SPDX classifier was `NOASSERTION`; it must not be represented as plain Apache-2.0.

**Declared runtime:** Python `>=3.11,<3.15`; DocVortex, Gradio, MinerU-VL utilities, MinerU llama.cpp bindings, Click, Loguru, NumPy, Requests/HTTPX, Pillow, pypdfium2, PyYAML, ModelScope, Hugging Face Hub, JSON repair, OpenAI, FastAPI/Uvicorn, Pydantic, ONNX/ONNX Runtime, tokenizers, Shapely, Pyclipper, and related parsing packages. The `torch` extra adds Torch, TorchVision, Transformers, Accelerate, and Safetensors; `full` adds vLLM on Linux or LMDeploy on Windows.

**Models and APIs:** model downloads are selected through ModelScope/Hugging Face and the package exposes local and remote/server paths. The selected weights are not licensed by the source package declaration. As a concrete example, the official Hugging Face `opendatalab/MinerU2.5-2509-1.2B` model card is labelled AGPL-3.0. Other MinerU checkpoints may have different or additional notices, so pin the exact checkpoint. The test metadata also identifies a remote `mineru.net` parse-server path; a hosted API account/terms are separate from the source license.

**Commercial implication:** retain the MinerU attribution in an online product, monitor the threshold on a consolidated-affiliate basis, and obtain the separate commercial license before crossing it. Audit source, model, PyMuPDF/pypdfium2, remote API, and bundled/third-party assets separately.

### 9. PaddleOCR

**Source license:** Apache-2.0.

**Declared runtime:** Python `>=3.8`; the base package depends on `paddlex[ocr-core]>=3.7.0,<3.8.0`, PyYAML, Requests, aiohttp, and typing extensions. Optional extras add document parsing/GenAI clients, information extraction, translation, and Office-document conversion. The actual PaddlePaddle/PaddleX accelerator stack is selected by PaddleX/platform installation rather than fully enumerated in this package file. The repository also contains native deployment and third-party license directories.

**Models and APIs:** PaddleOCR downloads model artifacts through its model ecosystem. The official `PaddlePaddle/PaddleOCR-VL-1.5` Hugging Face model card currently labels that checkpoint Apache-2.0, but other models, datasets, language packs, native libraries, or copied benchmark assets may carry different terms. The official website exposes an experience center/API; those hosted services are not licensed by the GitHub source license.

**Commercial implication:** Apache-2.0 source use is generally compatible with commercial distribution with notices and patent terms, but bundle only model/artifact revisions whose own cards and notices have been approved. Keep PaddlePaddle, PaddleX, native backend, and model licenses in the product SBOM.

### 10. OCRmyPDF

**Source license:** MPL-2.0. MPL permits integration with proprietary or closed-source code, while requiring source availability for covered files/modifications under MPL terms. The project separately marks non-core code and documentation/tests with other SPDX/Creative Commons terms.

**Declared runtime:** Python `>=3.11`; fpdf2, img2pdf, packaging, pdfminer.six, pikepdf with PDF/A support, Pillow, pluggy, Pydantic, pypdfium2, Rich, typing extensions, and uharfbuzz. Optional extras add HEIC support, file watching, Streamlit webservice, or RapidOCR plus ONNX Runtime.

**External runtime:** official installation documentation requires Tesseract and either pypdfium2 or Ghostscript, with optional fonts, unpaper, pngquant, and jbig2enc. Ghostscript is AGPL-3.0. Tesseract language data and optional encoders have their own licenses. OCRmyPDF's own docs warn that the demonstration web service is not production-hardened for hostile PDFs.

**Commercial implication:** the MPL core can be integrated commercially, but a product distributing OCRmyPDF modifications needs MPL notices/source handling. If the product uses Ghostscript, perform a separate AGPL review; choosing the pypdfium2/internal path can change that dependency profile but does not remove the need to audit all installed system packages.

### 11. Paperless-ngx

**Source license:** GPL-3.0 at the inspected `dev` branch tip. GPL-3.0 is a strong reciprocal license for distributed covered works, but unlike AGPL it does not itself add a general network-service source-offer clause.

**Declared runtime:** Python `>=3.11`; Django, Django REST Framework, Channels, Celery/Redis, database drivers, OCRmyPDF with the HEIC extra, PDF/image tools, Tantivy/Whoosh, sentence-transformers, Torch, LlamaIndex, OpenAI-compatible clients, Ollama clients, Azure AI Document Intelligence, barcode tooling, and many web/authentication packages. Optional MariaDB/PostgreSQL/webserver extras add native database or server dependencies.

**External runtime:** official setup requires Linux for bare-metal installation, Python, Redis/Valkey, database or SQLite, Poppler, GnuPG, libmagic, and the OCRmyPDF system stack: Tesseract, Ghostscript, qpdf, unpaper, image/color libraries, and optional pngquant/jbig2enc. Optional Tika/Gotenberg services parse Office/email formats.

**Models and APIs:** Paperless uses OCRmyPDF locally and can call Azure AI Document Intelligence, Ollama, hosted OpenAI-compatible APIs, or local embedding/LLM models through LlamaIndex. The official configuration docs explicitly state that hosted API usage charges and document transfer to the configured provider are the operator's responsibility.

**Commercial implication:** a distributed Paperless derivative or combined covered application needs GPL compliance and notices/source access as applicable. The remote API path adds provider privacy, retention, data residency, and cost terms. A SaaS operator should not assume the GPL source license grants any hosted provider rights or clears the OCRmyPDF/Ghostscript stack.

### 12. GROBID

**Source license:** Apache-2.0 for GROBID code. The project states that documentation is CC0 and annotated data is CC-BY.

**Declared runtime:** OpenJDK 21; Linux 64-bit or macOS Intel/ARM for native builds; optional Python 3.10-3.11 with JEP for DeLFT deep-learning models; optional NVIDIA CUDA. The Gradle build uses Kotlin/Java, Shadow, JEP, local native libraries, Apache Commons/Jackson/Guava/HTTP components, Lingua, Logback/SLF4J, PDFBox, and other JVM dependencies. The repository's `grobid-home` contains runtime models, lexicons, native libraries, and the external `pdfalto` executable.

**Important transitive boundary:** GROBID's FAQ says `pdfalto` is a separate external command-line program and is distributed under GPL-2.0. `pdfalto` itself documents GPL-2.0 and bundles/links Xpdf-related libraries. GROBID's Apache license does not convert pdfalto, annotated data, documentation, or all bundled dependencies to Apache.

**Models and APIs:** GROBID ships/loads trained sequence-labelling and layout models and can expose a REST service, Docker image, Java API, or batch mode. The project-level license statement covers GROBID; model provenance, training data, annotated corpora, pdfalto, and local native libraries must be retained as separate notices.

**Commercial implication:** commercial use of the Apache GROBID code is generally possible with notices, but distribute the GROBID Docker/runtime bundle as a multi-license artifact. Preserve GPL-2.0 pdfalto source/notice obligations and CC-BY attribution for annotated data. Native Windows is not a supported runtime in the current README; use a Linux container/WSL boundary and document it.

### 13. RAGFlow

**Source license:** Apache-2.0.

**Declared runtime:** the exact `pyproject.toml` requires Python `>=3.13,<3.14` and includes Elasticsearch DSL, MySQL Connector/Python, Peewee, ReportLab, aiohttp, scholarly, Beartype, Werkzeug, regex, and JSON repair. The repository also uses a large Docker/Go/Node/service stack whose complete license inventory is not represented by this small Python metadata file.

**Models and APIs:** RAGFlow supports hosted providers, OpenAI-compatible endpoints, Bedrock, Ollama, vLLM, PaddleOCR providers, and other integrations. Its documentation says local Ollama/vLLM can be used and gives MiniCPM5-2B (Apache-2.0) as one local example, but this is not a restriction or default for every deployment. The selected chat, embedding, reranker, parser, and OCR models need their own model-card and acceptable-use review. Hosted `cloud.ragflow.io` subscription/API terms are separate from the Apache source.

**Commercial implication:** Apache source use can support commercial distribution with notices, but a RAGFlow deployment is a multi-service product. Audit Elasticsearch/OpenSearch/MySQL/Redis/object storage, Go/Node dependencies, OCR/parser images, selected models, hosted providers, and any bundled fonts/data. Keep API keys and customer documents outside images and logs.

## Hosted API and model boundary

The repositories expose or document integrations with OpenAI-compatible endpoints, OpenAI, Anthropic, Azure AI/Translator, Google, DeepL, Tencent, Ollama, Xinference, SiliconFlow, ModelScope, Hugging Face, MinerU cloud, PaddleOCR cloud, RAGFlow cloud, and GROBID demo services. Those are **not** covered by the repository license.

For each production configuration, record:

- provider name, endpoint, model ID, model revision/digest, and region;
- provider terms, acceptable-use policy, commercial rights, retention/training policy, DPA, and data residency;
- whether the model is downloaded locally, served by a private endpoint, or sent to a hosted API;
- input/document ownership and permission to process third-party documents;
- rate limits, paid quota, and failure behavior; and
- whether the provider's SDK, model card, or API contract imposes attribution, trademark, or output restrictions.

A local endpoint such as Ollama, vLLM, or an OpenAI-compatible server removes one hosted transfer boundary but does not remove the selected model's license or the operator's responsibility for the model weights.

## Dependency and distribution release gate

A source license check alone is insufficient. Before packaging any of these systems into a product:

1. Freeze the repository SHA, package lockfile, Docker base/image digest, model repository revision, and downloaded artifact hashes.
2. Generate an SBOM for Python, Rust, JVM, native system packages, model files, fonts, datasets, and container layers.
3. Inspect direct and transitive licenses. Pay special attention to AGPL/GPL components, PyMuPDF, Ghostscript, pdfalto, model cards, fonts, benchmark data, and native accelerator runtimes.
4. Preserve every `LICENSE`, `NOTICE`, SPDX/DEP5 record, model card, and attribution required by the selected artifacts.
5. Decide whether the product distributes the covered software or only calls an independent local/remote service. Do not use this distinction to evade obligations for an actual combined or modified distribution.
6. Run a legal review for AGPL/GPL/network-service questions, MinerU's custom threshold/attribution terms, model acceptable-use terms, and hosted API privacy/retention.

### Bottom line

- **Blocked pending license clarification:** AgenticOCR, OCR-Agent.
- **Permissive source, but model/dependency review required:** AgentOCR, Docling, PaddleOCR, GROBID, RAGFlow.
- **Copyleft/source-distribution review required:** PDFMathTranslate, BabelDOC, PDFMathTranslate-next, Paperless-ngx, OCRmyPDF's MPL-covered files and its Ghostscript-based runtime.
- **Custom commercial/attribution gate:** MinerU.
