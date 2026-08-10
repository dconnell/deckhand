# Presenter Phase 3 Findings

## Scope

This spike validates the current whisper.cpp toolchain enough to decide whether
voice follow can proceed to a production tracking state machine.

## Environment used

- `whisper-cli`: `/opt/homebrew/bin/whisper-cli`
- production model: `/Users/dconnell/repos/deckhand/models/ggml-large-v3-turbo.bin`
- packaged sanity model: `/opt/homebrew/Cellar/whisper-cpp/1.9.2/share/whisper-cpp/for-tests-ggml-tiny.bin`
- sample audio: `/opt/homebrew/Cellar/whisper-cpp/1.9.2/share/whisper-cpp/jfk.wav`

## Commands run

```bash
/opt/homebrew/bin/whisper-cli \
  -m /Users/dconnell/repos/deckhand/models/ggml-large-v3-turbo.bin \
  -f /opt/homebrew/Cellar/whisper-cpp/1.9.2/share/whisper-cpp/jfk.wav \
  -l en -nt -np
```

## Result

- The local whisper.cpp binary is installed and runnable.
- The downloaded `ggml-large-v3-turbo.bin` model is present locally and runs
  successfully through `whisper-cli`.
- All sample `presentation/*/config.local.json` files now point at the real
  `whisper-cli` binary and local model path, so `presenter:doctor` validates the
  STT setup for the shipped presentations.
- The packaged `jfk.wav` sample transcribed successfully with the real model.

## Decision

- Decision: proceed with Phase 4.
- Rationale: the machine-level whisper toolchain is now validated enough to
  justify shipping the coordinator-side tracking state machine.
- Remaining limitation: this spike still used packaged sample audio rather than
  a full four-scenario recorded rehearsal, so the exact follow thresholds should
  still be tuned against a real presentation capture before further refinement.

## Proposed defaults

- `offScriptMs`: `3000`
- `lostMs`: `8000`
- `minConfidence`: `0.35`

## Follow-up

- Record one full scripted rehearsal capture and write the transcript stream to a
  file.
- Re-run the offline matcher analysis against that transcript before tuning
  thresholds further.
