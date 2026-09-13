# Presentation workspaces and composable skills

The authenticated HTTP boundary checks the current server session and user on every request. Production presentation work uses a stable account workspace (`presentation-account:<userId>`) for documents, templates, derived assets and execution coordination. This workspace identifier is not a login credential. Client session headers remain untrusted.

On first access, the server migrates legacy directories only for session IDs read from that user's database records plus the current authenticated session. Migration copies resources, retains the old directories, and never overwrites a newer job snapshot. Legacy directories with no verifiable ownership record are not guessed. The work list is stored server-side and the studio's **My presentations** control restores it after a new login.

## Native template fidelity

A learned layout remains available for redesign. The native path works directly on the uploaded PPTX package:

- `presentation.template.inspectNative` discovers native shape IDs and rich-text runs, including shapes nested in groups.
- `presentation.template.extractAssets` makes the template's raster media available to other tools as owned immutable assets.
- `presentation.template.fillNative` replaces selected text runs or picture relationships. Unchanged OOXML parts, charts, embedded workbooks, notes and masters remain byte-identical. Picture replacement gets a private media part and relationship so shared images are not overwritten.
- `presentation.template.restoreNative` returns the exact original PPTX bytes.
- `presentation.template.listNativeOutputs` recovers saved native outputs after a fresh login or process restart. Opening the native editor restores its latest download; agents can choose from the returned history.

The template picker has an **Edit original PPTX** action. It invokes the skill agent and returns the resulting native PPTX download. This path preserves native objects; the redesign preview path still represents learned layouts in SVG. Native chart/table restructuring is not implemented as text replacement: unsupported object edits fail rather than silently flattening the object. For rich text, provide a `runs` array with the original run count; `text` replaces the first run and clears later runs.

## Asset plugin

The `assets` Cordis plugin is independent of presentation planning. Its operations consume owned refs and return new refs:

- `list`, `inspect`: discover reusable account assets, dimensions and source lineage.
- `generate`: real image generation with an idempotency key.
- `removeBackground`: local U2Net subject segmentation into an RGBA PNG.
- `keyColor`: edge-connected solid background removal with tolerance and feathering.
- `applyMask`: multiply existing alpha by an owned grayscale mask.
- `transform`: crop, resize, rotate and adjust opacity while retaining alpha.
- `compose`: place up to 12 layers on a transparent or solid canvas.

The PPT asset planner can choose a processing workflow instead of regenerating a picture. Newly generated images can also have postprocessing steps; `$source` resolves to the real generated ref. Output refs are persisted before layout planning, allowing retries to reuse completed work. Existing source files are retained.

Local segmentation requires `rembg`, `onnxruntime` and an installed `u2net.onnx` or `u2net_human_seg.onnx`. `CORDIS_ASSET_PYTHON` selects the trusted Python executable; `U2NET_HOME` selects the model directory. Tools do not silently download a missing model. Processing has pixel, output size and execution time limits. Complex hair, translucent materials or low-contrast boundaries can require a better mask; use `applyMask` to refine the result.

## Agent composition

`skills.catalog` publishes available atomic schemas and example recipes. `skills.run` executes a caller-defined sequence of up to 16 steps. Inputs can reference previous output fields with `{ "$ref": "cutout.ref" }`. References cannot access prototypes or future steps. A whole sequence holds leases on its participating Cordis plugins, preventing hot replacement from mixing plugin versions mid-workflow.

`skills.autorun` is a bounded model/tool loop. The model chooses a tool, Cordis validates and executes it, and the result becomes context for the next choice. The loop permits at most 10 decisions, 2 image generations and 2 failed tool executions. A request ID deduplicates concurrent and completed calls within the runtime. Each nested call retains scope checks, audit events and cancellation. Successfully created assets are immutable and survive a later step failing; the workflow does not pretend that those effects rolled back.

These services target the existing single Node host with a persistent `CORDIS_PRESENTATION_DATA_DIR`. Multi-host execution requires shared persistence and a distributed lease/queue implementation before replicas can safely run the same account's jobs concurrently.

## PPT intake context and jumi model policy

The logged-in PPT composer exposes only supported context controls. `context.readFile`, `context.readSkill`, `context.listSkills`, and `context.search` are Cordis atomic capabilities. The server injects authenticated account services; client input contains owned IDs, never trusted skill bodies or file content. The agent chooses when to read attachments and owned skill instructions. Skills explicitly selected by the user must be read before drafting an outline. Enabling search permits the agent to request up to two real searches; disabling it prevents execution even if the model asks. Selecting a skill does not grant access to arbitrary external MCP servers.

PPT attachments upload to the authenticated conversation endpoint as multipart data and persist in the same account artifact storage as presentations. Text and Office/PDF files are parsed into actual content; supported images become bounded image inputs. The composer waits for uploads before sending and reports errors. Evidence and source URLs are carried in `brief.research` into outline planning and final generation. Source plans and budgets must remain plans and budgets, and missing outcome data must remain explicitly pending.

Home and PPT chat selectors expose Gemini 3.8 Flash (`gemini-3.8-flash-high`) only. Existing real agents migrate to the pinned Nexus chat configuration. The Nexus runtime routes chat through the configured presentation chat backend while preserving the original image runtime and image credentials.

Validation: authenticated browser upload of a test document with a 37 万元 budget, 12 stores and 8 weeks produced the matching intake response and three-slide outline. A combined skills/search/attachment request returned ECharts official URLs. An actual homepage conversation returned the requested `jumi 已就绪`. Regression coverage includes account isolation for attachment reads, selected skill content, disabled search, malformed structured-response recovery, and retaining the image runtime when pinning chat.

## Autonomous creation entry point

The conversation capability now discovers Cordis operations on every model decision. A trusted atomic plugin exposes a tool to this stage with `agent: { contexts: ['presentation.intake'], maxCalls?: number }`. Unmarked tools stay unavailable. No per-tool dispatch branch is required for new plugins. Invocation still runs through Cordis schema validation, authenticated scope, plugin lifecycle, cancellation and audit events. User-disabled web search remains unavailable; each tool and the whole turn have bounded call budgets.

`planning.update` saves the task-specific goal, narrative, rationale, proposed steps and success criteria. This is a revisable creative proposal, not a claim that the steps ran. `planning.outline` drafts or revises actual outlines using that proposal, original user instructions and tool evidence. The model chooses when to use these operations, whether to ask a question, and when to return to the user. A request to discuss the framework can finish without drafting slides. Source/asset tools can precede or follow planning; new evidence invalidates an already drafted outline so stale output cannot be returned silently.

The frontend displays the returned conversation and an optional collapsed creative proposal. It displays outlines returned by a successful agent-selected tool call and no longer launches an extra outline request after a phase flag. The proposal and supporting evidence are carried into the confirmed generation input. Rendering and export remain deterministic capabilities with existing validation.

Live verification used two distinct prompts: a designer-day narrative discussion returned only `context.readSkill` and `planning.update`; a three-page sample pilot request additionally selected `planning.outline` and returned real editable slides. Tests cover custom plugin discovery without dispatch changes, user-disabled search, unavailable tools, error-driven replanning, JSON repair and the absence of a frontend-triggered outline call.
