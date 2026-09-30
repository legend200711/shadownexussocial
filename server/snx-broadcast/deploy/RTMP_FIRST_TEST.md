# First RTMP Broadcast Test — Procedure
## Stage 4C — Controlled Test Protocol

> **Do NOT perform this test until a real VPS is running and verified.**
> This document defines the exact order of operations for the first
> controlled external broadcast test.

---

## Pre-conditions (all must be true before starting)

- [ ] snx-broadcast service is `active` on the VPS
- [ ] `bash verify.sh` reports all PASS (NODE, FFMPEG, LIBX264, AAC, FLV, TEE, SERVICE, HEALTH)
- [ ] Cloudflare Tunnel is connected and `curl https://<hostname>/broadcast/health` returns `200`
- [ ] Radio is running and playing (confirm in the Shadow Nexus browser client)
- [ ] At least one RTMP destination is configured in Firestore (Broadcast Studio → BROADCAST tab)
- [ ] The test destination is set to **private** or **unlisted** where the platform supports it
- [ ] No production broadcast is currently running

---

## Test Procedure

### Phase 1 — Pre-broadcast confirmation

1. Confirm Radio is live in the browser:
   - Track is advancing normally
   - No errors in the Radio UI

2. Confirm broadcast service health:
   ```bash
   curl https://<YOUR-BROADCAST-HOSTNAME>/broadcast/health
   # Expected:
   # {
   #   "ok": true,
   #   "engineState": "idle",
   #   "ffmpeg": "available v...",
   #   ...
   # }
   ```

3. Confirm at least one destination is enabled (Broadcast Studio):
   - Navigate to Shadow Nexus Studio → BROADCAST tab
   - Verify destination appears with `enabled: true`
   - Use a private/unlisted stream for this first test

---

### Phase 2 — Start the broadcast

4. From the Shadow Nexus Broadcast Studio, click **START BROADCAST**
   (or POST to `/broadcast/start` via the Founder control path)

5. Immediately check the VPS logs:
   ```bash
   sudo journalctl -fu snx-broadcast
   ```
   Expected log lines (within 5–10 seconds):
   ```
   [BROADCAST-MGR]  Starting broadcast…
   [ENCODER]        Spawning FFmpeg pid=<N>
   [BROADCAST-MGR]  engineState → LIVE
   ```

6. Verify FFmpeg is running:
   ```bash
   pgrep -a ffmpeg
   # Should show an ffmpeg process with RTMP destination args
   ```
   > The process arguments include stream keys — do NOT log, screenshot, or
   > share the output of this command.

---

### Phase 3 — Verify video and audio arriving

7. Open the destination platform's live monitor:
   - **YouTube:** Studio → Go Live → Stream health
   - **Twitch:** Dashboard → Stream Manager → Stream Health
   - **Other:** Platform-specific preview

8. Confirm:
   - [ ] Video is arriving (green signal / stream preview shows)
   - [ ] Audio is present (audio meters active)
   - [ ] Resolution shows 1280×720
   - [ ] Bitrate is approximately 2500–2700 kbps (video + audio)

9. Confirm Now Playing / artwork overlay is visible in the stream preview

---

### Phase 4 — Sustain test (5–10 minutes)

10. Let the broadcast run for at least one full track transition:
    - The next track should begin without the broadcast stopping
    - The FFmpeg process should restart automatically per-track
    - The RTMP connection should reconnect cleanly (< 1 second gap)

11. Monitor VPS resources during the test:
    ```bash
    # CPU and memory — should be stable, not climbing
    top -bn3 | grep -E "(Cpu|Mem|ffmpeg)"
    ```
    Expected: ~50–100% of one CPU core for libx264 at `veryfast` preset.

12. Confirm the browser Radio experience is unchanged:
    - Open Shadow Nexus in the browser
    - Confirm Radio is still playing for listeners
    - The broadcast runs independently — it must not affect Radio playback

---

### Phase 5 — Stop the broadcast

13. From the Broadcast Studio, click **STOP BROADCAST**
    (or POST to `/broadcast/stop`)

14. Verify FFmpeg has exited:
    ```bash
    pgrep ffmpeg
    # Should return nothing (no ffmpeg processes running)
    ```

15. Verify broadcast service health shows `idle`:
    ```bash
    curl https://<YOUR-BROADCAST-HOSTNAME>/broadcast/health
    # "engineState": "idle"
    ```

16. Verify the destination platform shows the stream as ended.

---

### Phase 6 — Post-test verification

17. Confirm Radio is still running normally (no interruption to listeners).

18. Review VPS logs for any errors or warnings:
    ```bash
    sudo journalctl -u snx-broadcast --since "30 minutes ago" | grep -E "(ERROR|WARN|fatal)"
    ```

19. Record test results:

| Check | Result |
|-------|--------|
| FFmpeg started cleanly | PASS / FAIL |
| Video arriving at destination | PASS / FAIL |
| Audio arriving at destination | PASS / FAIL |
| Track transition without broadcast stop | PASS / FAIL |
| 5–10 minute sustain | PASS / FAIL |
| Clean stop (FFmpeg exited) | PASS / FAIL |
| Radio unaffected throughout | PASS / FAIL |

---

## Rollback / abort procedure

If the broadcast hangs, FFmpeg crashes in a loop, or the destination
goes into error state:

```bash
# Emergency stop — from VPS directly
sudo systemctl stop snx-broadcast

# Verify FFmpeg is gone
pgrep ffmpeg   # should be empty

# Restart the service (control API only — does NOT restart broadcast)
sudo systemctl start snx-broadcast

# Verify health
curl http://127.0.0.1:3100/broadcast/health
```

The Radio service is completely independent.  Stopping snx-broadcast
will never affect Radio playback.

---

## Important constraints

- **DO NOT** perform this test before a real VPS is provisioned and verified.
- **DO NOT** use a production/public live stream destination for the first test.
- **DO NOT** start the broadcast automatically on VPS reboot — always require
  an explicit Founder action via the Broadcast Studio.
- The stream key appears in FFmpeg process arguments on Linux.
  Do not run `ps aux`, `pgrep -a`, or similar in shared/logged environments
  during a live broadcast.

---

## Status

```
continuousEncoderHost = NOT_CURRENTLY_PROVISIONED
First RTMP test       = NOT PERFORMED
```
