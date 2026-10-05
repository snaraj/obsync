"""Recompute the frozen paired acceptance rule, preserving every sample."""
import json, statistics, sys
from pathlib import Path
root=Path(sys.argv[1]); order=['1-baseline','2-candidate','3-candidate','4-baseline','5-baseline','6-candidate']
data={name:json.loads((root/name/'evidence/batch.json').read_text()) for name in order}
assert all(d['result']=='SCENARIO_PASS' and d['hooksRemoved'] for d in data.values())
summary=[]; request_differences=[]
for baseline,candidate in [(order[0],order[1]),(order[3],order[2]),(order[4],order[5])]:
 b={s['scenario']:s for s in data[baseline]['samples']};c={s['scenario']:s for s in data[candidate]['samples']}
 assert b.keys()==c.keys()
 for scenario in b:
  assert b[scenario]['exactFilesEach']==c[scenario]['exactFilesEach']
  assert b[scenario]['exactBytesEach']==c[scenario]['exactBytesEach']
  for peer in ['A','B']:
   counts=lambda s:{k:{field:v[field] for field in ['requests','bytes']} for k,v in s['requests'][peer].items()}
   if counts(b[scenario])!=counts(c[scenario]): request_differences.append({'baseline':baseline,'candidate':candidate,'scenario':scenario,'peer':peer,'before':counts(b[scenario]),'after':counts(c[scenario])})
 ratios={scenario:{key:c[scenario][key]/b[scenario][key] for key in ['senderAckMs','peerCommitMs']} for scenario in ['small-notes','large-file']}
 singles={}
 for key in ['senderAckMs','peerCommitMs']:
  bs=sorted(s[key] for n,s in b.items() if n.startswith('single-'));cs=sorted(s[key] for n,s in c.items() if n.startswith('single-'))
  singles[key]={'baselineP50':statistics.median(bs),'candidateP50':statistics.median(cs),'baselineP95':bs[-1],'candidateP95':cs[-1],'pass':cs[-1]<=bs[-1]+max(20,bs[-1]*.05)}
 summary.append({'baseline':baseline,'candidate':candidate,'ratios':ratios,'singles':singles})
median={scenario:{key:statistics.median(s['ratios'][scenario][key] for s in summary) for key in ['senderAckMs','peerCommitMs']} for scenario in ['small-notes','large-file']}
accepted=(median['small-notes']['senderAckMs']<=.95 and all(s['ratios']['small-notes']['senderAckMs']<1 for s in summary)
 and median['small-notes']['peerCommitMs']<=1.05 and all(v<=1.05 for v in median['large-file'].values())
 and all(v['pass'] for s in summary for v in s['singles'].values()))
print(json.dumps({'accepted':accepted,'decision':'KEEP' if accepted else 'REJECT','requestCountsAndBytesMatched':not request_differences,'requestDifferences':request_differences,'medianRatios':median,'pairs':summary},indent=2))
