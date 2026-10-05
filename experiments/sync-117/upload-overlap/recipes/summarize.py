#!/usr/bin/env python3
"""Recompute the fixed acceptance rule from every retained native sample."""
import argparse
import json
from pathlib import Path
import statistics

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("evidence", type=Path)
args = parser.parse_args()
rows = []
for directory in sorted(args.evidence.glob("[1-6]-*")):
    result = json.loads((directory / "overlap.json").read_text())
    cleanup = json.loads((directory / "final-cleanup.json").read_text())
    assert result["result"] == "SCENARIO_PASS" and result["hooksRemoved"]
    assert result["serverStorageSentinelScan"]["passed"]
    assert cleanup["result"] == "PASS"
    assert all(cleanup[key] for key in ("privateAbsent", "runtimeAbsent", "manifestAbsent"))
    assert all(row["persistedIdentitiesAgree"] for row in result["samples"])
    rows.append({"sample": int(directory.name[0]), "arm": directory.name[2:],
                 "phases": {row["scenario"]: row for row in result["samples"]}})
assert [row["sample"] for row in rows] == [1, 2, 3, 4, 5, 6]
pairs = []
for index in range(0, 6, 2):
    baseline, candidate = sorted(rows[index:index + 2], key=lambda row: row["arm"])
    ratios = {scenario: {metric: candidate["phases"][scenario][metric] /
                         baseline["phases"][scenario][metric]
                         for metric in ("senderAckMs", "peerCommitMs")}
              for scenario in ("small-notes", "large-file")}
    same = {scenario: all(
        {key: (value["requests"], value["bytes"]) for key, value in
         baseline["phases"][scenario]["requests"][peer].items()} ==
        {key: (value["requests"], value["bytes"]) for key, value in
         candidate["phases"][scenario]["requests"][peer].items()}
        for peer in ("A", "B")) for scenario in ("small-notes", "large-file")}
    pairs.append({"baselineSample": baseline["sample"], "candidateSample": candidate["sample"],
                  "ratios": ratios, "sameRequestsAndBodyBytes": same})

def median(scenario, metric):
    return statistics.median(pair["ratios"][scenario][metric] for pair in pairs)

criteria = {
    "allLargeSenderRatiosBelowOne": all(pair["ratios"]["large-file"]["senderAckMs"] < 1 for pair in pairs),
    "medianLargeSenderRatioAtMostPoint95": median("large-file", "senderAckMs") <= .95,
    "medianSmallSenderRatioAtMost1Point05": median("small-notes", "senderAckMs") <= 1.05,
    "medianLargePeerRatioAtMost1Point05": median("large-file", "peerCommitMs") <= 1.05,
    "requestAndBodyByteCountsEqual": all(all(pair["sameRequestsAndBodyBytes"].values()) for pair in pairs),
}
result = {"pairs": pairs, "criteria": criteria, "decision": "ACCEPT" if all(criteria.values()) else "REJECT",
          "medianRatios": {scenario: {metric: median(scenario, metric) for metric in
                          ("senderAckMs", "peerCommitMs")} for scenario in ("small-notes", "large-file")},
          "rows": rows}
print(json.dumps(result, indent=2))
