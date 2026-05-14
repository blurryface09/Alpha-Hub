# Alpha Intake UAT Checklist

## Goal

Verify Alpha Hub can turn weak alpha links into reviewed MintGuard projects without pretending incomplete data is mint-ready.

## Intake Tests

1. Paste an OpenSea collection, drop, or mint URL.
   - Expected: backend detection runs through `/api/intelligence/detect-project`.
   - Expected: project name and source are shown when page metadata is available.
   - Expected: missing contract, time, phase, or mint URL are listed clearly.
   - Expected: low-confidence OpenSea results show `Needs review`, not `Live now`.

2. Paste an official mint website.
   - Expected: title, image, contract if present, price if present, and detected date text if present appear in the review step.
   - Expected: if time cannot be detected, copy says `Could not detect launch time. Paste official mint link or enter manually.`

3. Paste plain alpha text or an X link.
   - Expected: project is allowed through as `Needs review`.
   - Expected: user can manually add missing fields under `Advanced edit`.

## Status Logic

1. Upcoming:
   - Requires a future mint start time.

2. Live now:
   - Requires a confirmed mint time/source.
   - Recent NFT activity alone must not mark a project live.

3. Ended:
   - Requires passed end time or source text saying ended/sold out/closed.

4. Needs review:
   - Used when contract, time, phase, or mint source is missing.

5. TBA:
   - Used only when the official source says the date/time is TBA.

## MintGuard Save

1. Review detected fields.
2. Edit project name, chain, phase, and time if needed.
3. Save to My Mints.
4. Expected: project appears in MintGuard for the current user only.

## Strike Eligibility

Strike Mode should stay unavailable until:

- contract address exists
- mint time exists or user explicitly intends immediate execution
- mint URL/source exists
- Alpha Vault exists

If missing, UI must show:

- `Add contract address before Strike`
- `Add mint time before Strike`
- `Add mint URL before Strike`

## Performance

- Alpha Radar and Add Alpha detection must not import new wallet execution bundles.
- Heavy mint/wallet execution remains behind mint actions.
- Mobile add flow should show the review step quickly after detection or controlled failure.
