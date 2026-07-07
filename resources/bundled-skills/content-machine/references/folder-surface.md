# Content Machine Folder Surface

The setup command creates:

```text
content/content-machine/
  00_intake/
  01_source_inventory/
  02_vault/
  03_research/
  04_founder_interviews/
  05_raw_briefs/
  06_anchor_drafts/
  07_council_reviews/
  08_derivatives/
  09_release_packets/
  10_performance/
  11_lessons/
  RUNBOOK.md
  content-machine.config.json
```

Setup command (dry-run first):

```bash
node scripts/content/content-machine-start.mjs \
  --root ${CLIENT_ROOT} \
  --company "Client Name" \
  --approval-owner "Founder" \
  --write
```
