<!--
  client-report template — fill from the ACTIVE SEAT's truth ONLY.
  Replace every {{TOKEN}} with content drawn from THIS seat's Company-Brain seed,
  MEMORY, and workspace artifacts. Do not read across seats or a global profile.
  Brand slots ({{OPERATOR_*}}) are the OPERATOR's brand — never Command EVE / EVE / Hermes.
  Mark any metric not recorded in this seat as `unknown`; never invent a number.
  Output: write the filled result as report.md (and/or report.html) into the seat workspace.
-->

<!-- ===== BRAND HEADER (operator brand slot — RPT-3 / export fills this) ===== -->
<!-- {{OPERATOR_LOGO}} -->
**{{OPERATOR_NAME}}**

# {{REPORT_TITLE}}
**Client:** {{CLIENT_NAME}}  ·  **Period:** {{PERIOD}}  ·  **Prepared:** {{REPORT_DATE}}

---

## Executive summary
{{EXEC_SUMMARY}}
<!-- 3–6 sentences, bottom line up front: situation, the single most important finding,
     the headline recommendation. Readable on its own. -->

## Situation & context
{{SITUATION}}
<!-- Where the client is now — from THIS seat's Company-Brain seed + MEMORY. Their business,
     market, and the goal this period's work served. -->

## What was done this period
{{WORK_PERFORMED}}
<!-- The work actually performed in THIS seat, each item cited to the seat artifact that
     produced it. Omit anything not done in this seat. e.g.
     - {{WORK_ITEM}} — source: {{SEAT_ARTIFACT}} -->

## Findings & results
{{FINDINGS}}

### Results / KPIs
| Metric | Value | Source (seat artifact) | Grade |
|---|---|---|---|
| {{KPI_NAME}} | {{KPI_VALUE_OR_UNKNOWN}} | {{KPI_SOURCE}} | {{FACT_INFERENCE_HYPOTHESIS}} |
<!-- Every value traceable to a seat source. Not recorded in this seat? -> `unknown`, never invented.
     Vendor/projected figure? -> flag it as a projection, not a measured result. -->

## Recommendations
{{RECOMMENDATIONS}}
<!-- Decisive next moves — a recommendation, not a menu. Real fork? name the default + the one
     switching condition. -->

## Next steps
{{NEXT_STEPS}}
<!-- Concrete actions for the coming period; owner and sequence clear. -->

## Honest residual
{{RESIDUAL}}
<!-- The risk that remains even with flawless execution, plus what is still unknown / unmeasured.
     Honesty over smoothing. No autonomy or "learning" claim. -->

---

<!-- ===== BRAND FOOTER (operator brand slot — operator brand only) ===== -->
*{{OPERATOR_NAME}} · {{OPERATOR_CONTACT}} · {{OPERATOR_FOOTER}}*
<!-- Operator brand only. Never name Command EVE / EVE / Hermes / the model / "AI agent". -->
