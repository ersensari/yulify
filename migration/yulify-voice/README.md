# Yulify voice: migration scaffold

This folder is a design scaffold. It has no extension manifest, entry point, registered provider, API route, service client or migration runner. The v0.2 extension loader therefore cannot activate it. Existing Yulify code continues to own voice until the actual extraction and validation described below. Do not copy this as an enabled extension.

## Ownership and boundaries

The legacy LiveKit/MicroTurn bridge (`core/server/src/api/minicpm-duplex.ts` in the merge worktree) owns the existing `/api/sessions/:id/voice/qwen3/...` paths, room lifecycle, session-specific random bridge tokens, worker authentication, turn/tool routing, transcript and cancellation. Retain existing authorization and expiration checks and worker URLs through migration. An extension route under `/api/x/…` is behind the portal login and cannot silently replace worker ingress. Provide a supported host interface before moving this implementation; do not expose credentials, direct session internals or a new unauthenticated route to the browser half.

The full and mini orb, text and waveform levels stay on the existing `VoiceControl` / `MiniCpmDuplexControl` path with a single room across view switches. Electron's native overlay continues to consume its existing desktop bridge. Computer use belongs in Electron; this scaffold adds none to the portal.

## Legacy settings and engine identity

`src/contracts.ts` describes the minimum shape of the existing voice settings and backend extraction. It does not read, write or migrate them. The `breezeUrl` name is historical: it may point to an audio-cpp-compatible OmniVoice or VoxCPM endpoint, so the endpoint must never be assumed to run Breeze. Read the saved `voice` record, preset identities, reference audio and service bearer credential through trusted server-side facilities. Never send keys or reference audio to the renderer. Preserve preset IDs, per-agent selections, instructions, language and any unlisted existing settings. A future migration must copy and verify data, be idempotent and retain the original until compatibility and rollback are verified on copied databases.

For the legacy audio-cpp/OmniVoice path, list registry names from the selected backend using the existing authenticated `/api/voice/engines` behavior; map existing preset IDs to matching registry names and pass the selected name in synthesis requests. A registry-only name must be accepted only for that backend, without changing Breeze, Chatterbox or Kokoro validation. Do not silently substitute a different speaker when a saved voice is missing. Upstream Voice's `settings.json`, preset-only validation and Breeze request builder do not provide this behavior. The extension settings page must not advertise registry voices until the backend and settings migration support them.

## Provider adapter work still required

Pithagoras `VoiceProvider` has bounded WAV transcription and phrase-based 24 kHz PCM/WAV synthesis; it does not represent LiveKit, style metadata, session-level tools or the full orb. Extract the existing Yulify recognition and engine-specific synthesis into shared server services first. A future `yulify-voice` extension can then register a provider only when the actual configured backend is available, with explicit source selection and lifecycle. Preserve 409 handling, cancellation and the user's existing voice rules, including styles and reference voices. Validate actual media format and rate. An audio-cpp stream at 48 kHz requires proper streaming anti-alias resampling before presenting it as 24 kHz; do not relabel it. A converter prototype exists separately in the isolated migration worktree; it is not installed or used by this scaffold.

Existing LiveKit workers synthesize through their own current path; a phrase provider does not replace that path. Room and Pi behavior must remain intact while a provider adapter is developed. This scaffold has no end-to-end verification; none of its interfaces assert deployed compatibility.
