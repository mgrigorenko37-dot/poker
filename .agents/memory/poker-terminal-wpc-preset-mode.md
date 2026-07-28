---
name: Poker Terminal WPC preset mode
description: Why World Poker Club needs prefer_preset_regions=true and how it propagates
---

## Rule
WPC preset coordinates must be the PRIMARY source, not a fallback.
Set `prefer_preset_regions: true` in game profile and preset JSON.

**Why:** `compute_regions()` in `table_detector.py` uses Ton Poker layout
proportions. WPC has a different table aspect and card positions (hole cards
at cx≈0.43/0.50 vs Ton Poker's 0.46/0.52, hero slightly left of center).
When HSV detects the WPC table, compute_regions() returns wrong coordinates.
The preset coordinates are correct; the old code used them only as fallback,
so detection sometimes gave bad coords instead of good ones.

**How to apply:**
- `prefer_preset_regions: true` in `GAME_PROFILES` entry (auto.py)
- Same flag in `world_poker_club_desktop_6max.json`
- `poker_scanner.py` checks `cfg.get("prefer_preset_regions")`:
  - True → uses manual_regions always; calls get_table_state() only for bbox height
  - No table_miss warnings (HSV miss is expected and normal in this mode)
- `auto.py` ensure_config() propagates flag to config.json on preset apply
- `load_preset.py` also copies `prefer_preset_regions` and `seat_regions` from preset

## What still needs calibration on user's machine
- Preset measured at 1024×576; other resolutions need `calibrate.py` Faza 1+2
- `bet` money region is an estimate (x1=0.36,y1=0.83,x2=0.52,y2=0.89) — calibrate via Faza 2
- WPC templates must be re-collected with `collect_templates.py` (different card art)
- Seat regions are estimates; active-player count falls back to config `players` if wrong
