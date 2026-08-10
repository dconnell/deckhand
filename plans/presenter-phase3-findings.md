# Presenter Phase 3 Findings

## Scope

This spike validates the current whisper.cpp toolchain enough to decide whether
voice follow can proceed to a production tracking state machine.

## Environment used

- `whisper-cli`: `/opt/homebrew/bin/whisper-cli`
- test model: `/opt/homebrew/Cellar/whisper-cpp/1.9.2/share/whisper-cpp/for-tests-ggml-tiny.bin`
- sample audio: `/opt/homebrew/Cellar/whisper-cpp/1.9.2/share/whisper-cpp/jfk.wav`

## Commands run

```bash
/opt/homebrew/bin/whisper-cli \
  -m /opt/homebrew/Cellar/whisper-cpp/1.9.2/share/whisper-cpp/for-tests-ggml-tiny.bin \
  -f /opt/homebrew/Cellar/whisper-cpp/1.9.2/share/whisper-cpp/jfk.wav \
  -l en -nt -np
```

## Result

- The local whisper.cpp binary is installed and runnable.
- The Homebrew package includes a tiny bundled model and sample audio, so the
  basic inference path is working on this machine.
- The current repo integration path still needs a real presentation-local model
  path in `config.local.json` before `npm run presenter:stt -- <presentation>`
  can be used for live rehearsal captures.

## Decision

- Decision: proceed with Phase 4.
- Rationale: the machine-level whisper toolchain is now validated enough to
  justify shipping the coordinator-side tracking state machine.
- Limitation: this spike did not yet capture the exact four-scenario scripted
  rehearsal described in `plans/presenter.md` because the repo does not yet have
  a checked-in or local presentation config pointing at a real Whisper model
  path for sustained session capture.

## Proposed defaults

- `offScriptMs`: `3000`
- `lostMs`: `8000`
- `minConfidence`: `0.35`

## Follow-up

- Add a real Whisper model path in the active presentation's `config.local.json`.
- Record one full scripted rehearsal capture and write the transcript stream to a
  file.
- Re-run the offline matcher analysis against that transcript before tuning
  thresholds further.
